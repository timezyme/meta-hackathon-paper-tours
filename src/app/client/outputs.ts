import { Effect, type Schema } from "effect"
import { HttpClientRequest } from "effect/http"
import {
  productRoutes, RatingRequest, validGuideSources,
  type CanonicalDocument, type DocumentId, type OutputParams, type ProcessingReport, type RatingValue,
} from "../../domain/index.ts"
import { DocumentFailure, makeHttp } from "./http.ts"

export type OutputIdentity = typeof OutputParams.Type
export type OutputData = { readonly canonical: CanonicalDocument; readonly report: ProcessingReport; readonly rating: typeof RatingValue.Type | null }
type OutputAction = "canonical" | "text" | "zip" | "report" | "readRating" | "rate" | "clearRating"
const outputPath = (path: string, identity: OutputIdentity): string =>
  path.replace(":documentId", identity.documentId).replace(":revisionId", identity.revisionId)
export const outputUrl = (identity: OutputIdentity, action: OutputAction): string => outputPath(productRoutes[action].path, identity)
export const imageUrl = (identity: OutputIdentity, figureId: string): string =>
  outputPath(productRoutes.image.path, identity).replace(":figureId", encodeURIComponent(figureId))
export const textDownloadName = (documentId: string): string => `amuseme-${documentId.slice(0, 8)}.txt`
export const originalUrl = (documentId: string): string => productRoutes.original.path.replace(":documentId", encodeURIComponent(documentId))
export const previewUrl = (documentId: string, page: number): string =>
  `${productRoutes.preview.path.replace(":documentId", encodeURIComponent(documentId))}?page=${page}`

const unreadableOutput = "The saved output could not be read. Please try again."
const rejectedMessage = (status: number, serverMessage: string): string => {
  if (status === 404) return "This document is unavailable or you do not have access to it."
  if (status === 410) return "This document has expired and is no longer available."
  return serverMessage
}
const { deadline, respond, decodeJson, requestJson, invalid } = makeHttp({
  unreachable: "The document request could not be completed. Please try again.",
  timedOut: "The document request took too long. Please try again.",
  unreadable: unreadableOutput,
  unexpectedError: unreadableOutput,
  invalidData: unreadableOutput,
  rejected: rejectedMessage,
})
const mismatch = invalid(unreadableOutput)
const readJson = <A>(url: string, schema: Schema.Decoder<A>) => requestJson(HttpClientRequest.get(url), schema, 200)

const sameRevision = (identity: OutputIdentity, canonical: CanonicalDocument, report: ProcessingReport): boolean =>
  canonical.scope.documentId === identity.documentId && canonical.scope.revisionId === identity.revisionId
  && report.scope.documentId === identity.documentId && report.scope.revisionId === identity.revisionId && report.scope.runId === canonical.scope.runId
const acceptedGuideReceipt = (identity: OutputIdentity, canonical: CanonicalDocument, report: ProcessingReport): boolean => {
  const guide = canonical.guide
  if (guide === undefined) return true
  const receipt = report.receipts.find((item) => item.receipt.id === guide.providerAttemptId)?.receipt
  return validGuideSources(guide, canonical.sourceBlocks) && receipt?.stage === "guide" && receipt.scope.documentId === identity.documentId
    && receipt.scope.sourceHash === canonical.sourceHash && receipt.state._tag === "completed" && receipt.state.validation._tag === "accepted"
}

export const readPublishedDocument = Effect.fn("readPublishedDocument")(function* (identity: OutputIdentity) {
  const [canonical, report] = yield* Effect.all([
    readJson(outputUrl(identity, "canonical"), productRoutes.canonical.response),
    readJson(outputUrl(identity, "report"), productRoutes.report.response),
  ], { concurrency: 2 })
  if (!sameRevision(identity, canonical, report)) return yield* mismatch("Output revision mismatch")
  if (!acceptedGuideReceipt(identity, canonical, report)) return yield* mismatch("Reading guide evidence or receipt mismatch")
  return { canonical, report }
})

export const readOutputs = Effect.fn("readOutputs")(function* (identity: OutputIdentity) {
  const [publication, rating] = yield* Effect.all([
    readPublishedDocument(identity),
    readJson(outputUrl(identity, "readRating"), productRoutes.readRating.response),
  ], { concurrency: 2 })
  return { ...publication, rating: rating.value }
})

export const readNormalizedText = Effect.fn("readNormalizedText")(function* (identity: OutputIdentity) {
  const response = yield* respond(HttpClientRequest.get(outputUrl(identity, "text")), 200)
  if (!response.headers["content-type"]?.toLowerCase().startsWith("text/plain")) return yield* mismatch("Expected normalized text")
  return yield* response.text.pipe(Effect.mapError(mismatch))
}, deadline, Effect.scoped)

const clipboardFailure = (cause: unknown) =>
  new DocumentFailure({ kind: "rejected", message: "Your browser could not copy the text. Download the text file instead.", cause })
const clipboardDeadline = Effect.timeoutOrElse({
  duration: "10 seconds",
  orElse: () => Effect.fail(new DocumentFailure({ kind: "rejected", message: "Copying took too long. Download the text file instead." })),
})

export const copyNormalizedText = Effect.fn("copyNormalizedText")(function* (identity: OutputIdentity) {
  const text = yield* readNormalizedText(identity)
  yield* Effect.tryPromise({ try: () => navigator.clipboard.writeText(text), catch: clipboardFailure }).pipe(clipboardDeadline)
})

const ratingRequest = (identity: OutputIdentity, value: typeof RatingValue.Type | null) => value === null
  ? Effect.succeed(HttpClientRequest.delete(outputUrl(identity, "clearRating")))
  : HttpClientRequest.put(outputUrl(identity, "rate")).pipe(
    HttpClientRequest.bodyJson({ value } satisfies typeof RatingRequest.Type), Effect.mapError(mismatch),
  )

export const saveRating = Effect.fn("saveRating")(function* (identity: OutputIdentity, value: typeof RatingValue.Type | null) {
  const response = yield* respond(yield* ratingRequest(identity, value), value === null ? 204 : 200)
  if (value === null) return null
  return (yield* decodeJson(response, productRoutes.rate.response)).value
}, deadline, Effect.scoped)

export const deleteDocument = Effect.fn("deleteDocument")(function* (documentId: DocumentId) {
  yield* respond(HttpClientRequest.delete(productRoutes.delete.path.replace(":documentId", documentId)), productRoutes.delete.status)
}, deadline, Effect.scoped)
