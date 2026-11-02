import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { sql } from "kysely"
import { ArtifactManifest, CanonicalDocument, OutputRevisionId, ProcessingReport } from "../../src/domain/index.ts"
import { guideInput, verifySavedGuide } from "../../src/paper/guide/evidence.ts"
import { ArtifactStore, DocumentStore, StorageDatabase, makeArtifactStore, makeDocumentStoreLayer, makeOutputStore } from "../../src/storage/index.ts"
import { codeIds, codeRepairFixture, publishCodeFixture, unknownId } from "../fixtures/code-repair.ts"
import { directory, other, owner, setup } from "../fixtures/published-output.ts"

const history = Effect.gen(function* () {
  const { db, query } = yield* StorageDatabase
  return {
    documents: yield* query("history", () => db.selectFrom("documents").selectAll().orderBy("id").execute()),
    runs: yield* query("history", () => db.selectFrom("runs").selectAll().orderBy("id").execute()),
    outputs: yield* query("history", () => db.selectFrom("outputs").selectAll().orderBy("revision_id").execute()),
    receipts: yield* query("history", () => db.selectFrom("provider_attempts").selectAll().orderBy("id").execute()),
    charges: yield* query("history", () => db.selectFrom("provider_charges").selectAll().orderBy("attempt_id").execute()),
    queued: yield* query("history", () => db.selectFrom("accepted_jobs").selectAll().execute()),
  }
})

describe("offline saved-output code repair", () => {
  it.effect("previews without writes, then preserves the original revision, guide, image, source and charge ledger", () => Effect.gen(function* () {
    const options = yield* directory
    const published = yield* Effect.gen(function* () {
      const saved = yield* publishCodeFixture(options.dataDirectory)
      const before = yield* history
      const prior = saved.publication.canonical.scope.revisionId
      const preview = yield* saved.repair(false)
      expect(preview).toMatchObject({ blockIds: codeIds, issuesBefore: 4, issuesAfter: 2, newProviderCalls: 0, applied: false, revisionId: null })
      expect(yield* history).toEqual(before)
      const result = yield* saved.repair()
      if (result.revisionId === null) return yield* Effect.die("Expected a new local revision")
      const canonical = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CanonicalDocument))(new TextDecoder().decode((yield* saved.outputs.read(owner, saved.claim.document.id, result.revisionId, "document.json")).bytes))
      const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProcessingReport))(new TextDecoder().decode((yield* saved.outputs.read(owner, saved.claim.document.id, result.revisionId, "processing-report.json")).bytes))
      const after = yield* history
      expect(canonical.sourceBlocks.map((block) => block.kind)).toEqual(["code", "unclassified", "code", "paragraph", "figure", "caption"])
      expect(canonical.blocks.map(({ content, format, locations, sourceBlockIds }) => ({ content, format, locations, sourceBlockIds }))).toEqual(saved.publication.canonical.blocks.map(({ content, format, locations, sourceBlockIds }) => ({ content, format, locations, sourceBlockIds })))
      expect(canonical.sourceBlocks.map(({ content, format, locations }) => ({ content, format, locations }))).toEqual(saved.publication.canonical.sourceBlocks.map(({ content, format, locations }) => ({ content, format, locations })))
      expect(canonical.guide).toEqual(saved.publication.canonical.guide)
      expect(report.codeClassificationRepair).toEqual({ previousRevisionId: prior, blockIds: codeIds })
      expect(report.issues.map((issue) => issue.blockIds)).toEqual([[unknownId], [saved.publication.canonical.figures[0]!.sourceBlockIds[0]]])
      expect(report.receipts.map(({ receipt }) => receipt)).toEqual(saved.publication.report.receipts.map(({ receipt }) => receipt))
      expect(report.receipts.every(({ delivery }) => delivery === "reused")).toBe(true)
      const guideReceipt = saved.publication.report.receipts.find(({ receipt }) => receipt.stage === "guide")!.receipt
      yield* verifySavedGuide(saved.publication.canonical, guideReceipt, saved.responses[2]!)
      expect(guideInput(canonical)).not.toEqual(guideInput(saved.publication.canonical))
      expect((yield* verifySavedGuide(canonical, guideReceipt, saved.responses[2]!).pipe(Effect.result))._tag).toBe("Failure")
      expect(after.receipts).toEqual(before.receipts)
      expect(after.charges).toEqual(before.charges)
      expect(after.runs).toEqual(expect.arrayContaining(before.runs))
      expect(after.outputs).toEqual(expect.arrayContaining(before.outputs))
      expect(after.runs).toHaveLength(2)
      expect(after.outputs).toHaveLength(2)
      expect(after.queued).toEqual([])
      expect(after.documents[0]!.document_json).toBe(before.documents[0]!.document_json)
      const detail = yield* saved.documents.detail(owner, saved.claim.document.id)
      expect(detail.currentRevisionId).toBe(result.revisionId)
      expect(detail.latestRun.state._tag).toBe("succeeded-with-issues")
      expect(detail.latestRun.mastraRunId).toBe(`local-code-repair-${detail.latestRun.id}`)
      expect((yield* saved.documents.list(owner))[0]?.currentRevisionId).toBe(result.revisionId)
      for (const file of saved.files) expect((yield* saved.outputs.read(owner, saved.claim.document.id, prior, file.entry.path)).bytes).toEqual(file.bytes)
      expect((yield* saved.outputs.read(owner, saved.claim.document.id, result.revisionId, "images/pixel.png")).bytes).toEqual(saved.imageBytes)
      expect((yield* saved.documents.original(owner, saved.claim.document.id)).bytes).toEqual(new Uint8Array(saved.originalBytes))
      const oldText = new TextDecoder().decode(saved.files.find((file) => file.entry.path === "normalized.txt")!.bytes)
      expect(new TextDecoder().decode((yield* saved.outputs.read(owner, saved.claim.document.id, result.revisionId, "normalized.txt")).bytes)).toBe(oldText.replaceAll("[unclassified; markdown]", "[code; markdown]"))
      const committed = yield* history
      expect((yield* saved.repair().pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* saved.repair(true, result.revisionId).pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* history).toEqual(committed)
      return { documentId: saved.claim.document.id, revisionId: result.revisionId, prior, guide: canonical.guide, receipts: after.receipts, charges: after.charges }
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
    yield* Effect.gen(function* () {
      const documents = yield* DocumentStore
      const artifacts = yield* makeArtifactStore(options.dataDirectory)
      const outputs = yield* makeOutputStore().pipe(Effect.provideService(ArtifactStore, artifacts))
      const detail = yield* documents.detail(owner, published.documentId)
      expect(detail.currentRevisionId).toBe(published.revisionId)
      expect(detail.latestRun.mastraRunId).toBe(`local-code-repair-${detail.latestRun.id}`)
      expect((yield* documents.list(owner))[0]?.currentRevisionId).toBe(published.revisionId)
      const reopened = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CanonicalDocument))(new TextDecoder().decode((yield* outputs.read(owner, published.documentId, published.revisionId, "document.json")).bytes))
      expect(reopened.guide).toEqual(published.guide)
      expect((yield* outputs.manifest(owner, published.documentId, published.prior)).scope.revisionId).toBe(published.prior)
      const retained = yield* history
      expect(retained.receipts).toEqual(published.receipts)
      expect(retained.charges).toEqual(published.charges)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects stale revisions, foreign owners and corrupted durable evidence without creating output", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const saved = yield* publishCodeFixture(options.dataDirectory)
      const before = yield* history
      expect((yield* saved.repair(true, OutputRevisionId.make("stale-output")).pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* saved.repair(true, saved.publication.canonical.scope.revisionId, other).pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* history).toEqual(before)
      const receipt = before.receipts.find((row) => row.id === "repair-extraction-attempt")!
      for (const changed of [
        { response_json: "{}" }, { response_json: "not-json" }, { owner_id: other }, { validation_state: "pending" }, { fingerprint: "b".repeat(64) }, { stage_key: "{}" }, { intent_json: "{}" }, { receipt_json: JSON.stringify({ ...saved.publication.report.receipts[0]!.receipt, requestFingerprint: "b".repeat(64) }) },
      ]) {
        yield* saved.database.query("corrupt-fixture", () => saved.database.db.updateTable("provider_attempts").set(changed).where("id", "=", receipt.id).execute())
        expect((yield* saved.repair().pipe(Effect.result))._tag, JSON.stringify(changed)).toBe("Failure")
        yield* saved.database.query("restore-fixture", () => saved.database.db.updateTable("provider_attempts").set(receipt).where("id", "=", receipt.id).execute())
        expect(yield* history).toEqual(before)
      }
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects hash-valid extraction evidence for changed code or another page", () => Effect.gen(function* () {
    const native = codeRepairFixture().native
    for (const response of [
      { ...native, blocks: native.blocks.map((block, index) => index === 0 ? { ...block, content: "```python\nprint(13)\n```" } : block) },
      { ...native, pageNumber: 2 },
    ]) {
      const options = yield* directory
      yield* Effect.gen(function* () {
        const saved = yield* publishCodeFixture(options.dataDirectory, response)
        const before = yield* history
        expect((yield* saved.repair().pipe(Effect.result))._tag).toBe("Failure")
        expect(yield* history).toEqual(before)
      }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
    }
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects altered published guide content or generation context even when stored artifact hashes match", () => Effect.gen(function* () {
    for (const change of ["guide", "context"] as const) {
      const options = yield* directory
      yield* Effect.gen(function* () {
        const saved = yield* publishCodeFixture(options.dataDirectory)
        const original = saved.publication.canonical
        const canonical = change === "guide"
          ? { ...original, guide: { ...original.guide!, title: "An explanation never returned by the saved provider" } }
          : { ...original, blocks: original.blocks.map((block) => block.id === original.blocks[3]!.id ? { ...block, content: "A different normalized context after guide generation." } : block) }
        const stored = yield* saved.artifacts.put(owner, saved.claim.document.id, new TextEncoder().encode(JSON.stringify(canonical)))
        const manifest = { ...saved.publication.manifest, entries: saved.publication.manifest.entries.map((entry) => entry.path === "document.json" ? { ...entry, ...stored } : entry) }
        yield* saved.database.query("alter-publication", () => saved.database.db.updateTable("outputs").set({ manifest_json: JSON.stringify(manifest) }).where("revision_id", "=", original.scope.revisionId).execute())
        const before = yield* history
        expect((yield* saved.repair().pipe(Effect.result))._tag, change).toBe("Failure")
        expect(yield* history).toEqual(before)
      }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
    }
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("refuses a damaged published artifact before any repair commit", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const saved = yield* publishCodeFixture(options.dataDirectory)
      const before = yield* history
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const entry = saved.publication.manifest.entries.find((file) => file.path === "normalized.txt")!
      yield* fs.writeFile(path.join(options.dataDirectory, "documents", saved.claim.document.id, "objects", entry.hash), new TextEncoder().encode("corrupt saved publication"))
      expect((yield* saved.repair().pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* history).toEqual(before)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rolls back run, output and latest pointer when the final pointer write fails", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const saved = yield* publishCodeFixture(options.dataDirectory)
      const before = yield* history
      yield* saved.database.query("fault", () => sql.raw("CREATE TRIGGER fail_code_repair BEFORE UPDATE OF latest_run_id ON documents BEGIN SELECT RAISE(FAIL,'fixture pointer failure'); END").execute(saved.database.db))
      expect((yield* saved.repair().pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* history).toEqual(before)
      expect((yield* saved.documents.detail(owner, saved.claim.document.id)).currentRevisionId).toBe(saved.publication.canonical.scope.revisionId)
      yield* saved.database.query("fault", () => sql.raw("DROP TRIGGER fail_code_repair").execute(saved.database.db))
      expect((yield* saved.repair()).applied).toBe(true)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("keeps repair metadata out of the ordinary publication path", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const { claim, publication, outputs, artifacts, database } = yield* setup(options.dataDirectory)
      const report = { ...publication.report, codeClassificationRepair: { previousRevisionId: OutputRevisionId.make("prior"), blockIds: [publication.canonical.sourceBlocks[0]!.id] as const } }
      const stored = yield* artifacts.put(owner, claim.document.id, new TextEncoder().encode(JSON.stringify(report)))
      const manifest = yield* Schema.decodeUnknownEffect(ArtifactManifest)({ ...publication.manifest, entries: publication.manifest.entries.map((entry) => entry.path === "processing-report.json" ? { ...entry, ...stored } : entry) })
      expect((yield* outputs.publish(claim, { ...publication, report, manifest }).pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* database.query("unpublished", () => database.db.selectFrom("outputs").selectAll().execute())).toEqual([])
      expect((yield* outputs.publish(claim, publication)).state._tag).toBe("succeeded")
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))
})
