import { Cause, Effect, Exit, Random, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { AcceptedRun, ApiError, boundaryParseOptions, DocumentDetail, DocumentList, IdempotencyKey, productRoutes, RetryRequest, Run } from "../../domain/index.ts"
import type { DocumentId } from "../../domain/index.ts"
import { activeRun } from "../documents.ts"
import type { DocumentRecord } from "../documents.ts"

export class DocumentFailure extends Schema.TaggedError<DocumentFailure>()("DocumentFailure", {
  kind: Schema.Literals(["transport", "rejected", "invalid-response", "unauthenticated"]),
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {}

const failure = (cause: unknown) => new DocumentFailure({ kind: "transport", message: "We couldn’t reach AmuseMe. Check your connection and try again.", cause })
const deadline = Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.fail(new DocumentFailure({ kind: "transport", message: "The request took too long. Its result could not be confirmed." })) })

const requestJson = Effect.fnUntraced(function* <A>(request: HttpClientRequest.HttpClientRequest, schema: Schema.Decoder<A>, status: number) {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient)
  const response = yield* client.execute(request).pipe(Effect.mapError(failure))
  if (response.status === 401) return yield* new DocumentFailure({ kind: "unauthenticated", message: "Your session expired. Please sign in again.", status: 401 })
  const json = yield* response.json.pipe(Effect.mapError((cause) => new DocumentFailure({ kind: "invalid-response", message: "AmuseMe returned an unreadable response. Please try again.", cause })))
  if (response.status !== status) {
    const error = yield* Schema.decodeUnknownEffect(ApiError)(json).pipe(Effect.mapError((cause) => new DocumentFailure({ kind: "invalid-response", message: "AmuseMe returned an unexpected error. Please try again.", status: response.status, cause })))
    return yield* new DocumentFailure({ kind: "rejected", message: error.message, status: response.status })
  }
  return yield* Schema.decodeUnknownEffect(schema)(json, boundaryParseOptions).pipe(Effect.mapError((cause) => new DocumentFailure({ kind: "invalid-response", message: "AmuseMe returned invalid document data. Please try again.", cause })))
}, deadline, Effect.scoped)

export const readDocuments = requestJson(HttpClientRequest.get("/api/documents"), DocumentList, 200)
export const readDocument = (id: DocumentId) => requestJson(HttpClientRequest.get(`/api/documents/${id}`), DocumentDetail, 200)
const readStatus = (id: DocumentId) => requestJson(HttpClientRequest.get(`/api/documents/${id}/status`), Run, 200)

export const newSubmissionKey = Effect.all(Array.from({ length: 4 }, () => Random.nextIntBetween(0, 0x1_0000_0000))).pipe(
  Effect.map((parts) => parts.map((part) => part.toString(16).padStart(8, "0")).join("")),
  Effect.flatMap(Schema.decodeUnknownEffect(IdempotencyKey)),
  Effect.mapError((cause) => new DocumentFailure({ kind: "invalid-response", message: "A submission identifier could not be created.", cause })),
)

export const retryDocument = Effect.fn("retryDocument")(function* (id: DocumentId, input: typeof RetryRequest.Type, key: IdempotencyKey) {
  const body = yield* Schema.decodeUnknownEffect(RetryRequest)(input, boundaryParseOptions).pipe(Effect.mapError((cause) => new DocumentFailure({ kind: "rejected", message: "The retry request could not be prepared.", cause })))
  const request = yield* HttpClientRequest.post(productRoutes.retry.path.replace(":documentId", id)).pipe(HttpClientRequest.setHeader("idempotency-key", key), HttpClientRequest.bodyJson(body), Effect.mapError(failure))
  const accepted = yield* requestJson(request, productRoutes.retry.response, productRoutes.retry.status)
  if (accepted.documentId !== id || accepted.runId === input.previousRunId) return yield* new DocumentFailure({ kind: "invalid-response", message: "The retry response did not identify a new run for this document. Its result could not be confirmed." })
  return accepted
})

export const uploadDocument = Effect.fn("uploadDocument")(function* (file: File, key: IdempotencyKey) {
  const form = yield* Effect.sync(() => {
    const body = new FormData()
    body.append("file", file, file.name)
    return body
  })
  return yield* requestJson(HttpClientRequest.post("/api/documents").pipe(HttpClientRequest.setHeader("idempotency-key", key), HttpClientRequest.bodyFormData(form)), AcceptedRun, 202)
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

export const runDocument = <A>(program: Effect.Effect<A, DocumentFailure, HttpClient.HttpClient>, onSuccess: (value: A) => void, onFailure: (error: DocumentFailure) => void): (() => void) => Effect.runCallback(program.pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(FetchHttpClient.RequestInit, { credentials: "same-origin", cache: "no-store", redirect: "error" }),
  Effect.match({ onSuccess, onFailure }),
), { onExit: (exit) => {
  if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) onFailure(new DocumentFailure({ kind: "invalid-response", message: "Something unexpected happened. Please reload AmuseMe.", cause: exit.cause }) )
} })
