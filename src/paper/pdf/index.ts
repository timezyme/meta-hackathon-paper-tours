import { Context, Effect, Layer, Path, Schema, Stream, Struct } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { PdfLimits } from "./limits.ts"
import { INSPECTION_SCRIPT } from "./script.ts"

export { PdfLimits, PYTHON_VERSION, PYMUPDF_VERSION } from "./limits.ts"
export { PdfRenderer, PdfRenderError, PdfRenderInput, PdfRenderLimits, RenderedPdfPage } from "./render.ts"

const FailureCode = Schema.Literals(["invalid-input", "unsupported-pdf", "encrypted-pdf", "empty-document", "limit-exceeded", "storage-failed", "processing-unavailable"])

const failureMessages = {
  "invalid-input": "The uploaded file does not match its staged content.",
  "unsupported-pdf": "This PDF cannot be read safely. Upload a readable PDF copy.",
  "encrypted-pdf": "This PDF is encrypted. Upload a copy without encryption.",
  "empty-document": "This PDF has no document content.",
  "limit-exceeded": "This PDF exceeds the upload, page, or inspection resource limits.",
  "storage-failed": "The private upload could not be read. Try the upload again.",
  "processing-unavailable": "PDF inspection is unavailable. The server needs Python 3.14 and PyMuPDF 1.28.2.",
} as const

export class PdfAdmissionError extends Schema.TaggedError<PdfAdmissionError>()("PdfAdmissionError", {
  code: FailureCode,
  message: Schema.String,
}) {}

const failure = (code: typeof FailureCode.Type) => new PdfAdmissionError({ code, message: failureMessages[code] })

export const PdfInspectionInput = Schema.Struct({
  privatePath: Schema.String.check(Schema.isMinLength(1)),
  byteCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type PdfInspectionInput = typeof PdfInspectionInput.Type

const PageInspection = Schema.Struct({
  pageNumber: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PdfLimits.maxPages })),
  widthPoints: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(PdfLimits.maxPageSidePoints)),
  heightPoints: Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(PdfLimits.maxPageSidePoints)),
  rotation: Schema.Literals([0, 90, 180, 270]),
})

export const PdfInspection = Schema.Struct({
  pageCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PdfLimits.maxPages })),
  pages: Schema.NonEmptyArray(PageInspection),
  repaired: Schema.Boolean,
}).check(Schema.makeFilter((value) => value.pages.length === value.pageCount && value.pages.every((page, index) => page.pageNumber === index + 1) || "PDF pages must be complete and ordered"))
export type PdfInspection = typeof PdfInspection.Type

const ScriptAnswer = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Inspected"), ...PdfInspection.fields }),
  Schema.Struct({ _tag: Schema.Literal("Rejected"), code: FailureCode }),
])

const collectPdfOutput = (output: Stream.Stream<Uint8Array, PlatformError>) => output.pipe(
  Stream.runFoldEffect(() => new Uint8Array(), (collected, chunk) => {
    if (collected.length + chunk.length > PdfLimits.maxOutputBytes) return Effect.fail(failure("limit-exceeded"))
    const combined = new Uint8Array(collected.length + chunk.length)
    combined.set(collected)
    combined.set(chunk, collected.length)
    return Effect.succeed(combined)
  }),
  Effect.map((bytes) => new TextDecoder().decode(bytes)),
)

export class PdfInspector extends Context.Service<PdfInspector, {
  readonly inspect: (input: PdfInspectionInput) => Effect.Effect<PdfInspection, PdfAdmissionError>
}>()("amuseme/paper/PdfInspector") {
  static readonly layer = (options: { readonly pythonBin: string }) => Layer.effect(PdfInspector, Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const path = yield* Path.Path

    const inspect = Effect.fn("PdfInspector.inspect")(function* (input: PdfInspectionInput) {
      const request = yield* Schema.decodeUnknownEffect(PdfInspectionInput)(input).pipe(Effect.mapError(() => failure("invalid-input")))
      if (!path.isAbsolute(request.privatePath) || request.privatePath.includes("\0")) return yield* failure("invalid-input")
      if (request.byteCount > PdfLimits.maxBytes) return yield* failure("limit-exceeded")
      if (!path.isAbsolute(options.pythonBin)) return yield* failure("processing-unavailable")
      const result = yield* Effect.scoped(Effect.gen(function* () {
        const process = yield* spawner.spawn(ChildProcess.make(options.pythonBin, ["-I", "-c", INSPECTION_SCRIPT, JSON.stringify(request)], {
          stdin: "ignore",
          env: {},
          extendEnv: false,
          forceKillAfter: "100 millis",
        })).pipe(Effect.mapError(() => failure("processing-unavailable")))
        return yield* Effect.all({ stdout: collectPdfOutput(process.stdout), stderr: collectPdfOutput(process.stderr), exitCode: process.exitCode }, { concurrency: "unbounded" }).pipe(
          Effect.mapError((error) => error._tag === "PdfAdmissionError" ? error : failure("limit-exceeded")),
        )
      })).pipe(Effect.timeoutOrElse({ duration: PdfLimits.timeoutMs, orElse: () => Effect.fail(failure("limit-exceeded")) }))
      if (result.exitCode !== 0) return yield* failure("processing-unavailable")
      const answer = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ScriptAnswer))(result.stdout, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => failure("processing-unavailable")),
      )
      if (answer._tag === "Rejected") return yield* failure(answer.code)
      return yield* Schema.decodeUnknownEffect(PdfInspection)(Struct.omit(answer, ["_tag"])).pipe(Effect.mapError(() => failure("processing-unavailable")))
    })
    return PdfInspector.of({ inspect })
  }))
}
