import { Effect, Schema } from "effect"
import { boundaryParseOptions, DocumentId, IdempotencyKey, RetryRequest, UserId, type RunId } from "../../domain/index.ts"
import { newSubmissionKey } from "./documents.ts"
import { DocumentFailure } from "./http.ts"

const RetryAttempt = Schema.Struct({ ownerId: UserId, documentId: DocumentId, key: IdempotencyKey, request: RetryRequest })
export type RetryAttempt = typeof RetryAttempt.Type
export type RetryIdentity = { readonly ownerId: UserId; readonly documentId: DocumentId; readonly previousRunId: RunId }
const storageKey = (identity: RetryIdentity) => `amuseme.retry.${identity.ownerId}.${identity.documentId}.${identity.previousRunId}`
const unavailable = (cause: unknown) => new DocumentFailure({ kind: "rejected", message: "The saved retry identifier could not be accessed. No new retry was sent. Keep this tab open and check the document status.", cause })

export const readRetryAttempt = Effect.fn("readRetryAttempt")(function* (identity: RetryIdentity) {
  const value = yield* Effect.try({ try: () => sessionStorage.getItem(storageKey(identity)), catch: unavailable })
  if (value === null) return null
  const attempt = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RetryAttempt))(value, boundaryParseOptions).pipe(Effect.mapError(unavailable))
  if (attempt.ownerId !== identity.ownerId || attempt.documentId !== identity.documentId || attempt.request.previousRunId !== identity.previousRunId) return yield* unavailable("Saved retry identity mismatch")
  return attempt
})

export const prepareRetryAttempt = Effect.fn("prepareRetryAttempt")(function* (identity: RetryIdentity, acknowledgePossibleRepeatedWork: boolean) {
  const existing = yield* readRetryAttempt(identity)
  if (existing !== null) return existing
  const key = yield* newSubmissionKey
  const attempt: RetryAttempt = { ownerId: identity.ownerId, documentId: identity.documentId, key, request: { previousRunId: identity.previousRunId, acknowledgePossibleRepeatedWork } }
  yield* Effect.try({ try: () => sessionStorage.setItem(storageKey(identity), JSON.stringify(attempt)), catch: unavailable })
  return attempt
})
