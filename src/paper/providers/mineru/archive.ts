import { Context, Crypto, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { MineruArchiveManifest, MineruLimits, MineruMiddle } from "./contracts.ts"
import { MINERU_ARCHIVE_SCRIPT } from "./archive-script.ts"

export class MineruArchiveError extends Schema.TaggedError<MineruArchiveError>()("MineruArchiveError", {
  code: Schema.Literals(["invalid-archive", "limit-exceeded", "processing-unavailable"]),
  message: Schema.String,
}) {}
const failure = (code: MineruArchiveError["code"]) => new MineruArchiveError({ code, message: code === "limit-exceeded" ? "The MinerU archive exceeds processing limits" : code === "processing-unavailable" ? "The private archive reader requires Python 3.14 and PyMuPDF 1.28.2" : "The MinerU archive is incomplete, corrupt, or unsafe" })
export interface DecodedMineruArchive {
  readonly middle: Schema.Json
  readonly manifest: MineruArchiveManifest
  readonly assets: ReadonlyArray<MineruArchiveManifest["nativeAssets"][number] & { readonly bytes: Uint8Array }>
}
const Answer = Schema.Union([Schema.TaggedStruct("Decoded", { manifest: MineruArchiveManifest }), Schema.TaggedStruct("Rejected", { code: MineruArchiveError.fields.code })])
const collect = (stream: Stream.Stream<Uint8Array, PlatformError>) => Effect.gen(function* () {
  const chunks: Array<Uint8Array> = []
  let length = 0
  yield* stream.pipe(Stream.runForEach((chunk) => {
    length += chunk.byteLength
    if (length > 1024 * 1024) return Effect.fail(failure("limit-exceeded"))
    chunks.push(chunk)
    return Effect.void
  }), Effect.mapError((error) => error._tag === "MineruArchiveError" ? error : failure("processing-unavailable")))
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
})

export class MineruArchiveReader extends Context.Service<MineruArchiveReader, {
  readonly decode: (bytes: Uint8Array) => Effect.Effect<DecodedMineruArchive, MineruArchiveError>
}>()("amuseme/paper/MineruArchiveReader") {
  static readonly layer = (options: { readonly pythonBin: string; readonly tempDirectory: string }) => Layer.effect(MineruArchiveReader, Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const crypto = yield* Crypto.Crypto
    const decode = Effect.fn("MineruArchiveReader.decode")(function* (bytes: Uint8Array) {
      if (bytes.byteLength === 0 || bytes.byteLength > MineruLimits.maxCompressedBytes) return yield* failure("limit-exceeded")
      if (!path.isAbsolute(options.pythonBin) || !path.isAbsolute(options.tempDirectory)) return yield* failure("processing-unavailable")
      const result = yield* Effect.scoped(Effect.gen(function* () {
        const root = yield* fs.makeTempDirectoryScoped({ directory: options.tempDirectory, prefix: "mineru-" })
        yield* fs.chmod(root, 0o700)
        yield* fs.writeFile(path.join(root, "source.zip"), bytes, { flag: "wx", mode: 0o600 })
        const process = yield* spawner.spawn(ChildProcess.make(options.pythonBin, ["-I", "-c", MINERU_ARCHIVE_SCRIPT, root], { stdin: "ignore", env: {}, extendEnv: false, forceKillAfter: "100 millis" }))
        const outputs = yield* Effect.all({ stdout: collect(process.stdout), stderr: collect(process.stderr), code: process.exitCode }, { concurrency: "unbounded" })
        if (outputs.code !== 0) return yield* failure("processing-unavailable")
        const answer = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Answer))(outputs.stdout, { onExcessProperty: "error" }).pipe(Effect.mapError(() => failure("invalid-archive")))
        if (answer._tag === "Rejected") return yield* failure(answer.code)
        const verifiedRead = Effect.fnUntraced(function* (name: string, byteCount: number, expectedHash: string) {
          const file = yield* fs.open(path.join(root, name), { flag: "r", noFollow: true })
          const info = yield* file.stat
          if (info.type !== "File" || info.size !== BigInt(byteCount) || (info.mode & 0o077) !== 0 || byteCount > MineruLimits.maxExpandedBytes) return yield* failure("invalid-archive")
          const content = new Uint8Array(byteCount)
          let offset = 0
          while (offset < byteCount) {
            const read = yield* file.read(content.subarray(offset))
            if (read === 0) return yield* failure("invalid-archive")
            offset += read
          }
          const digest = yield* crypto.digest("SHA-256", content)
          if (Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") !== expectedHash) return yield* failure("invalid-archive")
          return content
        }, Effect.scoped)
        const middleFile = answer.manifest.entries.find((entry) => entry.path === answer.manifest.middlePath)
        if (middleFile?._tag !== "file") return yield* failure("invalid-archive")
        const middleBytes = yield* verifiedRead("middle.json", middleFile.byteCount, middleFile.hash)
        const middle = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(new TextDecoder("utf-8", { fatal: false }).decode(middleBytes)).pipe(Effect.mapError(() => failure("invalid-archive")))
        yield* Schema.decodeUnknownEffect(MineruMiddle)(middle).pipe(Effect.mapError(() => failure("invalid-archive")))
        const assets: Array<DecodedMineruArchive["assets"][number]> = []
        for (const [index, asset] of answer.manifest.nativeAssets.entries()) assets.push({ ...asset, bytes: yield* verifiedRead(`image-${index}`, asset.artifact.byteCount, asset.artifact.hash) })
        return { middle, manifest: answer.manifest, assets }
      })).pipe(Effect.mapError((error) => error._tag === "MineruArchiveError" ? error : failure("processing-unavailable")), Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.fail(failure("limit-exceeded")) }))
      return result
    })
    return MineruArchiveReader.of({ decode })
  }))
}
