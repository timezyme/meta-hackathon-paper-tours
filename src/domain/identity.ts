import { DateTime, Option, Schema } from "effect"

const OpaqueId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/))
const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))

export const DocumentId = OpaqueId.pipe(Schema.brand("DocumentId"))
export type DocumentId = typeof DocumentId.Type
export const UserId = OpaqueId.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type
export const RunId = OpaqueId.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type
export const ProviderAttemptId = OpaqueId.pipe(Schema.brand("ProviderAttemptId"))
export type ProviderAttemptId = typeof ProviderAttemptId.Type
export const MastraRunId = OpaqueId.pipe(Schema.brand("MastraRunId"))
export type MastraRunId = typeof MastraRunId.Type
export const OutputRevisionId = OpaqueId.pipe(Schema.brand("OutputRevisionId"))
export type OutputRevisionId = typeof OutputRevisionId.Type
export const PageId = OpaqueId.pipe(Schema.brand("PageId"))
export type PageId = typeof PageId.Type
export const BlockId = OpaqueId.pipe(Schema.brand("BlockId"))
export type BlockId = typeof BlockId.Type
export const FigureId = OpaqueId.pipe(Schema.brand("FigureId"))
export type FigureId = typeof FigureId.Type
export const SourceHash = Sha256.pipe(Schema.brand("SourceHash"))
export type SourceHash = typeof SourceHash.Type
export const ArtifactHash = Sha256.pipe(Schema.brand("ArtifactHash"))
export type ArtifactHash = typeof ArtifactHash.Type
export const RequestFingerprint = Sha256.pipe(Schema.brand("RequestFingerprint"))
export type RequestFingerprint = typeof RequestFingerprint.Type
export const IdempotencyKey = OpaqueId.pipe(Schema.brand("IdempotencyKey"))
export type IdempotencyKey = typeof IdempotencyKey.Type

export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
export const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
export const Positive = Schema.Finite.check(Schema.isGreaterThan(0))
export const NonBlank = Schema.String.check(Schema.isPattern(/\S/))
export const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  Schema.makeFilter((value) => Option.exists(DateTime.make(value), (date) => DateTime.formatIso(date) === value) || "Expected a valid canonical UTC timestamp"),
)
export const SchemaVersion = Schema.Literal("1")

export const SourceScope = Schema.Struct({ documentId: DocumentId, runId: RunId, sourceHash: SourceHash })
export type SourceScope = typeof SourceScope.Type
export const OutputScope = Schema.Struct({ documentId: DocumentId, runId: RunId, revisionId: OutputRevisionId })
export type OutputScope = typeof OutputScope.Type

export const RelativePath = Schema.String.check(Schema.isPattern(/^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/))
export const ImagePath = Schema.String.check(Schema.isPattern(/^images\/[A-Za-z0-9_-]+\.(?:png|jpeg|webp)$/))
export const ImageMediaType = Schema.Literals(["image/png", "image/jpeg", "image/webp"])
export const ImageArtifact = Schema.Struct({ path: ImagePath, mediaType: ImageMediaType, byteCount: PositiveInt, hash: ArtifactHash })
export type ImageArtifact = typeof ImageArtifact.Type
