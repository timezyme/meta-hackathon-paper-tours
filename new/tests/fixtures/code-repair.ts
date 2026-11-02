import { Crypto, Effect, FileSystem, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { ArtifactHash, BlockId, CanonicalDocument, ImageManifest, OutputRevisionId, ProcessingReport, Run, StageReceipt } from "../../src/domain/index.ts"
import { PageExtractionResponse } from "../../src/paper/extraction/page.ts"
import { guideInput } from "../../src/paper/guide/evidence.ts"
import { stableJson } from "../../src/paper/providers/meta/contracts.ts"
import { exportDocument } from "../../src/paper/reading/export.ts"
import { AttemptIntent } from "../../src/processing/contracts.ts"
import { Admission, ArtifactStore, DocumentStore, OutputStore, StorageDatabase, makeArtifactStore, makeOutputStore } from "../../src/storage/index.ts"
import { repairCodeOutput } from "../../src/storage/code-repair.ts"
import { contractFixture, fixtureHash } from "./contracts.ts"
import { owner } from "./published-output.ts"

export const firstCode = "```python\r\nprint(\"α = 12\")\r\n```\r\n"
export const secondCode = "```python\nvalue = 1\nprint(value)\n```"
export const codeIds = [BlockId.make("page-1-block-1"), BlockId.make("page-1-block-3")] as const
export const unknownId = BlockId.make("page-1-block-2")
const model = { provider: "meta", model: "muse-spark-1.3", reasoning: "high", maxOutputTokens: 16384 }

export const codeRepairFixture = () => {
  const base = contractFixture()
  const native = Schema.decodeUnknownSync(PageExtractionResponse)({
    pageNumber: 1, coverage: "complete", blank: false,
    blocks: [
      { kind: "code", format: "markdown", content: firstCode, furniture: null },
      { kind: "unclassified", format: "text", content: "An unidentified source region stays visible.", furniture: null },
      { kind: "code", format: "markdown", content: secondCode, furniture: null },
      { kind: "paragraph", format: "text", content: "This is a synthetic example, not a measured finding.", furniture: null },
      { kind: "figure", format: "text", content: "A single synthetic pixel.", furniture: null },
      { kind: "caption", format: "text", content: "Figure 1. A synthetic pixel.", furniture: null },
    ],
    figures: [{ blockIndex: 4, captionBlockIndices: [5], box: { x: 10, y: 20, width: 1, height: 1 } }],
  })
  const locations = [{ _tag: "page", pageId: "page-1", pageNumber: 1 }]
  const sourceBlocks = native.blocks.map((block, index) => ({ id: `page-1-block-${index + 1}`, kind: block.kind === "code" ? "unclassified" : block.kind, format: block.format, content: block.content, readingOrder: index, locations }))
  const figures = [{
    id: "figure-1", sourceBlockIds: ["page-1-block-5"], captionBlockIds: ["page-1-block-6"], locations,
    originalCaption: "Figure 1. A synthetic pixel.",
    asset: { _tag: "available", artifact: { path: "images/pixel.png", mediaType: "image/png", byteCount: 1, hash: fixtureHash }, provenance: { _tag: "rendered-page-region", recipe: "page-png-integer-crop-1", sourceHash: base.document.sourceHash, pageId: "page-1", pageNumber: 1, pageImageHash: base.canonical.pages[0]!.image.hash, pageWidth: 1224, pageHeight: 1584, box: { coordinateSystem: "rendered-page-top-left-pixels", x: 10, y: 20, width: 1, height: 1 }, width: 1, height: 1 } },
    description: { _tag: "unavailable", reason: "This saved fixture has no generated figure description." },
  }]
  const source = { sourceBlockId: "page-1-block-1", quote: 'print("α = 12")' }
  const limit = { sourceBlockId: "page-1-block-4", quote: "not a measured finding" }
  const guide = {
    title: "Read the saved example", providerAttemptId: "repair-guide-attempt",
    overview: { text: "The example prints a value.", sources: [source] },
    steps: [{ title: "Inspect the code", explanation: { text: "The first code sample prints the stated expression.", sources: [source] } }],
    claims: [{ claim: { text: "The sample contains a print call.", sources: [source] }, support: { text: "The call is present in the source.", strength: "strong", sources: [source] }, limits: [{ text: "This is a synthetic example.", sources: [limit] }] }],
  }
  const canonical = Schema.decodeUnknownSync(CanonicalDocument)({ ...base.canonical, sourceBlocks, blocks: sourceBlocks.map((block) => ({ ...block, sourceBlockIds: [block.id], headingLevel: null })), headingDecisions: [], figures, guide })
  const report = Schema.decodeUnknownSync(ProcessingReport)({
    ...base.report,
    issues: [
      ...sourceBlocks.filter((block) => block.kind === "unclassified").map((block) => ({ code: "unclassified-content", stage: "extraction", message: "The source is retained without a supported classification.", blockIds: [block.id], locations, figureId: null })),
      { code: "figure-description-unavailable", stage: "figures", message: "This saved fixture has no generated figure description.", blockIds: ["page-1-block-5"], locations, figureId: "figure-1" },
    ],
    checks: [...base.report.checks, { stage: "extraction", checkedPageIds: ["page-1"], result: "issues" }, { stage: "guide", checkedPageIds: ["page-1"], result: "passed" }],
  })
  const configuration = Schema.decodeUnknownSync(Run.fields.configuration)({ ...base.run.configuration, extractionProvider: "meta", extractionVersion: model.model, extractionModel: { ...model, promptName: "page-extraction", promptVersion: "2" }, guide: { ...model, promptName: "reading-guide", promptVersion: "amuseme-1" }, spendingCapUsd: 30 })
  return { ...base, native, canonical, report, configuration, extraction: { ...base.extraction, sourceBlocks: canonical.sourceBlocks, figures: canonical.figures }, images: Schema.decodeUnknownSync(ImageManifest)({ ...base.images, figures: canonical.figures }) }
}

const envelope = (value: unknown) => ({ format: "amuseme-meta-wire-v1", status: 200, requestId: null, complete: true, bodyBase64: Base64.encode(JSON.stringify({ model: "muse-spark-1.3", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(value) } }] })) })

export const publishCodeFixture = Effect.fnUntraced(function* (dataDirectory: string, nativeOverride?: PageExtractionResponse) {
  const fixture = codeRepairFixture()
  const fs = yield* FileSystem.FileSystem
  const documents = yield* DocumentStore
  const database = yield* StorageDatabase
  const crypto = yield* Crypto.Crypto
  const hash = (value: string) => crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.map((bytes) => ArtifactHash.make(Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""))))
  const originalBytes = yield* fs.readFile(new URL("./normal.pdf", import.meta.url).pathname)
  yield* documents.admit(yield* Schema.decodeUnknownEffect(Admission)({ ownerId: owner, idempotencyKey: "code-repair-upload", bytes: originalBytes, originalFilename: "normal.pdf", pageCount: 1, pipelineVersion: "amuseme-meta-3", configuration: fixture.configuration }))
  const claim = yield* documents.claimNext({ workerId: "code-repair-fixture", leaseMilliseconds: 60000 })
  if (claim === null) return yield* Effect.die("Expected a claimed fixture")
  const scope = { documentId: claim.document.id, runId: claim.run.id, revisionId: OutputRevisionId.make("legacy-code-output") }
  const sourceScope = { documentId: claim.document.id, runId: claim.run.id, sourceHash: claim.document.sourceHash }
  const artifacts = yield* makeArtifactStore(dataDirectory)
  const imageBytes = yield* Effect.fromResult(Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII="))
  const image = { path: "images/pixel.png", mediaType: "image/png" as const, ...(yield* artifacts.put(owner, claim.document.id, imageBytes)) }
  const figures = fixture.canonical.figures.map((figure) => ({ ...figure, asset: figure.asset._tag === "available" ? { ...figure.asset, artifact: image } : figure.asset }))
  const canonical = { ...fixture.canonical, scope, figures }
  const extraction = { ...fixture.extraction, scope: sourceScope, figures }
  const images = { ...fixture.images, scope, figures }
  const { providerAttemptId: _providerAttemptId, ...guideContent } = canonical.guide!
  const responses = [envelope(nativeOverride ?? fixture.native), envelope({ fixes: [], joins: [] }), envelope(guideContent)]
  const templates = [
    { id: "repair-extraction-attempt", stage: "extraction", configuration: { _tag: "extraction", provider: "meta", version: model.model, model: fixture.configuration.extractionModel }, inputHashes: [claim.document.sourceHash] },
    { id: "repair-check-attempt", stage: "page-check", configuration: { _tag: "model", ...fixture.configuration.pageCheck }, inputHashes: [claim.document.sourceHash] },
    { id: canonical.guide!.providerAttemptId, stage: "guide", configuration: { _tag: "model", ...fixture.configuration.guide }, inputHashes: [claim.document.sourceHash, yield* hash(JSON.stringify(guideInput(canonical)))] },
  ]
  const receipts: Array<StageReceipt> = []
  for (const [index, template] of templates.entries()) {
    const response = responses[index]!
    const receipt = yield* Schema.decodeUnknownEffect(StageReceipt)({ ...fixture.report.receipts[0]!.receipt, ...template, ownerId: owner, scope: sourceScope, pipelineVersion: claim.run.pipelineVersion, preparedAt: claim.run.createdAt, state: { _tag: "completed", finishedAt: claim.run.createdAt, providerRequestId: null, responseHash: yield* hash(stableJson(response)), durationMilliseconds: 1, usage: { _tag: "unavailable", reason: "Offline saved fixture" }, validation: { _tag: "accepted" } } })
    const intent = yield* Schema.decodeUnknownEffect(AttemptIntent)({ request: { stage: receipt.stage, fixture: "saved code-classification evidence" }, clientIdempotencyKey: null, maximumCostMicrousd: 200000, maxOutputTokens: 16384, maxResponseBytes: 100000, deadlineAt: 60000, retry: { _tag: "none" } })
    receipts.push(receipt)
    yield* database.query("fixture-receipt", () => database.db.insertInto("provider_attempts").values({ id: receipt.id, owner_id: owner, document_id: claim.document.id, run_id: claim.run.id, stage_key: stableJson({ stage: receipt.stage, pageIds: receipt.pageIds, figureId: null }), fingerprint: receipt.requestFingerprint, status: "completed", validation_state: "accepted", receipt_json: JSON.stringify(receipt), intent_json: JSON.stringify(intent), response_json: JSON.stringify(response), claim_token: claim.claimToken, lease_expires_at: 60000, dispatch_started_at: 0, remote_id: null, reserved_microusd: 200000, actual_microusd: null, created_at: 0, updated_at: 0 }).execute())
    yield* database.query("fixture-charge", () => database.db.insertInto("provider_charges").values({ attempt_id: receipt.id, budget_id: "retained-fixture-budget", reserved_microusd: 200000, actual_microusd: null }).execute())
  }
  const report = { ...fixture.report, scope, receipts: receipts.map((receipt) => ({ receipt, delivery: "performed" as const })) }
  const exported = yield* exportDocument({ extraction, canonical, images, report }, [{ artifact: image, bytes: imageBytes }])
  for (const file of exported.files) yield* artifacts.put(owner, claim.document.id, file.bytes)
  const outputs = yield* makeOutputStore().pipe(Effect.provideService(ArtifactStore, artifacts))
  yield* outputs.publish(claim, exported.publication)
  const repair = (apply = true, revision = scope.revisionId, requestedOwner = owner) => repairCodeOutput(requestedOwner, claim.document.id, revision, apply).pipe(Effect.provideService(ArtifactStore, artifacts), Effect.provideService(OutputStore, outputs))
  return { claim, publication: exported.publication, files: exported.files, outputs, artifacts, database, documents, repair, imageBytes, originalBytes, responses }
})
