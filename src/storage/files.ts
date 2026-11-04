import { Crypto, Effect, FileSystem, Path } from "effect"
import type { Document } from "../domain/index.ts"
import { storageFailure } from "./service.ts"

const mapError = (cause: unknown) => storageFailure("source-file", cause)
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

export const makeSourceFiles = Effect.fn("makeSourceFiles")(function* (dataDirectory: string, maxUploadBytes: number) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const base = yield* fs.realPath(dataDirectory).pipe(Effect.mapError(mapError))
  const root = path.join(base, "documents")
  yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 }).pipe(Effect.mapError(mapError))
  if ((yield* fs.realPath(root).pipe(Effect.mapError(mapError))) !== root) return yield* mapError("Document storage cannot follow a symlink")
  yield* fs.chmod(root, 0o700).pipe(Effect.mapError(mapError))
  const hash = (bytes: Uint8Array) => crypto.digest("SHA-256", bytes).pipe(Effect.map(hex), Effect.mapError(mapError))
  const identifier = () => crypto.randomUUIDv4().pipe(Effect.mapError(mapError))
  const directory = (id: string) => path.join(root, id)
  const syncDirectory = Effect.fnUntraced(function* (name: string) {
    const file = yield* fs.open(name, { flag: "r", noFollow: true })
    yield* file.sync
  }, Effect.scoped)
  yield* syncDirectory(dataDirectory).pipe(Effect.mapError(mapError))
  const remove = (id: string) => fs.remove(directory(id), { recursive: true, force: true }).pipe(Effect.mapError(mapError))
  const write = Effect.fn("SourceFiles.write")(function* (id: string, bytes: Uint8Array) {
    const target = directory(id)
    yield* fs.makeDirectory(target, { mode: 0o700 }).pipe(Effect.mapError(mapError))
    yield* Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const file = yield* fs.open(path.join(target, ".source.tmp"), { flag: "wx", mode: 0o600, noFollow: true })
        yield* file.writeAll(bytes)
        yield* file.sync
      }).pipe(Effect.scoped)
      yield* fs.rename(path.join(target, ".source.tmp"), path.join(target, "source.pdf"))
      yield* syncDirectory(target)
      yield* syncDirectory(root)
    }).pipe(Effect.mapError(mapError), Effect.onError(() => remove(id).pipe(Effect.catch(() => Effect.logWarning("Private source cleanup deferred until reconciliation")))))
  })
  const read = Effect.fn("SourceFiles.read")(function* (document: Document) {
    if ((yield* fs.realPath(directory(document.id)).pipe(Effect.mapError(mapError))) !== directory(document.id)) return yield* mapError("Document storage cannot follow a symlink")
    const bytes = yield* Effect.gen(function* () {
      const file = yield* fs.open(path.join(directory(document.id), "source.pdf"), { flag: "r", noFollow: true })
      const info = yield* file.stat
      if (info.type !== "File" || info.size !== BigInt(document.byteCount) || document.byteCount > maxUploadBytes) {
        return yield* storageFailure("source-file", "Source size does not match its durable record")
      }
      const result = new Uint8Array(document.byteCount)
      let offset = 0
      while (offset < result.byteLength) {
        const count = yield* file.read(result.subarray(offset))
        if (count === 0) return yield* storageFailure("source-file", "Source ended before its declared size")
        offset += count
      }
      return result
    }).pipe(Effect.scoped, Effect.mapError(mapError))
    if ((yield* hash(bytes)) !== document.sourceHash) return yield* storageFailure("source-file", "Source hash does not match its durable record")
    return bytes
  })
  const entries = () => fs.readDirectory(root).pipe(Effect.mapError(mapError))
  const cleanupTemporary = Effect.fn("SourceFiles.cleanupTemporary")(function* () {
    for (const [folder, pattern] of [
      ["uploads", /^upload-[A-Za-z0-9]{6}$/u],
      ["processing", /^render-[A-Za-z0-9]{6}$/u],
      ["archives", /^mineru-[A-Za-z0-9]{6}$/u],
    ] as const) {
      const parent = path.join(base, folder)
      if (!(yield* fs.exists(parent))) continue
      if ((yield* fs.realPath(parent)) !== parent) return yield* mapError("Temporary storage cannot follow a symlink")
      for (const name of yield* fs.readDirectory(parent)) {
        if (pattern.test(name)) yield* fs.remove(path.join(parent, name), { recursive: true, force: true })
      }
    }
    for (const name of yield* entries()) {
      const target = directory(name)
      const resolved = yield* fs.realPath(target).pipe(Effect.result)
      if (resolved._tag === "Failure") {
        if (resolved.failure.reason._tag === "NotFound") continue
        return yield* resolved.failure
      }
      if (resolved.success !== target || (yield* fs.stat(target)).type !== "Directory") continue
      yield* fs.remove(path.join(target, ".source.tmp"), { force: true, recursive: true })
      const objects = path.join(target, "objects")
      if (!(yield* fs.exists(objects))) continue
      if ((yield* fs.realPath(objects)) !== objects) return yield* mapError("Artifact storage cannot follow a symlink")
      for (const object of yield* fs.readDirectory(objects)) {
        if (/^\.blob-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(object)) yield* fs.remove(path.join(objects, object), { force: true, recursive: true })
      }
    }
  }, (effect) => effect.pipe(Effect.mapError(mapError)))
  return { root, hash, identifier, write, read, remove, entries, cleanupTemporary }
})
