import { Context, Effect, Exit, FileSystem, Layer, Path, Schema, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ArtifactHash, Page, PixelBox, SourceHash } from "../../domain/index.ts"
import { CROP_SCRIPT } from "./crop-script.ts"
import { PdfLimits } from "./limits.ts"
import { PdfRenderLimits, RENDER_SCRIPT } from "./render-script.ts"

export { PdfRenderLimits } from "./render-script.ts"

const FailureCode = Schema.Literals(["invalid-input", "unsupported-pdf", "encrypted-pdf", "limit-exceeded", "storage-failed", "processing-unavailable"])
const messages = {
  "invalid-input": "The PDF no longer matches the admitted source or page count.",
  "unsupported-pdf": "This PDF could not be rendered safely.",
  "encrypted-pdf": "This PDF is encrypted and cannot be rendered.",
  "limit-exceeded": "Page rendering exceeded its image, memory, or time limit.",
  "storage-failed": "Private page images could not be stored safely.",
  "processing-unavailable": "Page rendering requires the pinned Python and PyMuPDF runtime.",
} as const

export class PdfRenderError extends Schema.TaggedError<PdfRenderError>()("PdfRenderError", {
  code: FailureCode,
  message: Schema.String,
}) {}

const failure = (code: typeof FailureCode.Type) => new PdfRenderError({ code, message: messages[code] })

export const PdfRenderInput = Schema.Struct({
  privatePath: Schema.String.check(Schema.isMinLength(1)),
  byteCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PdfLimits.maxBytes })),
  sourceHash: SourceHash,
  pageCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PdfLimits.maxPages })),
  outputDirectory: Schema.String.check(Schema.isMinLength(1)),
  pageNumber: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PdfLimits.maxPages }))),
})
export type PdfRenderInput = typeof PdfRenderInput.Type

export const RenderedPdfPage = Schema.Struct({
  pageNumber: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PdfLimits.maxPages })),
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PdfRenderLimits.maxSidePixels })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PdfRenderLimits.maxSidePixels })),
  dpi: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(PdfRenderLimits.dpi)),
  widthPoints: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(PdfLimits.maxPageSidePoints)),
  heightPoints: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(PdfLimits.maxPageSidePoints)),
  physicalRotation: Schema.Literals([0, 90, 180, 270]),
  image: Page.fields.image,
})
export type RenderedPdfPage = typeof RenderedPdfPage.Type

const Rejected = Schema.TaggedStruct("Rejected", { code: FailureCode })
const Answer = Schema.Union([Schema.TaggedStruct("Rendered", { pages: Schema.NonEmptyArray(RenderedPdfPage) }), Rejected])

const collect = (stream: Stream.Stream<Uint8Array, PlatformError>) => stream.pipe(
  Stream.runFoldEffect(() => new Uint8Array(), (collected, chunk) => {
    if (collected.length + chunk.length > PdfRenderLimits.maxOutputBytes) return Effect.fail(failure("limit-exceeded"))
    const bytes = new Uint8Array(collected.length + chunk.length)
    bytes.set(collected)
    bytes.set(chunk, collected.length)
    return Effect.succeed(bytes)
  }),
  Effect.map((bytes) => new TextDecoder().decode(bytes)),
)

export const PdfCropInput = Schema.Struct({
  privatePath: Schema.String,
  outputPath: Schema.String,
  page: Page,
  box: PixelBox,
})
const CropOutput = Schema.Struct({ width: Schema.Int, height: Schema.Int, byteCount: Schema.Int, hash: ArtifactHash })
const CropAnswer = Schema.Union([Schema.TaggedStruct("Cropped", CropOutput.fields), Rejected])

export class PdfRenderer extends Context.Service<PdfRenderer, {
  readonly crop: (input: typeof PdfCropInput.Type) => Effect.Effect<typeof CropOutput.Type, PdfRenderError>
  readonly render: (input: PdfRenderInput) => Effect.Effect<ReadonlyArray<RenderedPdfPage>, PdfRenderError>
}>()("amuseme/paper/PdfRenderer") {
  static readonly layer = (options: { readonly pythonBin: string }) => Layer.effect(PdfRenderer, Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem

    const render = Effect.fn("PdfRenderer.render")(function* (input: PdfRenderInput) {
      const request = yield* Schema.decodeUnknownEffect(PdfRenderInput)(input, { onExcessProperty: "error" }).pipe(Effect.mapError(() => failure("invalid-input")))
      if (request.pageNumber !== undefined && request.pageNumber > request.pageCount) return yield* failure("invalid-input")
      if (![request.privatePath, request.outputDirectory].every((value) => path.isAbsolute(value) && !value.includes("\0"))) return yield* failure("invalid-input")
      if (!path.isAbsolute(options.pythonBin)) return yield* failure("processing-unavailable")
      yield* Effect.scoped(Effect.gen(function* () {
        const directory = yield* fs.open(request.outputDirectory, { flag: "r", noFollow: true })
        const info = yield* directory.stat
        if (info.type !== "Directory" || (info.mode & 0o077) !== 0) return yield* failure("storage-failed")
      })).pipe(Effect.mapError(() => failure("storage-failed")))
      const pagesDirectory = path.join(request.outputDirectory, "pages")
      return yield* Effect.acquireUseRelease(
        fs.makeDirectory(pagesDirectory, { mode: 0o700 }).pipe(Effect.mapError(() => failure("storage-failed"))),
        () => Effect.scoped(Effect.gen(function* () {
          const process = yield* spawner.spawn(ChildProcess.make(options.pythonBin, ["-I", "-c", RENDER_SCRIPT, JSON.stringify(request)], {
            stdin: "ignore", env: {}, extendEnv: false, forceKillAfter: "100 millis",
          })).pipe(Effect.mapError(() => failure("processing-unavailable")))
          const result = yield* Effect.all({ stdout: collect(process.stdout), stderr: collect(process.stderr), exitCode: process.exitCode }, { concurrency: "unbounded" }).pipe(
            Effect.mapError((error) => error._tag === "PdfRenderError" ? error : failure("processing-unavailable")),
          )
          if (result.exitCode !== 0) return yield* failure("processing-unavailable")
          const answer = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Answer))(result.stdout, { onExcessProperty: "error" }).pipe(Effect.mapError(() => failure("processing-unavailable")))
          if (answer._tag === "Rejected") return yield* failure(answer.code)
          if (answer.pages.length !== (request.pageNumber === undefined ? request.pageCount : 1) || answer.pages.some((page, index) => page.pageNumber !== (request.pageNumber ?? index + 1) || page.image.path !== `pages/page-${String(request.pageNumber ?? index + 1).padStart(3, "0")}.png` || page.image.byteCount > PdfRenderLimits.maxImageBytes || Math.abs(page.width - page.widthPoints * page.dpi / 72) > 1 || Math.abs(page.height - page.heightPoints * page.dpi / 72) > 1) || answer.pages.reduce((total, page) => total + page.image.byteCount, 0) > PdfRenderLimits.maxTotalImageBytes) return yield* failure("processing-unavailable")
          return answer.pages
        })).pipe(Effect.timeoutOrElse({ duration: PdfRenderLimits.timeoutMs, orElse: () => Effect.fail(failure("limit-exceeded")) })),
        (_, exit) => Exit.isSuccess(exit) ? Effect.void : fs.remove(pagesDirectory, { recursive: true, force: true }).pipe(Effect.orDie),
      )
    })
    const crop = Effect.fn("PdfRenderer.crop")(function* (input: typeof PdfCropInput.Type) {
      const request = yield* Schema.decodeUnknownEffect(PdfCropInput)(input, { onExcessProperty: "error" }).pipe(Effect.mapError(() => failure("invalid-input")))
      const { box, page } = request
      const safePaths = [request.privatePath, request.outputPath].every((value) => path.isAbsolute(value) && !value.includes("\0")) && path.isAbsolute(options.pythonBin)
      const integerBox = [box.x, box.y, box.width, box.height].every(Number.isSafeInteger)
      if (!safePaths || !integerBox || box.x + box.width > page.width || box.y + box.height > page.height) return yield* failure("invalid-input")
      return yield* Effect.scoped(Effect.gen(function* () {
        const process = yield* spawner.spawn(ChildProcess.make(options.pythonBin, ["-I", "-c", CROP_SCRIPT, JSON.stringify(request)], {
          stdin: "ignore", env: {}, extendEnv: false, forceKillAfter: "100 millis",
        })).pipe(Effect.mapError(() => failure("processing-unavailable")))
        const result = yield* Effect.all({ stdout: collect(process.stdout), stderr: collect(process.stderr), exitCode: process.exitCode }, { concurrency: "unbounded" })
          .pipe(Effect.mapError(() => failure("processing-unavailable")))
        if (result.exitCode !== 0) return yield* failure("processing-unavailable")
        const answer = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CropAnswer))(result.stdout, { onExcessProperty: "error" })
          .pipe(Effect.mapError(() => failure("invalid-input")))
        if (answer._tag === "Rejected") return yield* failure(answer.code)
        const { _tag, ...output } = answer
        if (output.width !== box.width || output.height !== box.height || output.byteCount <= 0 || output.byteCount > PdfRenderLimits.maxImageBytes) {
          return yield* failure("invalid-input")
        }
        return output
      })).pipe(Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.fail(failure("limit-exceeded")) }))
    })
    return PdfRenderer.of({ render, crop })
  }))
}
