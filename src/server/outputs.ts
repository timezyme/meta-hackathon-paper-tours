import { Context, Effect, Layer, Schema, Stream } from "effect"
import { AuthService } from "../auth/index.ts"
import { CanonicalDocument, FigureId, OutputParams, ProcessingReport, RatingRequest, errorHttpStatus, type FailureCode } from "../domain/index.ts"
import { OutputStore, StorageFailure } from "../storage/index.ts"
import { makeOutputZip } from "../storage/output-zip.ts"

export type OutputOperation = "canonical" | "text" | "zip" | "image" | "report" | "readRating" | "rate" | "clearRating"
export type RunOutputRequest = (operation: OutputOperation, request: Request, documentId?: string, revisionId?: string, figureId?: string) => Response | Promise<Response>
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" }
const error = (code: FailureCode, message: string) => Response.json({ code, message }, { status: errorHttpStatus[code], headers })
const invalid = () => error("invalid-input", "Invalid output request")
const readRatingBody = (request: Request) => request.body === null ? Effect.succeed("") : Stream.fromReadableStream({ evaluate: () => request.body!, onError: () => "Invalid rating request" }).pipe(
  Stream.runFoldEffect(() => new Uint8Array(), (collected, chunk) => {
    if (collected.byteLength + chunk.byteLength > 1024) return Effect.fail("Rating request is too large")
    const bytes = new Uint8Array(collected.byteLength + chunk.byteLength)
    bytes.set(collected)
    bytes.set(chunk, collected.byteLength)
    return Effect.succeed(bytes)
  }),
  Effect.map((bytes) => new TextDecoder().decode(bytes)),
  Effect.timeout("5 seconds"),
)

export class OutputHandler extends Context.Service<OutputHandler, {
  readonly handle: (operation: OutputOperation, request: Request, documentId?: string, revisionId?: string, figureId?: string) => Effect.Effect<Response>
}>()("amuseme/server/OutputHandler") {
  static readonly layer = (origin: string) => Layer.effect(OutputHandler, Effect.gen(function* () {
    const auth = yield* AuthService
    const outputs = yield* OutputStore
    const handle = Effect.fn("OutputHandler.handle")(function* (operation: OutputOperation, request: Request, documentId?: string, revisionId?: string, figureId?: string) {
      if (new URL(request.url).origin !== origin) return error("forbidden", "Request origin is not allowed")
      const method = operation === "rate" ? "PUT" : operation === "clearRating" ? "DELETE" : "GET"
      if (request.method !== method) return error("not-found", "Output route not found")
      const session = yield* auth.getSession(request.headers).pipe(Effect.timeout("5 seconds"))
      if (session === null) return error("unauthenticated", "Sign in to continue")
      const decoded = yield* Schema.decodeUnknownEffect(OutputParams)({ documentId, revisionId }).pipe(Effect.result)
      if (decoded._tag === "Failure") return invalid()
      const { documentId: id, revisionId: revision } = decoded.success
      const owner = session.user.id
      if (operation === "rate" || operation === "clearRating") {
        if (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site") return error("forbidden", "Same-origin request required")
        if (operation === "clearRating") {
          yield* outputs.rate(owner, id, revision, null)
          return new Response(null, { status: 204, headers })
        }
        if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return invalid()
        const body = yield* readRatingBody(request).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RatingRequest))), Effect.result)
        if (body._tag === "Failure") return invalid()
        yield* outputs.rate(owner, id, revision, body.success.value)
        return Response.json({ value: body.success.value }, { headers })
      }
      if (operation === "readRating") return Response.json({ value: yield* outputs.rating(owner, id, revision) }, { headers })
      if (operation === "zip") {
        const archive = yield* makeOutputZip(owner, id, revision).pipe(Effect.provideService(OutputStore, outputs))
        const stopped = Effect.callback<never, StorageFailure>((resume) => {
          const abort = () => resume(Effect.fail(new StorageFailure({ code: "storage-failed", operation: "output-zip", message: "The download was canceled", cause: undefined })))
          if (request.signal.aborted) abort()
          else request.signal.addEventListener("abort", abort, { once: true })
          return Effect.sync(() => request.signal.removeEventListener("abort", abort))
        })
        const stream = yield* Stream.toReadableStreamEffect(archive.stream.pipe(Stream.mergeEffect(stopped)))
        return new Response(stream, { headers: { ...headers, "content-type": "application/zip", "content-disposition": 'attachment; filename="amuseme-document.zip"' } })
      }
      if (operation === "image") {
        const figure = yield* Schema.decodeUnknownEffect(FigureId)(figureId).pipe(Effect.result)
        if (figure._tag === "Failure") return invalid()
        const stored = yield* outputs.read(owner, id, revision, "document.json")
        const canonical = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CanonicalDocument))(new TextDecoder().decode(stored.bytes))
        const found = canonical.figures.find((item) => item.id === figure.success)
        if (found?.asset._tag !== "available") return error("not-found", "Image is unavailable")
        const image = yield* outputs.read(owner, id, revision, found.asset.artifact.path)
        return new Response(image.bytes, { headers: { ...headers, "content-type": image.entry.mediaType, "content-length": String(image.bytes.length), "content-disposition": "inline" } })
      }
      const filename = operation === "canonical" ? "document.json" : operation === "report" ? "processing-report.json" : "normalized.txt"
      const file = yield* outputs.read(owner, id, revision, filename)
      if (operation === "canonical") yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CanonicalDocument))(new TextDecoder().decode(file.bytes))
      if (operation === "report") yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProcessingReport))(new TextDecoder().decode(file.bytes))
      return new Response(file.bytes, { headers: { ...headers, "content-type": file.entry.mediaType, "content-length": String(file.bytes.length), "content-disposition": `attachment; filename="${filename}"` } })
    }, (effect) => effect.pipe(
      Effect.catchTag("StorageFailure", (failure) => Effect.succeed(error(failure.code, failure.message))),
      Effect.catchTag("AuthError", () => Effect.succeed(error("processing-unavailable", "Session service unavailable"))),
      Effect.catchTag("TimeoutError", () => Effect.succeed(error("processing-unavailable", "Session service unavailable"))),
      Effect.catchTag("SchemaError", () => Effect.succeed(error("invalid-artifacts", "The normalized output is incomplete or damaged"))),
      Effect.catchDefect(() => Effect.succeed(error("internal-error", "The output request failed"))),
    ))
    return OutputHandler.of({ handle })
  }))
}
