import { Effect, FileSystem, Path, Schema } from "effect"
import { CanonicalDocument, ImageManifest, OutputRevisionId, ProcessingReport, UserId } from "../../src/domain/index.ts"
import { Admission, ArtifactStore, DocumentStore, Publication, StorageDatabase, makeArtifactStore, makeOutputStore } from "../../src/storage/index.ts"
import { contractFixture } from "./contracts.ts"

export const owner = UserId.make("output-owner")
export const other = UserId.make("other-owner")
export const text = new TextEncoder().encode("A synthetic document\nThe result is 12 units.\n")
export const directory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-outputs-" })
  return { dataDirectory: path.join(temporary, "data"), queueLimit: 10 }
})
export const setup = Effect.fnUntraced(function* (dataDirectory: string, saveReceipts = true) {
  const fs = yield* FileSystem.FileSystem
  const documents = yield* DocumentStore
  const database = yield* StorageDatabase
  const fixture = contractFixture()
  const bytes = yield* fs.readFile(new URL("./normal.pdf", import.meta.url).pathname)
  yield* documents.admit(yield* Schema.decodeUnknownEffect(Admission)({ ownerId: owner, idempotencyKey: "output-upload", bytes, originalFilename: "normal.pdf", pageCount: 1, pipelineVersion: "1", configuration: fixture.run.configuration }))
  const claim = yield* documents.claimNext({ workerId: "output-worker", leaseMilliseconds: 60000 })
  if (claim === null) return yield* Effect.die("Expected a processing claim")
  const scope = { documentId: claim.document.id, runId: claim.run.id, revisionId: OutputRevisionId.make("output-1") }
  const sourceScope = { documentId: claim.document.id, runId: claim.run.id, sourceHash: claim.document.sourceHash }
  const extraction = { ...fixture.extraction, scope: sourceScope }
  const canonical = yield* Schema.decodeUnknownEffect(CanonicalDocument)({ ...fixture.canonical, scope })
  const images = yield* Schema.decodeUnknownEffect(ImageManifest)({ ...fixture.images, scope })
  const receipts = fixture.report.receipts.map((entry) => ({ ...entry, receipt: { ...entry.receipt, ownerId: owner, scope: sourceScope } }))
  const report = yield* Schema.decodeUnknownEffect(ProcessingReport)({ ...fixture.report, scope, receipts })
  if (saveReceipts) for (const { receipt } of receipts) {
    yield* database.query("test-receipt", () => database.db.insertInto("provider_attempts").values({
      id: receipt.id, owner_id: owner, document_id: claim.document.id, run_id: claim.run.id,
      stage_key: "fixture-page-check", fingerprint: receipt.requestFingerprint, status: "completed", receipt_json: JSON.stringify(receipt),
      intent_json: "{}", response_json: "{}", claim_token: claim.claimToken, lease_expires_at: 60000, dispatch_started_at: 0,
      remote_id: null, reserved_microusd: 0, actual_microusd: 0, created_at: 0, updated_at: 0, validation_state: "accepted",
    }).execute())
    yield* database.query("test-charge", () => database.db.insertInto("provider_charges").values({ attempt_id: receipt.id, budget_id: "fixture", reserved_microusd: 0, actual_microusd: 0 }).execute())
  }
  const artifacts = yield* makeArtifactStore(dataDirectory)
  const files = [
    { path: "normalized.txt", mediaType: "text/plain; charset=utf-8", bytes: text },
    ...[["document.json", canonical], ["images.json", images], ["processing-report.json", report]].map(([name, value]) => ({ path: name, mediaType: "application/json", bytes: new TextEncoder().encode(JSON.stringify(value)) })),
  ]
  const entries = yield* Effect.forEach(files, (file) => artifacts.put(owner, claim.document.id, file.bytes).pipe(Effect.map((receipt) => ({ path: file.path, mediaType: file.mediaType, ...receipt }))))
  const publication = yield* Schema.decodeUnknownEffect(Publication)({ extraction, canonical, images, report, manifest: { schemaVersion: "1", scope, entries } })
  const outputs = yield* makeOutputStore().pipe(Effect.provideService(ArtifactStore, artifacts))
  return { claim, publication, outputs, artifacts, documents, database }
})
