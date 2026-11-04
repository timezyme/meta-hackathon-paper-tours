import { Context, Crypto, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect"
import { ArtifactHash, Count, DocumentId, UserId } from "../domain/index.ts"
import { DocumentStore, StorageFailure, storageFailure } from "./service.ts"

export const PrivateArtifact = Schema.Struct({ hash: ArtifactHash, byteCount: Count })
export type PrivateArtifact = typeof PrivateArtifact.Type
export const artifactLimits = { objectBytes: 100 * 1024 * 1024, documentBytes: 512 * 1024 * 1024 } as const

export class ArtifactStore extends Context.Service<ArtifactStore, {
  readonly put: (ownerId: UserId, documentId: DocumentId, bytes: Uint8Array) => Effect.Effect<PrivateArtifact, StorageFailure>
  readonly read: (ownerId: UserId, documentId: DocumentId, artifact: PrivateArtifact) => Effect.Effect<Uint8Array, StorageFailure>
}>()("amuseme/storage/ArtifactStore") {}

const failed = (cause: unknown) => storageFailure("private-artifact", cause)
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

export const makeArtifactStore = Effect.fn("makeArtifactStore")(function* (dataDirectory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const documents = yield* DocumentStore
  const gate = yield* Semaphore.make(1)
  const root = yield* fs.realPath(dataDirectory).pipe(Effect.mapError(failed))
  const digest = (bytes: Uint8Array) => crypto.digest("SHA-256", bytes).pipe(
    Effect.map(hex), Effect.flatMap(Schema.decodeUnknownEffect(ArtifactHash)), Effect.mapError(failed),
  )
  const sync = Effect.fnUntraced(function* (directory: string) {
    const handle = yield* fs.open(directory, { flag: "r", noFollow: true })
    yield* handle.sync
  }, Effect.scoped)
  const directory = Effect.fnUntraced(function* (documentId: DocumentId, create: boolean) {
    const parent = path.join(root, "documents", documentId)
    if ((yield* fs.realPath(parent)) !== parent) return yield* failed("Document storage cannot follow a symlink")
    const target = path.join(parent, "objects")
    if (create && !(yield* fs.exists(target))) {
      yield* fs.makeDirectory(target, { mode: 0o700 })
      yield* sync(parent)
    }
    if ((yield* fs.realPath(target)) !== target) return yield* failed("Artifact storage cannot follow a symlink")
    return target
  })
  const readBytes = Effect.fnUntraced(function* (objectDirectory: string, artifact: PrivateArtifact) {
    const file = yield* fs.open(path.join(objectDirectory, artifact.hash), { flag: "r", noFollow: true })
    const info = yield* file.stat
    if (info.type !== "File" || info.size !== BigInt(artifact.byteCount) || artifact.byteCount > artifactLimits.objectBytes) {
      return yield* failed("Artifact size or type differs from its receipt")
    }
    const bytes = new Uint8Array(artifact.byteCount)
    let offset = 0
    while (offset < bytes.byteLength) {
      const count = yield* file.read(bytes.subarray(offset))
      if (count === 0) return yield* failed("Artifact ended before its declared size")
      offset += count
    }
    if ((yield* digest(bytes)) !== artifact.hash) return yield* failed("Artifact hash differs from its receipt")
    return bytes
  }, Effect.scoped)
  const read = Effect.fn("ArtifactStore.read")(function* (ownerId: UserId, documentId: DocumentId, input: PrivateArtifact) {
    yield* documents.detail(ownerId, documentId)
    const artifact = yield* Schema.decodeUnknownEffect(PrivateArtifact)(input, { onExcessProperty: "error" })
    const bytes = yield* readBytes(yield* directory(documentId, false), artifact)
    yield* documents.detail(ownerId, documentId)
    return bytes
  }, (effect) => effect.pipe(Effect.mapError((error) => error._tag === "StorageFailure" ? error : failed(error))))
  const put = Effect.fn("ArtifactStore.put")(function* (ownerId: UserId, documentId: DocumentId, input: Uint8Array) {
    yield* documents.detail(ownerId, documentId)
    if (input.byteLength > artifactLimits.objectBytes) return yield* failed("Artifact exceeds the object byte limit")
    const bytes = new Uint8Array(input)
    const artifact = { hash: yield* digest(bytes), byteCount: bytes.byteLength }
    const target = yield* directory(documentId, true)
    const destination = path.join(target, artifact.hash)
    if (yield* fs.exists(destination)) {
      yield* readBytes(target, artifact)
    } else {
      let total = 0n
      for (const name of yield* fs.readDirectory(target)) {
        if (/^[a-f0-9]{64}$/u.test(name)) total += (yield* fs.stat(path.join(target, name))).size
      }
      if (total + BigInt(bytes.byteLength) > BigInt(artifactLimits.documentBytes)) return yield* failed("Document exceeds its private artifact allowance")
      const temporary = path.join(target, `.blob-${yield* crypto.randomUUIDv4()}`)
      yield* Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const file = yield* fs.open(temporary, { flag: "wx", mode: 0o600, noFollow: true })
          yield* file.writeAll(bytes)
          yield* file.sync
        }).pipe(Effect.scoped)
        yield* fs.link(temporary, destination)
        yield* sync(target)
      }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.catch(() => Effect.logWarning("Private artifact temporary cleanup deferred")))))
    }
    yield* documents.detail(ownerId, documentId)
    return artifact
  }, (effect) => gate.withPermit(effect).pipe(Effect.mapError((error) => error._tag === "StorageFailure" ? error : failed(error))))
  return ArtifactStore.of({ put, read })
})

export const makeArtifactStoreLayer = (dataDirectory: string) => Layer.effect(ArtifactStore, makeArtifactStore(dataDirectory))
