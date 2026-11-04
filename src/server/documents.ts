import { Context, Effect, FileSystem, Layer, Option, Path, Schema, Semaphore } from "effect"
import { AuthService } from "../auth/index.ts"
import { AcceptedRun, AdmissionHeaders, ApiError, DocumentDetail, DocumentId, DocumentList, FailureCode, NonBlank, RetryRequest, Run, RunConfiguration, UploadPolicy, errorHttpStatus, type UserId } from "../domain/index.ts"
import { PdfInspector, PdfLimits } from "../paper/pdf/index.ts"
import { DocumentStore } from "../storage/index.ts"
import { RunRecovery } from "../processing/index.ts"
import { readSmallJson } from "./small-json.ts"
import { UploadInputError, parseUpload } from "./upload-body.ts"

export const AdmissionConfiguration = Schema.TaggedUnion({
  disabled: { reason: NonBlank },
  fixture: { pipelineVersion: NonBlank, configuration: RunConfiguration },
  live: { pipelineVersion: NonBlank, configuration: RunConfiguration },
})
export type AdmissionConfiguration = typeof AdmissionConfiguration.Type
export type DocumentOperation = "upload" | "list" | "detail" | "status" | "original" | "delete" | "retry"
export type RunDocumentRequest = (operation: DocumentOperation, request: Request, documentId?: string) => Response | Promise<Response>

export interface DocumentHandlerOptions {
  readonly origin: string
  readonly temporaryDirectory: string
  readonly admissionConfiguration: AdmissionConfiguration
}

const errorResponse = (code: typeof FailureCode.Type, message: string) => Schema.encodeEffect(ApiError)({ code, message }).pipe(
  Effect.map((payload) => Response.json(payload, { status: errorHttpStatus[code], headers: { "cache-control": "no-store" } })),
  Effect.orDie,
)

const jsonResponse = <A>(schema: Schema.Codec<A, unknown>, value: A, status = 200) => Schema.encodeEffect(schema)(value).pipe(
  Effect.map((payload) => Response.json(payload, { status, headers: { "cache-control": "no-store" } })),
)

const attachment = (name: string) => `attachment; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(name).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`

export class DocumentHandler extends Context.Service<DocumentHandler, {
  readonly handle: (operation: DocumentOperation, request: Request, documentId?: string) => Effect.Effect<Response>
}>()("amuseme/server/DocumentHandler") {
  static readonly layer = (options: DocumentHandlerOptions) => Layer.effect(DocumentHandler, Effect.gen(function* () {
    const auth = yield* AuthService
    const store = yield* DocumentStore
    const recovery = yield* Effect.serviceOption(RunRecovery)
    const inspector = yield* PdfInspector
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const intake = yield* Semaphore.make(1)
    const admission = yield* Schema.decodeUnknownEffect(AdmissionConfiguration)(options.admissionConfiguration, { onExcessProperty: "error" })
    const upload = yield* Schema.decodeUnknownEffect(UploadPolicy)({
      maxBytes: PdfLimits.maxBytes,
      maxPages: PdfLimits.maxPages,
      mediaType: "application/pdf",
      mode: admission._tag === "fixture" ? "fixture" : "live",
      availability: admission._tag !== "disabled" ? { _tag: "enabled" } : { _tag: "disabled", reason: admission.reason },
    })
    yield* fs.makeDirectory(options.temporaryDirectory, { recursive: true, mode: 0o700 })
    yield* fs.chmod(options.temporaryDirectory, 0o700)

    const admit = Effect.fn("DocumentHandler.admit")(function* (request: Request, ownerId: UserId) {
      if (admission._tag === "disabled") return yield* errorResponse("processing-unavailable", admission.reason)
      const result = yield* Effect.gen(function* () {
        const parsed = yield* parseUpload(request, PdfLimits.maxBytes)
        const directory = yield* fs.makeTempDirectoryScoped({ directory: options.temporaryDirectory, prefix: "upload-" })
        yield* fs.chmod(directory, 0o700)
        const privatePath = path.join(directory, "source.pdf")
        yield* fs.writeFile(privatePath, parsed.bytes, { flag: "wx", mode: 0o600 })
        const inspected = yield* inspector.inspect({ privatePath, byteCount: parsed.bytes.byteLength })
        const accepted = yield* store.admit({
          ownerId, idempotencyKey: parsed.idempotencyKey, originalFilename: parsed.filename,
          bytes: parsed.bytes, pageCount: inspected.pageCount,
          pipelineVersion: admission.pipelineVersion, configuration: admission.configuration,
        })
        return yield* jsonResponse(AcceptedRun, accepted, 202)
      }).pipe(Effect.scoped, intake.withPermitsIfAvailable(1))
      return Option.isSome(result) ? result.value : yield* errorResponse("queue-full", "Another upload is being checked. Try again shortly.")
    })

    const handle = Effect.fn("DocumentHandler.handle")(function* (operation: DocumentOperation, request: Request, documentId?: string) {
      if (new URL(request.url).origin !== options.origin) return yield* errorResponse("forbidden", "Request origin is not allowed")
      const expectedMethod = (operation === "upload" || operation === "retry") ? "POST" : operation === "delete" ? "DELETE" : "GET"
      if (request.method !== expectedMethod) return yield* errorResponse("not-found", "Document route not found")
      const session = yield* auth.getSession(request.headers).pipe(Effect.timeout("5 seconds"))
      if (session === null) return yield* errorResponse("unauthenticated", "Sign in to continue")
      if (operation === "upload" || operation === "delete" || operation === "retry") {
        if (request.headers.get("origin") !== options.origin || request.headers.get("sec-fetch-site") === "cross-site") {
          return yield* errorResponse("forbidden", "Same-origin request required")
        }
        if (operation === "upload") return yield* admit(request, session.user.id)
      }
      if (operation === "list") return yield* jsonResponse(DocumentList, { documents: yield* store.list(session.user.id), upload })
      const id = yield* Schema.decodeUnknownEffect(DocumentId)(documentId).pipe(
        Effect.mapError(() => new UploadInputError({ code: "invalid-input", message: "Invalid document ID" })),
      )
      if (operation === "retry") {
        yield* store.detail(session.user.id, id)
        if (admission._tag === "disabled" || Option.isNone(recovery)) return yield* errorResponse("processing-unavailable", "Document retries are not configured")
        const headers = yield* Schema.decodeUnknownEffect(AdmissionHeaders)({ "idempotency-key": request.headers.get("idempotency-key") }).pipe(Effect.mapError(() => new UploadInputError({ code: "invalid-input", message: "The retry submission ID is missing or invalid" })))
        const body = yield* readSmallJson(request, RetryRequest)
        const accepted = yield* recovery.value.requestRetry({ ownerId: session.user.id, documentId: id, previousRunId: body.previousRunId, idempotencyKey: headers["idempotency-key"], acknowledgesUnknownCompletion: body.acknowledgePossibleRepeatedWork })
        return yield* jsonResponse(AcceptedRun, accepted, 202)
      }
      if (operation === "delete") {
        yield* store.delete(session.user.id, id)
        return new Response(null, { status: 204, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } })
      }
      if (operation === "detail") return yield* jsonResponse(DocumentDetail, yield* store.detail(session.user.id, id))
      if (operation === "status") return yield* jsonResponse(Run, yield* store.status(session.user.id, id))
      const { document, bytes } = yield* store.original(session.user.id, id)
      return new Response(bytes, { headers: {
        "content-type": "application/pdf", "content-length": String(bytes.byteLength),
        "content-disposition": attachment(document.originalFilename), "cache-control": "no-store", "x-content-type-options": "nosniff",
      } })
    }, (effect) => effect.pipe(
      Effect.catchTag("UploadInputError", (error) => errorResponse(error.code, error.message)),
      Effect.catchTag("PdfAdmissionError", (error) => errorResponse(error.code, error.message)),
      Effect.catchTag("ExecutionFailure", (error) => errorResponse(error.code, error.message)),
      Effect.catchTag("StorageFailure", (error) => errorResponse(error.code, error.message)),
      Effect.catchTag("PlatformError", () => errorResponse("storage-failed", "The private upload could not be stored. Try again.")),
      Effect.catchTag("AuthError", () => errorResponse("processing-unavailable", "Session service unavailable")),
      Effect.catchTag("TimeoutError", () => errorResponse("processing-unavailable", "Session service unavailable")),
      Effect.catchTag("SchemaError", () => errorResponse("internal-error", "The stored document response is invalid")),
      Effect.catchDefect((cause) => Effect.logError("Unexpected document request failure", cause).pipe(Effect.andThen(errorResponse("internal-error", "The document request failed")))),
    ))
    return DocumentHandler.of({ handle })
  }))
}
