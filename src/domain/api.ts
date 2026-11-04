import { Schema } from "effect"
import { RatingValue } from "./artifacts.ts"
import { CanonicalDocument, Document } from "./document.ts"
import { Count, DocumentId, FigureId, IdempotencyKey, NonBlank, OutputRevisionId, PositiveInt, RunId, UserId } from "./identity.ts"
import { FailureCode, ProcessingReport, Run } from "./processing.ts"

export const ApiError = Schema.Struct({ code: FailureCode, message: NonBlank })
export type ApiError = typeof ApiError.Type
export const errorHttpStatus = {
  "invalid-input": 400,
  "unsupported-pdf": 415,
  "encrypted-pdf": 422,
  "empty-document": 422,
  "limit-exceeded": 413,
  "not-found": 404,
  unauthenticated: 401,
  forbidden: 403,
  expired: 410,
  conflict: 409,
  "queue-full": 429,
  "processing-unavailable": 503,
  "provider-failed": 502,
  "provider-unknown-completion": 503,
  "invalid-provider-response": 502,
  "incomplete-source": 422,
  "invalid-artifacts": 500,
  "storage-failed": 503,
  "internal-error": 500,
} as const satisfies Record<FailureCode, number>

export const DocumentParams = Schema.Struct({ documentId: DocumentId })
export const OutputParams = Schema.Struct({ ...DocumentParams.fields, revisionId: OutputRevisionId })
export const FigureParams = Schema.Struct({ ...OutputParams.fields, figureId: FigureId })
export const UploadMetadata = Schema.Struct({ originalFilename: Document.fields.originalFilename, mediaType: Schema.Literal("application/pdf"), byteCount: PositiveInt })
export const AdmissionHeaders = Schema.Struct({ "idempotency-key": IdempotencyKey })
export const AcceptedRun = Schema.Struct({ documentId: DocumentId, runId: RunId })
export const Session = Schema.Struct({ user: Schema.Struct({ id: UserId, email: NonBlank, role: Schema.Literals(["user", "admin"]) }) })
export const DocumentDetail = Schema.Struct({ document: Document, latestRun: Run, currentRevisionId: Schema.NullOr(OutputRevisionId) })
export const UploadUnavailable = Schema.Struct({
  code: Schema.Literals(["processing-not-configured", "budget-exhausted", "provider-disabled", "fixture-uploads-disabled"]),
  reason: NonBlank,
})
export type UploadUnavailable = typeof UploadUnavailable.Type
export const UploadPolicy = Schema.Struct({
  maxBytes: PositiveInt,
  maxPages: PositiveInt,
  mediaType: Schema.Literal("application/pdf"),
  mode: Schema.Literals(["live", "fixture"]),
  availability: Schema.TaggedUnion({ enabled: {}, disabled: UploadUnavailable.fields }),
  allowance: Schema.optionalKey(Schema.Struct({ limit: PositiveInt, used: Count })),
})
export type UploadPolicy = typeof UploadPolicy.Type
export const DocumentList = Schema.Struct({ documents: Schema.Array(DocumentDetail), examples: Schema.optionalKey(Schema.Array(DocumentDetail)), upload: UploadPolicy })
export const SignInOptions = Schema.Struct({ method: Schema.Literals(["password", "email"]), accessCode: Schema.Boolean })
export type SignInOptions = typeof SignInOptions.Type
export const EmailAddress = Schema.String.check(Schema.isMaxLength(254), Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u))
export const normalizeEmail = (value: string) => value.trim().toLowerCase()
export const RetryRequest = Schema.Struct({ previousRunId: RunId, acknowledgePossibleRepeatedWork: Schema.Boolean })
export const RatingRequest = Schema.Struct({ value: RatingValue })
export const RatingResponse = Schema.Struct({ value: Schema.NullOr(RatingValue) })
export const EmptyRequest = Schema.Struct({})

const owner = "document-owner" as const
const outputOwner = "document-owner-and-output-revision" as const
export const productRoutes = {
  session: { method: "GET", path: "/api/session", authorization: "session", status: 200, response: Session },
  upload: { method: "POST", path: "/api/documents", authorization: "session", status: 202, headers: AdmissionHeaders, multipartField: "file", metadata: UploadMetadata, response: AcceptedRun },
  list: { method: "GET", path: "/api/documents", authorization: "session", status: 200, response: DocumentList },
  detail: { method: "GET", path: "/api/documents/:documentId", authorization: owner, status: 200, params: DocumentParams, response: DocumentDetail },
  status: { method: "GET", path: "/api/documents/:documentId/status", authorization: owner, status: 200, params: DocumentParams, response: Run },
  retry: { method: "POST", path: "/api/documents/:documentId/retry", authorization: owner, status: 202, params: DocumentParams, headers: AdmissionHeaders, request: RetryRequest, response: AcceptedRun },
  original: { method: "GET", path: "/api/documents/:documentId/original", authorization: owner, status: 200, params: DocumentParams, binaryMediaType: "application/pdf" },
  preview: { method: "GET", path: "/api/documents/:documentId/preview", authorization: owner, status: 200, params: DocumentParams, binaryMediaType: "image/png" },
  canonical: { method: "GET", path: "/api/documents/:documentId/outputs/:revisionId/document", authorization: outputOwner, status: 200, params: OutputParams, response: CanonicalDocument },
  text: { method: "GET", path: "/api/documents/:documentId/outputs/:revisionId/text", authorization: outputOwner, status: 200, params: OutputParams, binaryMediaType: "text/plain; charset=utf-8" },
  zip: { method: "GET", path: "/api/documents/:documentId/outputs/:revisionId/zip", authorization: outputOwner, status: 200, params: OutputParams, binaryMediaType: "application/zip" },
  image: { method: "GET", path: "/api/documents/:documentId/outputs/:revisionId/images/:figureId", authorization: outputOwner, status: 200, params: FigureParams, binaryMediaTypes: ["image/png", "image/jpeg", "image/webp"] },
  report: { method: "GET", path: "/api/documents/:documentId/outputs/:revisionId/report", authorization: outputOwner, status: 200, params: OutputParams, response: ProcessingReport },
  readRating: { method: "GET", path: "/api/documents/:documentId/outputs/:revisionId/rating", authorization: outputOwner, status: 200, params: OutputParams, response: RatingResponse },
  rate: { method: "PUT", path: "/api/documents/:documentId/outputs/:revisionId/rating", authorization: outputOwner, status: 200, params: OutputParams, request: RatingRequest, response: RatingResponse },
  clearRating: { method: "DELETE", path: "/api/documents/:documentId/outputs/:revisionId/rating", authorization: outputOwner, status: 204, params: OutputParams },
  delete: { method: "DELETE", path: "/api/documents/:documentId", authorization: owner, status: 204, params: DocumentParams },
} as const

export const boundaryParseOptions = { onExcessProperty: "error", errors: "all" } as const
