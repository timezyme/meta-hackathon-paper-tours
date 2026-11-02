import { Clock, Crypto, DateTime, Effect, Schema } from "effect"
import {
  CanonicalDocument, ImageManifest, MastraRunId, OutputRevisionId, ProcessingReport, RunId, matchesStoredReceipt, validatePublication,
  type BlockId, type DocumentId, type Run, type StageReceipt, type UserId,
} from "../domain/index.ts"
import { extractionFromCanonical, pageExtractionPromptVersion, validatePageExtraction } from "../paper/extraction/page.ts"
import { verifySavedGuide } from "../paper/guide/evidence.ts"
import { decodeMetaOutput } from "../paper/providers/meta/contracts.ts"
import { reclassifyCode, savedCodeBlockIds } from "../paper/reading/code-repair.ts"
import { exportDocument } from "../paper/reading/export.ts"
import { ArtifactStore, DocumentStore, OutputStore, StorageDatabase, type ProviderAttemptRow } from "../storage/index.ts"
import { storageConflict } from "../storage/service.ts"
import { savedAttempt } from "./recovery.ts"

const fail = (message: string) => storageConflict("code-repair", message)
const completed = (run: Run) => run.state._tag === "succeeded" || run.state._tag === "succeeded-with-issues"
const acceptedEvidence = (saved: ProviderAttemptRow | undefined, receipt: StageReceipt): saved is ProviderAttemptRow =>
  saved !== undefined && matchesStoredReceipt(saved.receipt_json, receipt) && saved.response_json !== null
  && saved.status === "completed" && saved.validation_state === "accepted"
  && receipt.state._tag === "completed" && receipt.state.validation._tag === "accepted"
const metaPageExtraction = (receipt: StageReceipt) => receipt.stage === "extraction" && receipt.configuration._tag === "extraction"
  && receipt.configuration.provider === "meta" && receipt.configuration.model?.promptVersion === pageExtractionPromptVersion

const readSavedPublication = Effect.fnUntraced(function* (owner: UserId, documentId: DocumentId, revisionId: OutputRevisionId) {
  const outputs = yield* OutputStore
  const manifest = yield* outputs.manifest(owner, documentId, revisionId)
  const files = new Map<string, Uint8Array>()
  for (const entry of manifest.entries) files.set(entry.path, (yield* outputs.read(owner, documentId, revisionId, entry.path)).bytes)
  const readJson = <A>(name: string, schema: Schema.Codec<A, unknown>) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(files.get(name)))
      .pipe(Effect.mapError(() => fail(`Invalid saved ${name}`)))
  return {
    manifest,
    canonical: yield* readJson("document.json", CanonicalDocument),
    images: yield* readJson("images.json", ImageManifest),
    report: yield* readJson("processing-report.json", ProcessingReport),
  }
})

const verifiedCodeBlockIds = Effect.fnUntraced(function* (owner: UserId, documentId: DocumentId, canonical: CanonicalDocument, report: ProcessingReport) {
  const database = yield* StorageDatabase
  const ids: Array<BlockId> = []
  for (const { receipt } of report.receipts) {
    const saved = yield* database.query("repair-receipt", () => database.db.selectFrom("provider_attempts").selectAll()
      .where("id", "=", receipt.id).where("owner_id", "=", owner).where("document_id", "=", documentId).executeTakeFirst())
    if (!acceptedEvidence(saved, receipt)) return yield* fail("Repair requires unchanged accepted provider evidence")
    const { response } = yield* savedAttempt(saved)
    if (response === null) return yield* fail("Saved provider response is missing")
    if (receipt.id === canonical.guide?.providerAttemptId) yield* verifySavedGuide(canonical, receipt, response)
    if (!metaPageExtraction(receipt)) continue
    const page = canonical.pages.find((candidate) => receipt.pageIds.length === 1 && candidate.id === receipt.pageIds[0])
    if (page === undefined) return yield* fail("Extraction receipt must identify one source page")
    const extraction = yield* Effect.fromResult(validatePageExtraction(page, yield* decodeMetaOutput(response)))
    ids.push(...yield* Effect.fromResult(savedCodeBlockIds(canonical, page, extraction)))
  }
  return ids
})

export const repairCodeOutput = Effect.fn("repairCodeOutput")(function* (
  owner: UserId, documentId: DocumentId, previousRevisionId: OutputRevisionId, apply: boolean,
) {
  const documents = yield* DocumentStore
  const outputs = yield* OutputStore
  const artifacts = yield* ArtifactStore
  const database = yield* StorageDatabase
  const crypto = yield* Crypto.Crypto
  const { document, latestRun, currentRevisionId } = yield* documents.detail(owner, documentId)
  if (currentRevisionId !== previousRevisionId || !completed(latestRun)) return yield* fail("Repair requires the latest completed revision")
  const active = yield* database.query("repair-idle", () => database.db.selectFrom("runs").select("id")
    .where("state", "in", ["queued", "running"]).executeTakeFirst())
  if (active !== undefined) return yield* fail("Finish queued and running work before repairing code labels")
  const { manifest, canonical, images, report } = yield* readSavedPublication(owner, documentId, previousRevisionId)
  const extraction = extractionFromCanonical(canonical, documentId, latestRun.id)
  const previousViolations = validatePublication({ document, run: latestRun, extraction, canonical, images, report, manifest })
  if (previousViolations.length > 0) return yield* fail("The previous publication is invalid")
  const codeIds = yield* verifiedCodeBlockIds(owner, documentId, canonical, report)
  const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
  const id = RunId.make(yield* crypto.randomUUIDv4())
  const scope = { documentId, runId: id, revisionId: OutputRevisionId.make(id) }
  const assembled = yield* Effect.fromResult(reclassifyCode(canonical, images, report, scope, codeIds))
  const assets = canonical.figures.flatMap((figure) => figure.asset._tag === "available" ? [figure.asset.artifact] : [])
  const imageBytes = yield* Effect.forEach(assets, (artifact) =>
    artifacts.read(owner, documentId, { hash: artifact.hash, byteCount: artifact.byteCount }).pipe(Effect.map((bytes) => ({ artifact, bytes }))))
  const exported = yield* exportDocument(assembled, imageBytes)
  const run: Run = {
    ...latestRun, id, createdAt: at, mastraRunId: MastraRunId.make(`local-code-repair-${id}`),
    state: { _tag: assembled.report.issues.length === 0 ? "succeeded" : "succeeded-with-issues", startedAt: at, finishedAt: at, revisionId: scope.revisionId },
  }
  if (validatePublication({ document, run, ...exported.publication }).length > 0) return yield* fail("The repaired publication is invalid")
  const summary = {
    documentId, previousRevisionId, blockIds: codeIds, issuesBefore: report.issues.length, issuesAfter: assembled.report.issues.length,
    newProviderCalls: 0, applied: apply, revisionId: apply ? scope.revisionId : null,
  }
  if (!apply) return summary
  for (const file of exported.files) {
    const stored = yield* artifacts.put(owner, documentId, file.bytes)
    if (stored.hash !== file.entry.hash || stored.byteCount !== file.entry.byteCount) return yield* fail("Repaired export storage mismatch")
  }
  yield* outputs.publishRepair({ ownerId: owner, documentId, replacedRunId: latestRun.id }, run, exported.publication)
  return summary
})
