import { Cause, Effect, Exit, Random, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { AcceptedRun, boundaryParseOptions, DocumentDetail, DocumentList, IdempotencyKey, productRoutes, RetryRequest, Run } from "../../domain/index.ts"
import type { DocumentId } from "../../domain/index.ts"
import { activeRun } from "../documents.ts"
import type { DocumentRecord } from "../documents.ts"
import { DocumentFailure, makeHttp } from "./http.ts"

const { transport, requestJson } = makeHttp({
  unreachable: "We couldn’t reach AmuseMe. Check your connection and try again.",
  timedOut: "The request took too long. Its result could not be confirmed.",
  unreadable: "AmuseMe returned an unreadable response. Please try again.",
  unexpectedError: "AmuseMe returned an unexpected error. Please try again.",
  invalidData: "AmuseMe returned invalid document data. Please try again.",
})

const readDocuments = requestJson(HttpClientRequest.get("/api/documents"), DocumentList, 200)
export const readDocument = (id: DocumentId) => requestJson(HttpClientRequest.get(`/api/documents/${id}`), DocumentDetail, 200)
const readStatus = (id: DocumentId) => requestJson(HttpClientRequest.get(`/api/documents/${id}/status`), Run, 200)

export const newSubmissionKey = Effect.all(Array.from({ length: 4 }, () => Random.nextIntBetween(0, 0x1_0000_0000))).pipe(
  Effect.map((parts) => parts.map((part) => part.toString(16).padStart(8, "0")).join("")),
  Effect.flatMap(Schema.decodeUnknownEffect(IdempotencyKey)),
  Effect.mapError((cause) => new DocumentFailure({ kind: "invalid-response", message: "A submission identifier could not be created.", cause })),
)

const unpreparedRetry = (cause: unknown) => new DocumentFailure({ kind: "rejected", message: "The retry request could not be prepared.", cause })
const unconfirmedRetry = "The retry response did not identify a new run for this document. Its result could not be confirmed."

export const retryDocument = Effect.fn("retryDocument")(function* (id: DocumentId, input: typeof RetryRequest.Type, key: IdempotencyKey) {
  const body = yield* Schema.decodeUnknownEffect(RetryRequest)(input, boundaryParseOptions).pipe(Effect.mapError(unpreparedRetry))
  const request = yield* HttpClientRequest.post(productRoutes.retry.path.replace(":documentId", id)).pipe(
    HttpClientRequest.setHeader("idempotency-key", key), HttpClientRequest.bodyJson(body), Effect.mapError(transport),
  )
  const accepted = yield* requestJson(request, productRoutes.retry.response, productRoutes.retry.status)
  if (accepted.documentId !== id || accepted.runId === input.previousRunId) {
    return yield* new DocumentFailure({ kind: "invalid-response", message: unconfirmedRetry })
  }
  return accepted
})

export const uploadDocument = Effect.fn("uploadDocument")(function* (file: File, key: IdempotencyKey) {
  const form = yield* Effect.sync(() => {
    const body = new FormData()
    body.append("file", file, file.name)
    return body
  })
  const request = HttpClientRequest.post("/api/documents").pipe(HttpClientRequest.setHeader("idempotency-key", key), HttpClientRequest.bodyFormData(form))
  return yield* requestJson(request, AcceptedRun, 202)
})

const refreshRecord = Effect.fnUntraced(function* (record: DocumentRecord) {
  if (!activeRun(record.latestRun)) return record
  const latestRun = yield* readStatus(record.document.id)
  if (!activeRun(latestRun)) return yield* readDocument(record.document.id)
  return { ...record, latestRun }
})

export const watchDocuments = Effect.fnUntraced(function* (onValue: (value: typeof DocumentList.Type) => void) {
  let value = yield* readDocuments
  yield* Effect.sync(() => onValue(value))
  while (value.documents.some((item) => activeRun(item.latestRun))) {
    yield* Effect.sleep("3 seconds")
    value = { ...value, documents: yield* Effect.forEach(value.documents, refreshRecord) }
    yield* Effect.sync(() => onValue(value))
  }
})

export const watchDocument = Effect.fnUntraced(function* (id: DocumentId, onValue: (value: DocumentRecord) => void) {
  let value = yield* readDocument(id)
  yield* Effect.sync(() => onValue(value))
  while (activeRun(value.latestRun)) {
    yield* Effect.sleep("3 seconds")
    value = yield* refreshRecord(value)
    yield* Effect.sync(() => onValue(value))
  }
})

const unexpectedFailure = (cause: unknown) =>
  new DocumentFailure({ kind: "invalid-response", message: "Something unexpected happened. Please reload AmuseMe.", cause })

export const runDocument = <A>(
  program: Effect.Effect<A, DocumentFailure, HttpClient.HttpClient>,
  onSuccess: (value: A) => void,
  onFailure: (error: DocumentFailure) => void,
): (() => void) => Effect.runCallback(program.pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(FetchHttpClient.RequestInit, { credentials: "same-origin", cache: "no-store", redirect: "error" }),
  Effect.match({ onSuccess, onFailure }),
), { onExit: (exit) => {
  if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) onFailure(unexpectedFailure(exit.cause))
} })
