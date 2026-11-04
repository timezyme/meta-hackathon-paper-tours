import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Path, Schema } from "effect"
import * as PlatformError from "effect/PlatformError"
import { TestClock } from "effect/testing"
import { Admission, DocumentStore, makeDocumentStoreLayer } from "../../src/storage/index.ts"
import { documentRetentionMilliseconds } from "../../src/storage/service.ts"
import { directory, owner, setup } from "../fixtures/published-output.ts"
import { contractFixture } from "../fixtures/contracts.ts"

const namespaces = [["uploads", "upload-"], ["processing", "render-"], ["archives", "mineru-"]] as const
const denied = (method: string) => new PlatformError.PlatformError(new PlatformError.SystemError({
  _tag: "PermissionDenied", module: "FileSystem", method,
}))

describe("local document retention", () => {
  it.effect("hides documents at exactly seven days, purges private payloads, and preserves charges", () => Effect.gen(function* () {
    const options = yield* directory
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* Effect.gen(function* () {
      const f = yield* setup(options.dataDirectory)
      yield* f.outputs.publish(f.claim, f.publication)
      const revision = f.publication.manifest.scope.revisionId
      yield* f.outputs.rate(owner, f.claim.document.id, revision, "down")
      const beforeCharges = yield* f.database.query("charges", () => f.database.db.selectFrom("provider_charges").selectAll().execute())
      expect(beforeCharges.length).toBeGreaterThan(0)
      yield* TestClock.adjust(documentRetentionMilliseconds - 1)
      expect((yield* f.documents.detail(owner, f.claim.document.id)).document.lifecycle._tag).toBe("active")
      yield* TestClock.adjust(1)
      expect(yield* f.documents.list(owner)).toEqual([])
      expect((yield* f.outputs.read(owner, f.claim.document.id, revision, "normalized.txt").pipe(Effect.flip)).code).toBe("not-found")
      const target = path.join(options.dataDirectory, "documents", f.claim.document.id)
      expect(yield* fs.exists(target)).toBe(true)
      yield* f.documents.reconcile()
      expect(yield* fs.exists(target)).toBe(false)
      for (const table of ["provider_attempts", "outputs", "ratings", "accepted_jobs"] as const) {
        expect(yield* f.database.query("purged", () => f.database.db.selectFrom(table).selectAll().execute())).toEqual([])
      }
      expect(yield* f.database.query("charges", () => f.database.db.selectFrom("provider_charges").selectAll().execute())).toEqual(beforeCharges)
      expect((yield* f.documents.delete(owner, f.claim.document.id).pipe(Effect.flip)).code).toBe("not-found")
      yield* f.documents.reconcile()
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("sweeps crash namespaces only at startup and leaves live temporary work and unrelated names intact", () => Effect.gen(function* () {
    const options = yield* directory
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const retained = yield* Effect.gen(function* () {
      const f = yield* setup(options.dataDirectory)
      yield* f.outputs.publish(f.claim, f.publication)
      return { document: f.claim.document, manifest: f.publication.manifest }
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
    const targets: string[] = []
    const external = path.join(options.dataDirectory, "external")
    yield* fs.makeDirectory(external)
    yield* fs.writeFileString(path.join(external, "keep.txt"), "untouched")
    for (const [folder, prefix] of namespaces) {
      const parent = path.join(options.dataDirectory, folder)
      yield* fs.makeDirectory(parent, { recursive: true })
      const orphan = yield* fs.makeTempDirectory({ directory: parent, prefix })
      yield* fs.writeFileString(path.join(orphan, "partial"), "private abandoned bytes")
      yield* fs.writeFileString(path.join(parent, "unrelated.txt"), "preserved")
      const link = path.join(parent, prefix + "LINK01")
      yield* fs.symlink(external, link)
      targets.push(orphan, link)
    }
    const documentRoot = path.join(options.dataDirectory, "documents", retained.document.id)
    const partialSource = path.join(documentRoot, ".source.tmp")
    const partialBlob = path.join(documentRoot, "objects", ".blob-00000000-0000-0000-0000-000000000000")
    yield* fs.writeFileString(partialSource, "abandoned source")
    yield* fs.writeFileString(partialBlob, "abandoned object")
    yield* fs.writeFileString(path.join(documentRoot, "objects", ".blob-unrelated"), "preserved")
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      for (const target of [...targets, partialSource, partialBlob]) expect(yield* fs.exists(target)).toBe(false)
      expect(yield* fs.readFileString(path.join(external, "keep.txt"))).toBe("untouched")
      expect(yield* fs.readFileString(path.join(documentRoot, "objects", ".blob-unrelated"))).toBe("preserved")
      for (const entry of retained.manifest.entries) expect(yield* fs.exists(path.join(documentRoot, "objects", entry.hash))).toBe(true)
      const active: string[] = []
      for (const [folder, prefix] of namespaces) {
        const parent = path.join(options.dataDirectory, folder)
        expect(yield* fs.readFileString(path.join(parent, "unrelated.txt"))).toBe("preserved")
        active.push(yield* fs.makeTempDirectory({ directory: parent, prefix }))
      }
      yield* fs.writeFileString(partialBlob, "live write")
      yield* store.reconcile()
      for (const target of [...active, partialBlob]) expect(yield* fs.exists(target)).toBe(true)
      expect((yield* store.original(owner, retained.document.id)).bytes.byteLength).toBe(retained.document.byteCount)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("refuses a symlinked cleanup root without touching external data", () => Effect.gen(function* () {
    const options = yield* directory
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* Effect.void.pipe(Effect.provide(makeDocumentStoreLayer(options)))
    const external = path.join(options.dataDirectory, "external")
    yield* fs.makeDirectory(path.join(external, "mineru-ABC123"), { recursive: true })
    yield* fs.writeFileString(path.join(external, "mineru-ABC123", "keep.txt"), "untouched")
    yield* fs.symlink(external, path.join(options.dataDirectory, "archives"))
    expect((yield* Effect.void.pipe(Effect.provide(makeDocumentStoreLayer(options)), Effect.result))._tag).toBe("Failure")
    expect(yield* fs.readFileString(path.join(external, "mineru-ABC123", "keep.txt"))).toBe("untouched")
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("keeps a committed tombstone after removal failure and completes cleanup on a later pass", () => Effect.gen(function* () {
    const options = yield* directory
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    let blockedId = ""
    const guardedFs: FileSystem.FileSystem = { ...fs, remove: (target, settings) => blockedId !== "" && target.endsWith("/" + blockedId)
      ? Effect.fail(denied("remove")) : fs.remove(target, settings) }
    yield* Effect.gen(function* () {
      const f = yield* setup(options.dataDirectory)
      yield* f.outputs.publish(f.claim, f.publication)
      blockedId = f.claim.document.id
      expect((yield* f.documents.delete(owner, f.claim.document.id).pipe(Effect.flip)).code).toBe("storage-failed")
      expect((yield* f.documents.original(owner, f.claim.document.id).pipe(Effect.flip)).code).toBe("not-found")
      expect((yield* f.documents.delete(owner, f.claim.document.id).pipe(Effect.flip)).code).toBe("not-found")
      const target = path.join(options.dataDirectory, "documents", f.claim.document.id)
      expect(yield* fs.exists(target)).toBe(true)
      blockedId = ""
      yield* f.documents.reconcile()
      expect(yield* fs.exists(target)).toBe(false)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)), Effect.provideService(FileSystem.FileSystem, guardedFs))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("does not return a source download whose owner deleted it while the file was being read", () => Effect.gen(function* () {
    const options = yield* directory
    const fs = yield* FileSystem.FileSystem
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let intercept = false
    const pausedFs: FileSystem.FileSystem = { ...fs, open: (target, settings) => fs.open(target, settings).pipe(Effect.map((file) => !intercept || !target.endsWith("/source.pdf") ? file : new Proxy(file, {
      get: (handle, property) => property === "read"
        ? (buffer: Uint8Array) => handle.read(buffer).pipe(Effect.tap(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))))
        : Reflect.get(handle, property),
    }))) }
    yield* Effect.gen(function* () {
      const f = yield* setup(options.dataDirectory)
      yield* f.outputs.publish(f.claim, f.publication)
      intercept = true
      const pending = yield* f.documents.original(owner, f.claim.document.id).pipe(Effect.result, Effect.forkScoped)
      yield* Deferred.await(started)
      yield* f.documents.delete(owner, f.claim.document.id)
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(pending)).toMatchObject({ _tag: "Failure", failure: { code: "not-found" } })
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)), Effect.provideService(FileSystem.FileSystem, pausedFs))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("preserves an admission staged concurrently with periodic reconciliation, before and after commit", () => Effect.gen(function* () {
    const options = yield* directory
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const pausedFs: FileSystem.FileSystem = { ...fs, open: (target, settings) => fs.open(target, settings).pipe(Effect.map((file) => !target.endsWith("/.source.tmp") ? file : new Proxy(file, {
      get: (handle, property) => property === "writeAll"
        ? (buffer: Uint8Array) => handle.writeAll(buffer).pipe(Effect.andThen(Deferred.succeed(started, undefined)), Effect.andThen(Deferred.await(release)))
        : Reflect.get(handle, property),
    }))) }
    const bytes = yield* fs.readFile(new URL("../fixtures/normal.pdf", import.meta.url).pathname)
    const input = yield* Schema.decodeUnknownEffect(Admission)({ ownerId: owner, idempotencyKey: "concurrent-upload", originalFilename: "paper.pdf", bytes, pageCount: 1, pipelineVersion: "1", configuration: contractFixture().run.configuration })
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const pending = yield* store.admit(input).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* store.reconcile()
      const entries = yield* fs.readDirectory(path.join(options.dataDirectory, "documents"))
      expect(entries).toHaveLength(1)
      yield* Deferred.succeed(release, undefined)
      const accepted = yield* Fiber.join(pending)
      yield* store.reconcile()
      expect((yield* store.original(owner, accepted.documentId)).bytes).toEqual(new Uint8Array(bytes))
      expect(yield* fs.readDirectory(path.join(options.dataDirectory, "documents"))).toEqual([accepted.documentId])
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)), Effect.provideService(FileSystem.FileSystem, pausedFs))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
