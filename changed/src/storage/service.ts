import { Context, Effect, Schema } from "effect"
import { AcceptedRun, Document, DocumentDetail, DocumentId, FailureCode, IdempotencyKey, NonBlank, PositiveInt, Run, RunConfiguration, RunState, UserId } from "../domain/index.ts"
import { PdfLimits } from "../paper/pdf/index.ts"

export class StorageFailure extends Schema.TaggedError<StorageFailure>()("StorageFailure", {
  code: FailureCode,
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

export const Admission = Schema.Struct({
  ownerId: UserId,
  idempotencyKey: IdempotencyKey,
  originalFilename: Document.fields.originalFilename.check(Schema.isMaxLength(255)),
  bytes: Schema.Uint8Array,
  pageCount: PositiveInt.check(Schema.isLessThanOrEqualTo(PdfLimits.maxPages)),
  pipelineVersion: NonBlank,
  configuration: RunConfiguration,
  uploadLimit: Schema.optionalKey(PositiveInt),
})
export type Admission = typeof Admission.Type

export interface StorageOptions {
  readonly dataDirectory: string
  readonly queueLimit: number
  readonly retentionMilliseconds?: number
  readonly maxUploadBytes?: number
  readonly examplesOwnerId?: UserId | undefined
}

export const documentRetentionMilliseconds = 7 * 24 * 60 * 60 * 1000

export interface DispatchClaim {
  readonly document: Document
  readonly run: Run
  readonly claimToken: string
  readonly leaseExpiresAt: number
  readonly recovered?: boolean
}

export class DocumentStore extends Context.Service<DocumentStore, {
  readonly admit: (input: Admission) => Effect.Effect<typeof AcceptedRun.Type, StorageFailure>
  readonly list: (ownerId: UserId) => Effect.Effect<ReadonlyArray<typeof DocumentDetail.Type>, StorageFailure>
  readonly listExamples: (readerId: UserId) => Effect.Effect<ReadonlyArray<typeof DocumentDetail.Type> | null, StorageFailure>
  readonly readableOwner: (readerId: UserId, documentId: DocumentId) => Effect.Effect<UserId, StorageFailure>
  readonly uploadCount: (ownerId: UserId) => Effect.Effect<number, StorageFailure>
  readonly detail: (ownerId: UserId, documentId: DocumentId) => Effect.Effect<typeof DocumentDetail.Type, StorageFailure>
  readonly status: (ownerId: UserId, documentId: DocumentId) => Effect.Effect<Run, StorageFailure>
  readonly original: (ownerId: UserId, documentId: DocumentId) => Effect.Effect<{ readonly document: Document; readonly bytes: Uint8Array }, StorageFailure>
  readonly originalFile: (ownerId: UserId, documentId: DocumentId) => Effect.Effect<{ readonly document: Document; readonly privatePath: string }, StorageFailure>
  readonly claimNext: (input: { readonly workerId: string; readonly leaseMilliseconds: number; readonly budget?: { readonly id: string; readonly authorizedMicrousd: number | null } }) => Effect.Effect<DispatchClaim | null, StorageFailure>
  readonly renewClaim: (claim: DispatchClaim, leaseMilliseconds: number) => Effect.Effect<DispatchClaim, StorageFailure>
  readonly updateRun: (claim: DispatchClaim, state: RunState) => Effect.Effect<Run, StorageFailure>
  readonly recoverExpiredClaims: () => Effect.Effect<number, StorageFailure>
  readonly delete: (ownerId: UserId, documentId: DocumentId) => Effect.Effect<void, StorageFailure>
  readonly reconcile: () => Effect.Effect<void, StorageFailure>
}>()("amuseme/storage/DocumentStore") {}

export const storageFailure = (operation: string, cause: unknown) => new StorageFailure({
  code: "storage-failed", operation, message: "Document storage is temporarily unavailable", cause,
})

export const storageConflict = (operation: string, message: string) => new StorageFailure({
  code: "conflict", operation, message, cause: undefined,
})

export const uploadLimitReached = (limit: number) => new StorageFailure({
  code: "forbidden", operation: "admit", message: `You've used your ${limit} uploads. You can still read the examples and your documents.`, cause: undefined,
})

export const documentNotFound = () => new StorageFailure({
  code: "not-found", operation: "read", message: "Document not found", cause: undefined,
})
