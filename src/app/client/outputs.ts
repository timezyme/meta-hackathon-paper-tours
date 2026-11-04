import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ApiError, boundaryParseOptions, productRoutes, RatingRequest, type CanonicalDocument, type DocumentId, type OutputParams, type ProcessingReport, type RatingValue } from "../../domain/index.ts"
import { DocumentFailure } from "./documents.ts"

export type OutputIdentity = typeof OutputParams.Type
export type OutputData = { readonly canonical: CanonicalDocument; readonly report: ProcessingReport; readonly rating: typeof RatingValue.Type | null }
export const outputUrl = (identity: OutputIdentity, action: "canonical" | "text" | "zip" | "report" | "readRating" | "rate" | "clearRating"): string => productRoutes[action].path.replace(":documentId", identity.documentId).replace(":revisionId", identity.revisionId)
export const imageUrl = (identity: OutputIdentity, figureId: string): string => productRoutes.image.path.replace(":documentId", identity.documentId).replace(":revisionId", identity.revisionId).replace(":figureId", encodeURIComponent(figureId))
export const originalUrl = (documentId: string): string => productRoutes.original.path.replace(":documentId", encodeURIComponent(documentId))
const failed = (cause: unknown) => new DocumentFailure({ kind: "transport", message: "The document request could not be completed. Please try again.", cause })
const invalid = (cause: unknown) => new DocumentFailure({ kind: "invalid-response", message: "The saved output could not be read. Please try again.", cause })
const deadline = Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.fail(new DocumentFailure({ kind: "transport", message: "The document request took too long. Please try again." })) })
const responseFor = Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest, expected: number) {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient)
  const response = yield* client.execute(request).pipe(Effect.mapError(failed))
  if (response.status === 401) return yield* new DocumentFailure({ kind: "unauthenticated", message: "Your session expired. Please sign in again.", status: 401 })
  if (response.status !== expected) {
    const json = yield* response.json.pipe(Effect.mapError(invalid))
    const error = yield* Schema.decodeUnknownEffect(ApiError)(json, boundaryParseOptions).pipe(Effect.mapError(invalid))
    return yield* new DocumentFailure({ kind: "rejected", message: response.status === 404 ? "This document is unavailable or you do not have access to it." : response.status === 410 ? "This document has expired and is no longer available." : error.message, status: response.status })
  }
  return response
})
const readJson = Effect.fnUntraced(function* <A>(url: string, schema: Schema.Decoder<A>) {
  const response = yield* responseFor(HttpClientRequest.get(url), 200)
  const json = yield* response.json.pipe(Effect.mapError(invalid))
  return yield* Schema.decodeUnknownEffect(schema)(json, boundaryParseOptions).pipe(Effect.mapError(invalid))
}, deadline, Effect.scoped)

export const readOutputs = Effect.fn("readOutputs")(function* (identity: OutputIdentity) {
  const [canonical, report, rating] = yield* Effect.all([
    readJson(outputUrl(identity, "canonical"), productRoutes.canonical.response),
    readJson(outputUrl(identity, "report"), productRoutes.report.response),
    readJson(outputUrl(identity, "readRating"), productRoutes.readRating.response),
  ], { concurrency: 3 })
  if (canonical.scope.documentId !== identity.documentId || canonical.scope.revisionId !== identity.revisionId || report.scope.documentId !== identity.documentId || report.scope.revisionId !== identity.revisionId || report.scope.runId !== canonical.scope.runId) return yield* invalid("Output revision mismatch")
  return { canonical, report, rating: rating.value }
})

export const readNormalizedText = Effect.fn("readNormalizedText")(function* (identity: OutputIdentity) {
  const response = yield* responseFor(HttpClientRequest.get(outputUrl(identity, "text")), 200)
  if (!response.headers["content-type"]?.toLowerCase().startsWith("text/plain")) return yield* invalid("Expected normalized text")
  return yield* response.text.pipe(Effect.mapError(invalid))
}, deadline, Effect.scoped)

export const copyNormalizedText = Effect.fn("copyNormalizedText")(function* (identity: OutputIdentity) {
  const text = yield* readNormalizedText(identity)
  yield* Effect.tryPromise({ try: () => navigator.clipboard.writeText(text), catch: (cause) => new DocumentFailure({ kind: "rejected", message: "Your browser could not copy the text. Download the text file instead.", cause }) }).pipe(Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(new DocumentFailure({ kind: "rejected", message: "Copying took too long. Download the text file instead." })) }))
})

export const saveRating = Effect.fn("saveRating")(function* (identity: OutputIdentity, value: typeof RatingValue.Type | null) {
  const request = value === null ? HttpClientRequest.delete(outputUrl(identity, "clearRating")) : yield* HttpClientRequest.put(outputUrl(identity, "rate")).pipe(HttpClientRequest.bodyJson({ value } satisfies typeof RatingRequest.Type), Effect.mapError(invalid))
  const response = yield* responseFor(request, value === null ? 204 : 200)
  if (value === null) return null
  const json = yield* response.json.pipe(Effect.mapError(invalid))
  return (yield* Schema.decodeUnknownEffect(productRoutes.rate.response)(json, boundaryParseOptions).pipe(Effect.mapError(invalid))).value
}, deadline, Effect.scoped)

export const deleteDocument = Effect.fn("deleteDocument")(function* (documentId: DocumentId) {
  yield* responseFor(HttpClientRequest.delete(productRoutes.delete.path.replace(":documentId", documentId)), productRoutes.delete.status)
}, deadline, Effect.scoped)
