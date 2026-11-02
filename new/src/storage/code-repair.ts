import { Clock, Crypto, DateTime, Effect, Schema } from "effect"
import { CanonicalDocument, ImageManifest, MastraRunId, OutputRevisionId, ProcessingReport, Run, RunId, validatePublication, type BlockId, type DocumentId, type UserId } from "../domain/index.ts"
import { validatePageExtraction } from "../paper/extraction/page.ts"
import { verifySavedGuide } from "../paper/guide/evidence.ts"
import { decodeMetaOutput } from "../paper/providers/meta/contracts.ts"
import { reclassifyCode } from "../paper/reading/code-repair.ts"
import { exportDocument } from "../paper/reading/export.ts"
import { savedAttempt } from "../processing/recovery.ts"
import { ArtifactStore } from "./artifacts.ts"
import { StorageDatabase } from "./database.ts"
import { OutputStore } from "./outputs.ts"
import { DocumentStore, storageConflict } from "./service.ts"

const fail = (message: string) => storageConflict("code-repair", message)

export const repairCodeOutput = Effect.fn("repairCodeOutput")(function* (owner: UserId, documentId: DocumentId, previousRevisionId: OutputRevisionId, apply: boolean) {
  const documents = yield* DocumentStore
  const outputs = yield* OutputStore
  const artifacts = yield* ArtifactStore
  const database = yield* StorageDatabase
  const crypto = yield* Crypto.Crypto
  const { document, latestRun, currentRevisionId } = yield* documents.detail(owner, documentId)
  if (currentRevisionId !== previousRevisionId || (latestRun.state._tag !== "succeeded" && latestRun.state._tag !== "succeeded-with-issues")) return yield* fail("Repair requires the latest completed revision")
  const active = yield* database.query("repair-idle", () => database.db.selectFrom("runs").select("id").where("state", "in", ["queued", "running"]).executeTakeFirst())
  if (active !== undefined) return yield* fail("Finish queued and running work before repairing code labels")
  const manifest = yield* outputs.manifest(owner, documentId, previousRevisionId)
  const files = yield* Effect.forEach(manifest.entries, (entry) => outputs.read(owner, documentId, previousRevisionId, entry.path).pipe(Effect.map((file) => ({ ...file, path: entry.path }))))
  const readJson = <A>(name: string, schema: Schema.Codec<A, unknown>) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(files.find((file) => file.path === name)?.bytes)).pipe(Effect.mapError(() => fail(`Invalid saved ${name}`)))
  const canonical = yield* readJson("document.json", CanonicalDocument)
  const images = yield* readJson("images.json", ImageManifest)
  const report = yield* readJson("processing-report.json", ProcessingReport)
  const originalExtraction = { schemaVersion: "1" as const, scope: { documentId, runId: latestRun.id, sourceHash: canonical.sourceHash }, pages: canonical.pages, sourceBlocks: canonical.sourceBlocks, figures: canonical.figures, ...(canonical.pageFurniture === undefined ? {} : { pageFurniture: canonical.pageFurniture }) }
  if (validatePublication({ document, run: latestRun, extraction: originalExtraction, canonical, images, report, manifest }).length > 0) return yield* fail("The previous publication is invalid")
  const codeIds: Array<BlockId> = []
  for (const { receipt } of report.receipts) {
    const saved = yield* database.query("repair-receipt", () => database.db.selectFrom("provider_attempts").selectAll().where("id", "=", receipt.id).where("owner_id", "=", owner).where("document_id", "=", documentId).executeTakeFirst())
    if (saved?.receipt_json !== JSON.stringify(receipt) || saved.response_json === null || saved.status !== "completed" || saved.validation_state !== "accepted" || receipt.state._tag !== "completed" || receipt.state.validation._tag !== "accepted") return yield* fail("Repair requires unchanged accepted provider evidence")
    const { response } = yield* savedAttempt(saved)
    if (response === null) return yield* fail("Saved provider response is missing")
    if (receipt.id === canonical.guide?.providerAttemptId) yield* verifySavedGuide(canonical, receipt, response)
    if (receipt.stage !== "extraction" || receipt.configuration._tag !== "extraction" || receipt.configuration.model?.promptVersion !== "2" || receipt.configuration.provider !== "meta") continue
    const page = canonical.pages.find((candidate) => receipt.pageIds.length === 1 && candidate.id === receipt.pageIds[0])
    if (page === undefined) return yield* fail("Extraction receipt must identify one source page")
    const native = yield* Effect.fromResult(validatePageExtraction(page, yield* decodeMetaOutput(response)))
    for (const [index, block] of native.blocks.entries()) {
      if (block.kind !== "code" || block.furniture !== null) continue
      const source = canonical.sourceBlocks.find((candidate) => candidate.id === `page-${page.pageNumber}-block-${index + 1}`)
      if (source?.kind === "unclassified") {
        if (source.content !== block.content || source.format !== block.format || source.locations.length !== 1 || source.locations[0].pageId !== page.id) return yield* fail("Saved code differs from its original extraction response")
        codeIds.push(source.id)
      }
    }
  }
  const now = yield* Clock.currentTimeMillis
  const at = DateTime.formatIso(DateTime.makeUnsafe(now))
  const id = RunId.make(yield* crypto.randomUUIDv4())
  const scope = { documentId, runId: id, revisionId: OutputRevisionId.make(id) }
  const assembled = yield* Effect.fromResult(reclassifyCode(canonical, images, report, scope, codeIds))
  const assets = canonical.figures.flatMap((figure) => figure.asset._tag === "available" ? [figure.asset.artifact] : [])
  const imageBytes = yield* Effect.forEach(assets, (artifact) => artifacts.read(owner, documentId, { hash: artifact.hash, byteCount: artifact.byteCount }).pipe(Effect.map((bytes) => ({ artifact, bytes }))))
  const exported = yield* exportDocument(assembled, imageBytes)
  const localRunId = MastraRunId.make(`local-code-repair-${id}`)
  const run: Run = { ...latestRun, id, createdAt: at, mastraRunId: localRunId, state: { _tag: assembled.report.issues.length === 0 ? "succeeded" : "succeeded-with-issues", startedAt: at, finishedAt: at, revisionId: scope.revisionId } }
  if (validatePublication({ document, run, ...exported.publication }).length > 0) return yield* fail("The repaired publication is invalid")
  const summary = { documentId, previousRevisionId, blockIds: codeIds, issuesBefore: report.issues.length, issuesAfter: assembled.report.issues.length, newProviderCalls: 0, applied: apply, revisionId: apply ? scope.revisionId : null }
  if (!apply) return summary
  for (const file of exported.files) {
    const stored = yield* artifacts.put(owner, documentId, file.bytes)
    if (stored.hash !== file.entry.hash || stored.byteCount !== file.entry.byteCount) return yield* fail("Repaired export storage mismatch")
  }
  yield* database.transaction((connection) => Effect.gen(function* () {
    const currentTime = yield* Clock.currentTimeMillis
    const current = yield* database.query("repair-fence", () => connection.selectFrom("documents").selectAll().where("id", "=", documentId).where("owner_id", "=", owner).where("lifecycle", "=", "active").where("expires_at", ">", currentTime).where("latest_run_id", "=", latestRun.id).executeTakeFirst())
    if (current === undefined) return yield* fail("Document changed while preparing the repair")
    yield* database.query("repair-run", () => connection.insertInto("runs").values({ id, document_id: documentId, owner_id: owner, state: run.state._tag, mastra_run_id: localRunId, run_json: JSON.stringify(run), created_at: now, claim_token: null, worker_id: null, lease_expires_at: null }).execute())
    yield* database.query("repair-output", () => connection.insertInto("outputs").values({ revision_id: scope.revisionId, document_id: documentId, run_id: id, manifest_json: JSON.stringify(exported.publication.manifest) }).execute())
    yield* database.query("repair-pointer", () => connection.updateTable("documents").set({ latest_run_id: id }).where("id", "=", documentId).where("latest_run_id", "=", latestRun.id).execute())
  }))
  return summary
})
