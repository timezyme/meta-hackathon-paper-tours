import { NodeStream } from "@effect/platform-node"
import { Effect, Schema, Stream } from "effect"
import ZipStream from "zip-stream"
import { ArtifactManifest, outputFilenames, type ArtifactEntry, type DocumentId, type OutputRevisionId, type UserId } from "../domain/index.ts"
import { artifactLimits } from "./artifacts.ts"
import { OutputStore } from "./outputs.ts"
import { StorageFailure } from "./service.ts"

export const outputZipLimits = { entries: 1_000, pathCharacters: 240, chunkBytes: 64 * 1024, lifetimeMilliseconds: 300_000 } as const

const invalid = (cause: unknown) => new StorageFailure({
  code: "invalid-artifacts", operation: "output-zip", message: "The normalized download is incomplete or damaged", cause,
})
const safeManifest = ArtifactManifest.check(Schema.makeFilter((manifest) => {
  const names = manifest.entries.map((entry) => entry.path.toLowerCase())
  return manifest.entries.length <= outputZipLimits.entries
    && new Set(names).size === names.length
    && outputFilenames.every((name) => names.includes(name))
    && manifest.entries.every((entry) => entry.byteCount > 0 && entry.byteCount <= artifactLimits.objectBytes
      && entry.path.length <= outputZipLimits.pathCharacters
      && !/^images\/(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./iu.test(entry.path))
    && manifest.entries.reduce((total, entry) => total + entry.byteCount, 0) <= artifactLimits.documentBytes
    || "Output manifest exceeds ZIP safety limits or lacks required files"
}))
const sameEntry = (one: ArtifactEntry, two: ArtifactEntry) => one.path === two.path && one.hash === two.hash
  && one.byteCount === two.byteCount && one.mediaType === two.mediaType
const byteChunks = function* (bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.byteLength; offset += outputZipLimits.chunkBytes) {
    yield bytes.subarray(offset, offset + outputZipLimits.chunkBytes)
  }
}
const append = Effect.fnUntraced(function* (archive: ZipStream, entry: ArtifactEntry, bytes: Uint8Array) {
  const source = yield* Effect.acquireRelease(
    NodeStream.toReadable(Stream.fromIterable(byteChunks(bytes), { chunkSize: 1 })),
    (readable) => Effect.sync(() => { readable.destroy() }),
  )
  yield* Effect.callback<void, StorageFailure>((resume) => {
    archive.entry(source, { name: entry.path, type: "file", mode: 0o100600, date: "1980-01-01T00:00:00.000Z", store: true },
      (error) => resume(error === null ? Effect.void : Effect.fail(invalid(error))))
  })
}, Effect.scoped)

export const makeOutputZip = Effect.fn("makeOutputZip")(function* (ownerId: UserId, documentId: DocumentId, revisionId: OutputRevisionId) {
  const outputs = yield* OutputStore
  const manifest = yield* outputs.manifest(ownerId, documentId, revisionId).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(safeManifest, { onExcessProperty: "error" })), Effect.mapError((error) => error._tag === "StorageFailure" ? error : invalid(error)),
  )
  if (manifest.scope.documentId !== documentId || manifest.scope.revisionId !== revisionId) return yield* invalid("Output scope differs from the requested revision")
  const stream = Stream.unwrap(Effect.gen(function* () {
    const archive = yield* Effect.acquireRelease(
      Effect.sync(() => new ZipStream({ store: true, highWaterMark: outputZipLimits.chunkBytes })),
      (encoder) => Effect.sync(() => { encoder.destroy() }),
    )
    const produce = Effect.gen(function* () {
      for (const entry of manifest.entries) {
        const file = yield* outputs.read(ownerId, documentId, revisionId, entry.path)
        if (!sameEntry(entry, file.entry) || file.bytes.byteLength !== entry.byteCount) return yield* invalid("Output receipt changed during download")
        yield* append(archive, entry, file.bytes)
      }
      const latest = yield* outputs.manifest(ownerId, documentId, revisionId)
      if (JSON.stringify(latest) !== JSON.stringify(manifest)) return yield* invalid("Output manifest changed during download")
      yield* Effect.sync(() => { archive.finalize() })
    })
    return NodeStream.fromReadable({ evaluate: () => archive, onError: invalid, chunkSize: outputZipLimits.chunkBytes }).pipe(
      Stream.mergeEffect(produce),
      Stream.mergeEffect(Effect.sleep(outputZipLimits.lifetimeMilliseconds).pipe(Effect.andThen(Effect.fail(invalid("Output download exceeded its deadline"))))),
    )
  }))
  return { manifest, stream }
})
