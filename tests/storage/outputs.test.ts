import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { sql } from "kysely"
import { ArtifactManifest, OutputRevisionId } from "../../src/domain/index.ts"
import { ArtifactStore, makeArtifactStore, makeDocumentStoreLayer, makeOutputStore } from "../../src/storage/index.ts"
import { owner, other, text, directory, setup } from "../fixtures/published-output.ts"


describe("complete output publication", () => {
  it.effect("makes complete bytes visible with one terminal run, removes queued work, and persists ratings", () => Effect.gen(function* () {
    const options = yield* directory
    const saved = yield* Effect.gen(function* () {
      const { claim, publication, outputs, documents, database } = yield* setup(options.dataDirectory)
      const revision = publication.canonical.scope.revisionId
      expect((yield* outputs.manifest(owner, claim.document.id, revision).pipe(Effect.result))._tag).toBe("Failure")
      const run = yield* outputs.publish(claim, publication)
      expect(run.state._tag).toBe("succeeded")
      expect((yield* documents.status(owner, claim.document.id)).state).toEqual(run.state)
      expect(yield* database.query("test", () => database.db.selectFrom("accepted_jobs").selectAll().execute())).toEqual([])
      expect((yield* outputs.read(owner, claim.document.id, revision, "normalized.txt")).bytes).toEqual(text)
      expect(yield* outputs.rating(owner, claim.document.id, revision)).toBeNull()
      yield* outputs.rate(owner, claim.document.id, revision, "up")
      yield* outputs.rate(owner, claim.document.id, revision, "down")
      return { documentId: claim.document.id, revision }
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
    yield* Effect.gen(function* () {
      const artifacts = yield* makeArtifactStore(options.dataDirectory)
      const outputs = yield* makeOutputStore().pipe(Effect.provideService(ArtifactStore, artifacts))
      expect(yield* outputs.rating(owner, saved.documentId, saved.revision)).toBe("down")
      yield* outputs.rate(owner, saved.documentId, saved.revision, null)
      expect(yield* outputs.rating(owner, saved.documentId, saved.revision)).toBeNull()
      expect((yield* outputs.read(owner, saved.documentId, saved.revision, "normalized.txt")).bytes).toEqual(text)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects fabricated provider provenance without exposing output or marking success", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const { claim, publication, outputs, documents, database } = yield* setup(options.dataDirectory, false)
      expect((yield* outputs.publish(claim, publication).pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* documents.status(owner, claim.document.id)).state._tag).toBe("running")
      expect(yield* database.query("test", () => database.db.selectFrom("outputs").selectAll().execute())).toEqual([])
      const state = { _tag: "succeeded" as const, startedAt: claim.run.createdAt, finishedAt: claim.run.createdAt, revisionId: publication.canonical.scope.revisionId }
      expect((yield* documents.updateRun(claim, state).pipe(Effect.result))._tag).toBe("Failure")
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects changed JSON and damaged files before publishing", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const { claim, publication, outputs, artifacts, database } = yield* setup(options.dataDirectory)
      const wrong = yield* artifacts.put(owner, claim.document.id, new TextEncoder().encode("{}"))
      const manifest = yield* Schema.decodeUnknownEffect(ArtifactManifest)({ ...publication.manifest, entries: publication.manifest.entries.map((entry) => entry.path === "document.json" ? { ...entry, ...wrong } : entry) })
      expect((yield* outputs.publish(claim, { ...publication, manifest }).pipe(Effect.result))._tag).toBe("Failure")
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const normalized = publication.manifest.entries.find((entry) => entry.path === "normalized.txt")
      if (normalized === undefined) return yield* Effect.die("Missing test text")
      yield* fs.remove(path.join(options.dataDirectory, "documents", claim.document.id, "objects", normalized.hash))
      expect((yield* outputs.publish(claim, publication).pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* database.query("test", () => database.db.selectFrom("outputs").selectAll().execute())).toEqual([])
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("fences old claims and rejects foreign users, revisions and paths", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const { claim, publication, outputs } = yield* setup(options.dataDirectory)
      expect((yield* outputs.publish({ ...claim, claimToken: "stale" }, publication).pipe(Effect.result))._tag).toBe("Failure")
      yield* outputs.publish(claim, publication)
      const revision = publication.canonical.scope.revisionId
      for (const operation of [
        outputs.read(other, claim.document.id, revision, "normalized.txt"),
        outputs.read(owner, claim.document.id, OutputRevisionId.make("foreign-revision"), "normalized.txt"),
        outputs.read(owner, claim.document.id, revision, "../source.pdf"),
        outputs.rate(other, claim.document.id, revision, "up"),
      ]) expect((yield* operation.pipe(Effect.result))._tag).toBe("Failure")
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("deletes output and rating records and rejects their stale URLs", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const { claim, publication, outputs, documents, database } = yield* setup(options.dataDirectory)
      const revision = publication.canonical.scope.revisionId
      yield* outputs.publish(claim, publication)
      yield* outputs.rate(owner, claim.document.id, revision, "up")
      yield* documents.delete(owner, claim.document.id)
      expect((yield* outputs.read(owner, claim.document.id, revision, "normalized.txt").pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* database.query("test", () => database.db.selectFrom("outputs").selectAll().execute())).toEqual([])
      expect(yield* database.query("test", () => database.db.selectFrom("ratings").selectAll().execute())).toEqual([])
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rolls back publication when the final run write fails and can retry the local commit", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const { claim, publication, outputs, documents, database } = yield* setup(options.dataDirectory)
      yield* database.query("fault", () => sql.raw("CREATE TRIGGER fail_publication BEFORE UPDATE ON runs WHEN NEW.state='succeeded' BEGIN SELECT RAISE(FAIL,'fixture write failure'); END").execute(database.db))
      expect((yield* outputs.publish(claim, publication).pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* documents.status(owner, claim.document.id)).state._tag).toBe("running")
      expect(yield* database.query("test", () => database.db.selectFrom("outputs").selectAll().execute())).toEqual([])
      expect((yield* database.query("test", () => database.db.selectFrom("accepted_jobs").selectAll().execute())).length).toBe(1)
      yield* database.query("fault", () => sql.raw("DROP TRIGGER fail_publication").execute(database.db))
      expect((yield* outputs.publish(claim, publication)).state._tag).toBe("succeeded")
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))
})
