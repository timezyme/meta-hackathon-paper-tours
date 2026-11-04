import { Effect } from "effect"
import type { DocumentId, UserId } from "../domain/index.ts"
import type { DocumentStore } from "../storage/index.ts"

// SAFETY: Only reads may use the owner returned by this policy. Writes use the session user.
export const documentReadPolicy = Effect.fnUntraced(function* (
  documents: Pick<DocumentStore["Service"], "readableOwner">,
  readerId: UserId,
  documentId: DocumentId,
) {
  const ownerId = yield* documents.readableOwner(readerId, documentId)
  return { ownerId, shared: ownerId !== readerId }
})
