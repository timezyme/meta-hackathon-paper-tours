import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, FileSystem, Path, Schema } from "effect"
import { ArtifactHash, UserId } from "../../src/domain/index.ts"
import { Admission, DocumentStore, artifactLimits, makeArtifactStore, makeDocumentStoreLayer } from "../../src/storage/index.ts"
import { contractFixture } from "../fixtures/contracts.ts"

const owner = UserId.make("artifact-owner")
const other = UserId.make("another-owner")
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-artifacts-" })
  const options = { dataDirectory: path.join(temporary, "data"), queueLimit: 10 }
  const bytes = yield* fs.readFile(new URL("../fixtures/normal.pdf", import.meta.url).pathname)
  const input = yield* Schema.decodeUnknownEffect(Admission)({
    ownerId: owner, idempotencyKey: "upload", bytes, originalFilename: "normal.pdf", pageCount: 1,
    pipelineVersion: "1", configuration: contractFixture().run.configuration,
  })
  return { fs, path, options, input }
})
const content = new TextEncoder().encode("Normalized Unicode: α ≤ 4; résumé.\n")

describe("private document artifacts", () => {
  it.effect("keeps exact bytes and private permissions across restart without cross-owner reuse", () => Effect.gen(function* () {
    const { options, input, fs, path } = yield* fixture
    const saved = yield* Effect.gen(function* () {
      const documents = yield* DocumentStore
      const accepted = yield* documents.admit(input)
      const artifacts = yield* makeArtifactStore(options.dataDirectory)
      const artifact = yield* artifacts.put(owner, accepted.documentId, content)
      const object = path.join(options.dataDirectory, "documents", accepted.documentId, "objects", artifact.hash)
      expect((yield* fs.stat(object)).mode & 0o777).toBe(0o600)
      expect((yield* artifacts.read(other, accepted.documentId, artifact).pipe(Effect.result))._tag).toBe("Failure")
      return { ...accepted, artifact }
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
    yield* Effect.gen(function* () {
      const artifacts = yield* makeArtifactStore(options.dataDirectory)
      expect(yield* artifacts.read(owner, saved.documentId, saved.artifact)).toEqual(content)
      expect(yield* artifacts.put(owner, saved.documentId, content)).toEqual(saved.artifact)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("coalesces concurrent duplicate writes and leaves no temporary files", () => Effect.gen(function* () {
    const { options, input, fs, path } = yield* fixture
    yield* Effect.gen(function* () {
      const documents = yield* DocumentStore
      const { documentId } = yield* documents.admit(input)
      const artifacts = yield* makeArtifactStore(options.dataDirectory)
      const receipts = yield* Effect.all(Array.from({ length: 10 }, () => artifacts.put(owner, documentId, content)), { concurrency: "unbounded" })
      expect(new Set(receipts.map((receipt) => receipt.hash)).size).toBe(1)
      expect(yield* fs.readDirectory(path.join(options.dataDirectory, "documents", documentId, "objects"))).toEqual([receipts[0]?.hash])
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects tampered bytes, incorrect lengths and traversal instead of replacing stored evidence", () => Effect.gen(function* () {
    const { options, input, fs, path } = yield* fixture
    yield* Effect.gen(function* () {
      const documents = yield* DocumentStore
      const { documentId } = yield* documents.admit(input)
      const artifacts = yield* makeArtifactStore(options.dataDirectory)
      const artifact = yield* artifacts.put(owner, documentId, content)
      expect((yield* artifacts.read(owner, documentId, { ...artifact, byteCount: artifact.byteCount + 1 }).pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* artifacts.read(owner, documentId, { ...artifact, hash: "../../source.pdf" as ArtifactHash }).pipe(Effect.result))._tag).toBe("Failure")
      const object = path.join(options.dataDirectory, "documents", documentId, "objects", artifact.hash)
      const changed = new Uint8Array(content).fill(0)
      yield* fs.writeFile(object, changed)
      expect((yield* artifacts.read(owner, documentId, artifact).pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* artifacts.put(owner, documentId, content).pipe(Effect.result))._tag).toBe("Failure")
      expect(Array.from(yield* fs.readFile(object))).toEqual(Array.from(changed))
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects symlinked artifact directories and files", () => Effect.gen(function* () {
    const { options, input, fs, path } = yield* fixture
    yield* Effect.gen(function* () {
      const documents = yield* DocumentStore
      const { documentId } = yield* documents.admit(input)
      const artifacts = yield* makeArtifactStore(options.dataDirectory)
      const artifact = yield* artifacts.put(owner, documentId, content)
      const directory = path.join(options.dataDirectory, "documents", documentId, "objects")
      const saved = `${directory}-saved`
      yield* fs.rename(directory, saved)
      yield* fs.symlink(saved, directory)
      expect((yield* artifacts.read(owner, documentId, artifact).pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* artifacts.put(owner, documentId, content).pipe(Effect.result))._tag).toBe("Failure")
      yield* fs.remove(directory)
      yield* fs.rename(saved, directory)
      const object = path.join(directory, artifact.hash)
      yield* fs.rename(object, `${object}-saved`)
      yield* fs.symlink(`${object}-saved`, object)
      expect((yield* artifacts.read(owner, documentId, artifact).pipe(Effect.result))._tag).toBe("Failure")
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("enforces per-object and aggregate object allowances", () => Effect.gen(function* () {
    const { options, input, fs, path } = yield* fixture
    yield* Effect.gen(function* () {
      const documents = yield* DocumentStore
      const { documentId } = yield* documents.admit(input)
      const artifacts = yield* makeArtifactStore(options.dataDirectory)
      expect((yield* artifacts.put(owner, documentId, new Uint8Array(artifactLimits.objectBytes + 1)).pipe(Effect.result))._tag).toBe("Failure")
      const artifact = yield* artifacts.put(owner, documentId, content)
      const object = path.join(options.dataDirectory, "documents", documentId, "objects", artifact.hash)
      yield* fs.truncate(object, artifactLimits.documentBytes)
      expect((yield* artifacts.put(owner, documentId, new Uint8Array([1])).pipe(Effect.result))._tag).toBe("Failure")
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("removes artifacts with their terminal document and denies stale reads or writes", () => Effect.gen(function* () {
    const { options, input, fs, path } = yield* fixture
    yield* Effect.gen(function* () {
      const documents = yield* DocumentStore
      const { documentId } = yield* documents.admit(input)
      const artifacts = yield* makeArtifactStore(options.dataDirectory)
      const artifact = yield* artifacts.put(owner, documentId, content)
      const claim = yield* documents.claimNext({ workerId: "worker", leaseMilliseconds: 60000 })
      if (claim === null) return yield* Effect.die("Expected an accepted document")
      yield* documents.updateRun(claim, { _tag: "failed", finishedAt: DateTime.formatIso(yield* DateTime.now), failure: { code: "provider-failed", message: "Fixture failure", retryable: true, stage: "extraction", pageId: null, figureId: null } })
      yield* documents.delete(owner, documentId)
      expect(yield* fs.exists(path.join(options.dataDirectory, "documents", documentId))).toBe(false)
      expect((yield* artifacts.read(owner, documentId, artifact).pipe(Effect.result))._tag).toBe("Failure")
      expect((yield* artifacts.put(owner, documentId, content).pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* fs.exists(path.join(options.dataDirectory, "documents", documentId))).toBe(false)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))
})
