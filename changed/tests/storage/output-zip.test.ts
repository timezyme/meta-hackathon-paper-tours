import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Crypto, Deferred, Effect, Fiber, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { ArtifactManifest, DocumentId, OutputRevisionId } from "../../src/domain/index.ts"
import { OutputStore, makeDocumentStoreLayer } from "../../src/storage/index.ts"
import { makeOutputZip, outputZipLimits } from "../../src/storage/output-zip.ts"
import { documentNotFound, storageFailure, type StorageFailure } from "../../src/storage/service.ts"
import { owner, other, directory, setup } from "../fixtures/published-output.ts"

const documentId = DocumentId.make("zip-document")
const revisionId = OutputRevisionId.make("zip-revision")
const encoder = new TextEncoder()
const INSPECT = String.raw`
import base64, hashlib, json, pathlib, sys, zipfile
root=pathlib.Path(sys.argv[1])
try:
    with zipfile.ZipFile(root / 'output.zip') as archive:
        assert archive.testzip() is None
        archive.extractall(root / 'extracted')
        result=[]
        for entry in archive.infolist():
            data=(root / 'extracted' / entry.filename).read_bytes()
            result.append({'path':entry.filename,'hash':hashlib.sha256(data).hexdigest(),
                'bytes':len(data),'base64':base64.b64encode(data).decode(),'compression':entry.compress_type,
                'mode':(entry.external_attr >> 16) & 0o177777,'date':list(entry.date_time)})
    print(json.dumps({'valid':True,'entries':result}))
except zipfile.BadZipFile:
    print(json.dumps({'valid':False,'entries':[]}))
`
const Inspection = Schema.Struct({ valid: Schema.Boolean, entries: Schema.Array(Schema.Struct({
  path: Schema.String, hash: Schema.String, bytes: Schema.Int, base64: Schema.String, compression: Schema.Int,
  mode: Schema.Int, date: Schema.Array(Schema.Int),
})) })
const concatenate = (chunks: readonly Uint8Array[]) => {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}
const inspect = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-zip-" })
  yield* fs.writeFile(path.join(root, "output.zip"), bytes)
  const process = yield* spawner.spawn(ChildProcess.make(path.resolve("data/python/.venv/bin/python"), ["-I", "-c", INSPECT, root]))
  const output = yield* process.stdout.pipe(Stream.decodeText(), Stream.mkString)
  expect(yield* process.exitCode).toBe(0)
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Inspection))(output)
}, Effect.scoped)
const fixture = Effect.fnUntraced(function* (text = encoder.encode("Exact UTF-8: λ, 世界, café\n\nFinal line.\n")) {
  const crypto = yield* Crypto.Crypto
  const files = [
    { path: "normalized.txt", mediaType: "text/plain; charset=utf-8", bytes: text },
    { path: "document.json", mediaType: "application/json", bytes: encoder.encode('{"title":"λ","figures":["images/native_a.png"]}\n') },
    { path: "images.json", mediaType: "application/json", bytes: encoder.encode('{"figures":["images/native_a.png"]}\n') },
    { path: "processing-report.json", mediaType: "application/json", bytes: encoder.encode('{"warnings":[]}\n') },
    { path: "images/native_a.png", mediaType: "image/png", bytes: Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")) },
  ]
  const entries = yield* Effect.forEach(files, (file) => crypto.digest("SHA-256", file.bytes).pipe(Effect.map((hash) => ({
    path: file.path, mediaType: file.mediaType, byteCount: file.bytes.byteLength,
    hash: Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  }))))
  const manifest = yield* Schema.decodeUnknownEffect(ArtifactManifest)({ schemaVersion: "1", scope: { documentId, revisionId, runId: "zip-run" }, entries })
  const reads: string[] = []
  const store = OutputStore.of({
    publish: () => Effect.fail(storageFailure("unused", undefined)), publishRepair: () => Effect.fail(storageFailure("unused", undefined)),
    rate: () => Effect.void, rating: () => Effect.succeed(null),
    manifest: (user, document, revision) => user === owner && document === documentId && revision === revisionId ? Effect.succeed(manifest) : Effect.fail(documentNotFound()),
    read: (user, document, revision, name) => Effect.gen(function* () {
      if (user !== owner || document !== documentId || revision !== revisionId) return yield* documentNotFound()
      reads.push(name)
      const entry = manifest.entries.find((item) => item.path === name)
      const file = files.find((item) => item.path === name)
      if (entry === undefined || file === undefined) return yield* documentNotFound()
      return { entry, bytes: file.bytes }
    }),
  })
  const download = (provided = store) => makeOutputZip(owner, documentId, revisionId).pipe(Effect.provideService(OutputStore, provided))
  return { files, manifest, reads, store, download }
})
const collect = (stream: Stream.Stream<Uint8Array, StorageFailure>) => stream.pipe(Stream.runCollect, Effect.map(concatenate))

describe("owner-authorized output ZIP", () => {
  it.effect("extracts exact published UTF-8, JSON, and native image bytes with matching hashes and safe metadata", () => Effect.gen(function* () {
    const f = yield* fixture()
    const download = yield* f.download()
    expect(f.reads).toEqual([])
    const bytes = yield* collect(download.stream)
    const archive = yield* inspect(bytes)
    expect(archive.valid).toBe(true)
    expect(archive.entries.map((entry) => entry.path)).toEqual(f.manifest.entries.map((entry) => entry.path))
    expect(f.reads).toEqual(f.manifest.entries.map((entry) => entry.path))
    for (const entry of archive.entries) {
      const expected = f.manifest.entries.find((item) => item.path === entry.path)
      const file = f.files.find((item) => item.path === entry.path)
      expect(entry).toMatchObject({ hash: expected?.hash, bytes: expected?.byteCount, compression: 0, mode: 0o100600, date: [1980, 1, 1, 0, 0, 0] })
      expect(Uint8Array.from(Buffer.from(entry.base64, "base64"))).toEqual(file?.bytes)
    }
    expect(yield* collect(download.stream)).toEqual(bytes)
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects foreign owners/revisions and unsafe or oversized manifests before reading bytes", () => Effect.gen(function* () {
    const f = yield* fixture()
    for (const request of [makeOutputZip(other, documentId, revisionId), makeOutputZip(owner, documentId, OutputRevisionId.make("foreign"))]) {
      expect(yield* request.pipe(Effect.provideService(OutputStore, f.store), Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: "not-found" } })
    }
    const image = f.manifest.entries.at(-1)
    if (image === undefined) return yield* Effect.die("Missing image fixture")
    const decode = Schema.decodeUnknownEffect(ArtifactManifest)
    const malformed: unknown[] = [
      ...["../source.pdf", "/tmp/secret", "images/../secret.png", "images\\escape.png", "images/%2e%2e.png", "images/a.png/secret", "images/a\u0000.png", "source.pdf", "pages/page-001.png", "response.json", "images/CON.png", "images/LpT1.jpeg", `images/${"a".repeat(240)}.png`].map((path) => ({ ...f.manifest, entries: [...f.manifest.entries, { ...image, path }] })),
      { ...f.manifest, entries: [...f.manifest.entries, image] },
      { ...f.manifest, entries: [...f.manifest.entries, { ...image, path: "images/NATIVE_A.png" }] },
      { ...f.manifest, entries: f.manifest.entries.slice(1) },
      { ...f.manifest, entries: f.manifest.entries.map((entry) => ({ ...entry, byteCount: 0 })) },
      { ...f.manifest, entries: f.manifest.entries.map((entry) => ({ ...entry, byteCount: 100 * 1024 * 1024 + 1 })) },
      { ...f.manifest, entries: [...f.manifest.entries, ...Array.from({ length: 6 }, (_, index) => ({ ...image, path: `images/large-${index}.png`, byteCount: 100 * 1024 * 1024 }))] },
      { ...f.manifest, entries: [...f.manifest.entries, ...Array.from({ length: 1_000 }, (_, index) => ({ ...image, path: `images/image-${index}.png` }))] },
      { ...f.manifest, scope: { ...f.manifest.scope, documentId: "foreign" } },
    ]
    for (const input of malformed) {
      const store = { ...f.store, manifest: () => decode(input).pipe(Effect.mapError((error) => storageFailure("fixture-manifest", error))) }
      expect((yield* f.download(store).pipe(Effect.result))._tag).toBe("Failure")
    }
    expect(f.reads).toEqual([])
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("fails without a valid ZIP when an artifact receipt or final manifest changes", () => Effect.gen(function* () {
    const f = yield* fixture()
    for (const change of ["receipt", "size", "manifest"] as const) {
      let lookups = 0
      const store = { ...f.store,
        manifest: () => { lookups += 1; return Effect.succeed(change === "manifest" && lookups > 1 ? { ...f.manifest, scope: { ...f.manifest.scope, revisionId: OutputRevisionId.make("changed") } } : f.manifest) },
        read: (user: typeof owner, document: typeof documentId, revision: typeof revisionId, name: string) => f.store.read(user, document, revision, name).pipe(Effect.map((file) => name !== "processing-report.json" ? file : change === "receipt"
          ? { ...file, entry: { ...file.entry, byteCount: file.entry.byteCount + 1 } } : change === "size" ? { ...file, bytes: file.bytes.subarray(1) } : file)),
      }
      const download = yield* f.download(store)
      const chunks: Uint8Array[] = []
      expect(yield* download.stream.pipe(Stream.runForEach((bytes) => Effect.sync(() => { chunks.push(bytes) })), Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: "invalid-artifacts" } })
      expect((yield* inspect(concatenate(chunks))).valid).toBe(false)
    }
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("uses actual private-storage authorization and fails on removed or corrupt published bytes", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const { claim, publication, outputs, documents } = yield* setup(options.dataDirectory)
      yield* outputs.publish(claim, publication)
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const request = makeOutputZip(owner, claim.document.id, publication.manifest.scope.revisionId).pipe(Effect.provideService(OutputStore, outputs))
      const archive = yield* request
      expect((yield* inspect(yield* collect(archive.stream))).valid).toBe(true)
      const entry = publication.manifest.entries.find((item) => item.path === "processing-report.json")
      if (entry === undefined) return yield* Effect.die("Missing report fixture")
      const file = path.join(options.dataDirectory, "documents", claim.document.id, "objects", entry.hash)
      const original = yield* fs.readFile(file)
      for (const corruption of ["same-size", "missing"] as const) {
        if (corruption === "same-size") yield* fs.writeFile(file, new Uint8Array(original.byteLength))
        else yield* fs.remove(file)
        const chunks: Uint8Array[] = []
        expect((yield* archive.stream.pipe(Stream.runForEach((bytes) => Effect.sync(() => { chunks.push(bytes) })), Effect.result))._tag).toBe("Failure")
        expect((yield* inspect(concatenate(chunks))).valid).toBe(false)
      }
      yield* fs.writeFile(file, original)
      const pending = yield* request
      yield* documents.delete(owner, claim.document.id)
      expect(yield* collect(pending.stream).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: "not-found" } })
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rechecks ownership on every read and never completes an archive after expiry", () => Effect.gen(function* () {
    const f = yield* fixture()
    let calls = 0
    const download = yield* f.download({ ...f.store, read: (...args) => Effect.suspend(() => {
      calls += 1
      return calls === 3 ? Effect.fail(documentNotFound()) : f.store.read(...args)
    }) })
    expect(yield* collect(download.stream).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: "not-found" } })
    expect(calls).toBe(3)
    expect(f.reads).toEqual(["normalized.txt", "document.json"])
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects an actual retained document that expires after ZIP preparation", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const { claim, publication, outputs } = yield* setup(options.dataDirectory)
      yield* outputs.publish(claim, publication)
      const download = yield* makeOutputZip(owner, claim.document.id, publication.manifest.scope.revisionId).pipe(Effect.provideService(OutputStore, outputs))
      yield* TestClock.adjust(1_001)
      expect(yield* collect(download.stream).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: "not-found" } })
    }).pipe(Effect.provide(makeDocumentStoreLayer({ ...options, retentionMilliseconds: 1_000 })))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("applies backpressure, emits bounded chunks, and stops reading on consumer cancellation", () => Effect.gen(function* () {
    const f = yield* fixture(new Uint8Array(8 * 1024 * 1024).fill(65))
    const download = yield* f.download()
    const prefix = yield* download.stream.pipe(Stream.take(1), Stream.runCollect)
    expect(prefix).toHaveLength(1)
    expect(prefix[0]?.byteLength).toBeLessThanOrEqual(outputZipLimits.chunkBytes)
    expect(f.reads).toEqual(["normalized.txt"])
    expect((yield* inspect(concatenate(prefix))).valid).toBe(false)
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("cancels an in-flight store read and has a bounded lifetime without retries", () => Effect.gen(function* () {
    const f = yield* fixture()
    for (const mode of ["cancel", "timeout"] as const) {
      const started = yield* Deferred.make<void>()
      let calls = 0
      let released = false
      const download = yield* f.download({ ...f.store, read: () => Effect.gen(function* () {
        calls += 1
        yield* Deferred.succeed(started, undefined)
        return yield* Effect.never
      }).pipe(Effect.ensuring(Effect.sync(() => { released = true }))) })
      const fiber = yield* collect(download.stream).pipe(Effect.result, Effect.forkScoped)
      yield* Deferred.await(started)
      if (mode === "cancel") yield* Fiber.interrupt(fiber)
      else {
        yield* TestClock.adjust(outputZipLimits.lifetimeMilliseconds)
        expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "Failure", failure: { code: "invalid-artifacts" } })
      }
      expect(calls).toBe(1)
      expect(released).toBe(true)
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
