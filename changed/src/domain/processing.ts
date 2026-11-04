import { isMuseModel } from "./meta-policy.ts"
import { Equal, Result, Schema } from "effect"
import { FigureDescription, HeadingDecision, PageFurniture, PixelBox, SourceLocation } from "./document.ts"
import { ArtifactHash, BlockId, Count, DocumentId, FigureId, MastraRunId, NonBlank, NonNegative, OutputRevisionId, OutputScope, PageId, PositiveInt, ProviderAttemptId, RequestFingerprint, RunId, SchemaVersion, SourceScope, Timestamp, UserId } from "./identity.ts"

export const Stage = Schema.Literals(["extraction", "page-check", "headings", "figures", "assembly", "guide", "export"])
export const ProviderStage = Schema.Literals(["extraction", "page-check", "headings", "figures", "guide"])
export const ProviderTask = Schema.Literal("figure-crop")
export type ProviderTask = typeof ProviderTask.Type
export const FailureCode = Schema.Literals(["invalid-input", "unsupported-pdf", "encrypted-pdf", "empty-document", "limit-exceeded", "not-found", "unauthenticated", "forbidden", "expired", "conflict", "queue-full", "processing-unavailable", "provider-failed", "provider-unknown-completion", "invalid-provider-response", "incomplete-source", "invalid-artifacts", "storage-failed", "internal-error"])
export type FailureCode = typeof FailureCode.Type
export const Failure = Schema.Struct({ code: FailureCode, message: NonBlank, retryable: Schema.Boolean, stage: Schema.NullOr(Stage), pageId: Schema.NullOr(PageId), figureId: Schema.NullOr(FigureId) })
export type Failure = typeof Failure.Type

export const PageCheck = Schema.Struct({
  fixes: Schema.Array(Schema.Struct({ blockId: BlockId, content: Schema.String })),
  joins: Schema.Array(Schema.Struct({ firstBlockId: BlockId, secondBlockId: BlockId, answer: Schema.Literals(["same", "word"]) })),
  furniture: Schema.optionalKey(Schema.Array(PageFurniture)),
})
export type PageCheck = typeof PageCheck.Type
export const CheckedPage = Schema.Struct({ scope: SourceScope, pageId: PageId, previousContextIds: Schema.Array(BlockId), result: PageCheck, providerAttemptId: ProviderAttemptId })
export type CheckedPage = typeof CheckedPage.Type
export const HeadingSidecar = Schema.Struct({
  scope: SourceScope,
  correctedInputHash: ArtifactHash,
  providerAttemptId: ProviderAttemptId,
  headings: Schema.Array(HeadingDecision),
})
export type HeadingSidecar = typeof HeadingSidecar.Type
export const FigureSidecar = Schema.Struct({
  scope: SourceScope,
  correctedInputHash: ArtifactHash,
  figures: Schema.Array(Schema.Struct({ figureId: FigureId, description: FigureDescription })),
})
export type FigureSidecar = typeof FigureSidecar.Type

export const ModelConfiguration = Schema.Struct({
  provider: NonBlank,
  model: NonBlank,
  reasoning: Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max"]),
  promptName: NonBlank,
  promptVersion: NonBlank,
  maxOutputTokens: PositiveInt,
})
export const FigureCropPromptVersion = Schema.Literals(["amuseme-1", "amuseme-2"])
export type FigureCropPromptVersion = typeof FigureCropPromptVersion.Type
export const RunConfiguration = Schema.Struct({
  extractionProvider: NonBlank,
  extractionVersion: NonBlank,
  extractionModel: Schema.optionalKey(ModelConfiguration),
  pageCheck: ModelConfiguration,
  headings: ModelConfiguration,
  figures: ModelConfiguration,
  figureCropPromptVersion: Schema.optionalKey(FigureCropPromptVersion),
  guide: Schema.optionalKey(ModelConfiguration),
  maxProviderAttempts: PositiveInt,
  deadlineMilliseconds: PositiveInt,
  spendingCapUsd: NonNegative,
}).check(Schema.makeFilter((value) => value.extractionProvider === "meta"
  ? isMuseModel(value.extractionModel) && value.extractionVersion === value.extractionModel?.model
    || "Meta extraction requires a matching Spark model configuration"
  : value.extractionModel === undefined || "Only Meta extraction accepts a model configuration"))
export const figureCropPromptVersionOf = (configuration: typeof RunConfiguration.Type): FigureCropPromptVersion => configuration.figureCropPromptVersion ?? "amuseme-1"
export const stageConfiguration = (configuration: typeof RunConfiguration.Type, stage: typeof ProviderStage.Type) => {
  if (stage === "extraction") return { _tag: "extraction" as const, provider: configuration.extractionProvider, version: configuration.extractionVersion, ...(configuration.extractionModel === undefined ? {} : { model: configuration.extractionModel }) }
  const model = stage === "page-check" ? configuration.pageCheck : stage === "headings" ? configuration.headings : stage === "figures" ? configuration.figures : configuration.guide
  return model === undefined ? undefined : { _tag: "model" as const, ...model }
}
export const Progress = Schema.Struct({ stage: Stage, completedUnits: Count, totalUnits: Schema.NullOr(Count) }).check(
  Schema.makeFilter((value) => value.totalUnits === null || value.completedUnits <= value.totalUnits || "Completed units exceed the total"),
)
export const RunState = Schema.TaggedUnion({
  queued: {},
  running: { startedAt: Timestamp, progress: Progress },
  succeeded: { startedAt: Timestamp, finishedAt: Timestamp, revisionId: OutputRevisionId },
  "succeeded-with-issues": { startedAt: Timestamp, finishedAt: Timestamp, revisionId: OutputRevisionId },
  failed: { finishedAt: Timestamp, failure: Failure },
  interrupted: { finishedAt: Timestamp, failure: Failure },
})
export type RunState = typeof RunState.Type
export const Run = Schema.Struct({
  id: RunId,
  documentId: DocumentId,
  ownerId: UserId,
  pipelineVersion: NonBlank,
  schemaVersion: SchemaVersion,
  configuration: RunConfiguration,
  createdAt: Timestamp,
  mastraRunId: Schema.NullOr(MastraRunId),
  state: RunState,
})
export type Run = typeof Run.Type

export const Usage = Schema.TaggedUnion({
  unavailable: { reason: NonBlank },
  reported: {
    inputTokens: Schema.NullOr(Count),
    outputTokens: Schema.NullOr(Count),
    costUsd: Schema.NullOr(NonNegative),
  },
}).check(Schema.makeFilter((usage) => usage._tag === "unavailable" || usage.inputTokens !== null || usage.outputTokens !== null || usage.costUsd !== null || "Reported usage needs at least one metric"))
export const ReceiptState = Schema.TaggedUnion({
  prepared: {},
  submitted: { submittedAt: Timestamp, providerRequestId: Schema.NullOr(NonBlank) },
  completed: {
    finishedAt: Timestamp,
    providerRequestId: Schema.NullOr(NonBlank),
    responseHash: ArtifactHash,
    durationMilliseconds: NonNegative,
    usage: Usage,
    validation: Schema.TaggedUnion({ accepted: {}, rejected: { failure: Failure } }),
  },
  failed: { finishedAt: Timestamp, providerRequestId: Schema.NullOr(NonBlank), failure: Failure },
  "unknown-completion": { observedAt: Timestamp, providerRequestId: Schema.NullOr(NonBlank), reason: NonBlank },
})
export type ReceiptState = typeof ReceiptState.Type
export const StageReceipt = Schema.Struct({
  id: ProviderAttemptId,
  ownerId: UserId,
  scope: SourceScope,
  stage: ProviderStage,
  pageIds: Schema.Array(PageId),
  figureId: Schema.NullOr(FigureId),
  task: Schema.optionalKey(ProviderTask),
  requestFingerprint: RequestFingerprint,
  inputHashes: Schema.NonEmptyArray(ArtifactHash),
  pipelineVersion: NonBlank,
  schemaVersion: SchemaVersion,
  configuration: Schema.TaggedUnion({ model: ModelConfiguration.fields, extraction: { provider: NonBlank, version: NonBlank, model: Schema.optionalKey(ModelConfiguration) } }).check(Schema.makeFilter((value) => value._tag === "model" || (value.provider === "meta"
    ? isMuseModel(value.model) && value.version === value.model?.model
      || "Meta extraction receipt requires its matching Spark model configuration"
    : value.model === undefined || "Only Meta extraction receipts accept a model configuration"))),
  preparedAt: Timestamp,
  state: ReceiptState,
})
export type StageReceipt = typeof StageReceipt.Type
const decodeStoredReceipt = Schema.decodeUnknownResult(Schema.fromJsonString(StageReceipt))
export const matchesStoredReceipt = (stored: string, receipt: StageReceipt) => {
  const saved = decodeStoredReceipt(stored, { onExcessProperty: "error" })
  return Result.isSuccess(saved) && Equal.equals(saved.success, receipt)
}
export const ReceiptUse = Schema.Struct({ delivery: Schema.Literals(["performed", "reused"]), receipt: StageReceipt })
export type ReceiptUse = typeof ReceiptUse.Type
export const ReuseRequest = Schema.Struct({
  ownerId: UserId,
  scope: SourceScope,
  requestFingerprint: RequestFingerprint,
  pipelineVersion: NonBlank,
  schemaVersion: SchemaVersion,
  stage: ProviderStage,
  pageIds: Schema.Array(PageId),
  figureId: Schema.NullOr(FigureId),
  task: Schema.optionalKey(ProviderTask),
})
export type ReuseRequest = typeof ReuseRequest.Type

export const Issue = Schema.Struct({
  code: Schema.Literals(["ambiguous-content", "figure-asset-unavailable", "figure-description-unavailable", "table-uncertain", "unclassified-content", "provider-failure", "structural-failure", "figure-crop-unconfirmed"]),
  message: NonBlank,
  stage: Stage,
  locations: Schema.NonEmptyArray(SourceLocation),
  blockIds: Schema.Array(BlockId),
  figureId: Schema.NullOr(FigureId),
})
export type Issue = typeof Issue.Type
export const MuseReview = Schema.Struct({
  stage: ProviderStage,
  agent: NonBlank,
  pageIds: Schema.Array(PageId),
  figureId: Schema.NullOr(FigureId),
  problems: Schema.NonEmptyArray(NonBlank),
  rounds: Count,
  attemptIds: Schema.NonEmptyArray(ProviderAttemptId),
  outcome: Schema.Literals(["corrected", "fallback"]),
  fallback: Schema.NullOr(NonBlank),
})
export type MuseReview = typeof MuseReview.Type
export const museFallback = (reviews: ReadonlyArray<MuseReview> | undefined, stage: MuseReview["stage"], pageId?: PageId): boolean =>
  (reviews ?? []).some((review) => review.stage === stage && review.outcome === "fallback" && (pageId === undefined || review.pageIds.includes(pageId)))
export const FigureCropReview = Schema.Struct({
  figureId: FigureId,
  pageId: PageId,
  agent: NonBlank,
  outcome: Schema.Literals(["confirmed", "corrected", "unconfirmed", "not-reviewed"]),
  rounds: Count,
  attemptIds: Schema.Array(ProviderAttemptId),
  proposedBox: PixelBox,
  finalBox: PixelBox,
  problems: Schema.Array(NonBlank),
  warning: Schema.NullOr(NonBlank),
})
export type FigureCropReview = typeof FigureCropReview.Type
export const cropReviewEvidence = (receipt: StageReceipt, crops: ReadonlyArray<FigureCropReview> | undefined): boolean =>
  receipt.task === "figure-crop" && receipt.state._tag === "completed" && (crops ?? []).some((crop) => crop.figureId === receipt.figureId && crop.attemptIds.includes(receipt.id))
export const MeasuredCount = Schema.TaggedUnion({ unavailable: { reason: NonBlank }, measured: { count: Count } })
export const ProcessingReport = Schema.Struct({
  schemaVersion: SchemaVersion,
  scope: OutputScope,
  changes: Schema.Struct({ changedBlockIds: Schema.Array(BlockId), appliedJoinCount: Count, changedHeadingCount: Count }),
  ambiguity: MeasuredCount,
  verifiedCorrectionCount: MeasuredCount,
  issues: Schema.Array(Issue),
  checks: Schema.Array(Schema.Struct({ stage: Stage, checkedPageIds: Schema.Array(PageId), result: Schema.Literals(["passed", "issues"]) })),
  receipts: Schema.Array(ReceiptUse),
  museReviews: Schema.optionalKey(Schema.Array(MuseReview)),
  figureCrops: Schema.optionalKey(Schema.Array(FigureCropReview)),
  pageCheckFurniture: Schema.optionalKey(Schema.Array(PageFurniture)),
  codeClassificationRepair: Schema.optionalKey(Schema.Struct({ previousRevisionId: OutputRevisionId, blockIds: Schema.NonEmptyArray(BlockId) })),
})
export type ProcessingReport = typeof ProcessingReport.Type

export const currentRunReceipts = (report: ProcessingReport): ReadonlyArray<StageReceipt> => report.receipts
  .filter(({ delivery, receipt }) => delivery === "performed" && receipt.scope.runId === report.scope.runId)
  .map(({ receipt }) => receipt)

export const canTransitionRun = (from: RunState["_tag"], to: RunState["_tag"]): boolean =>
  from === "queued"
    ? to === "running" || to === "failed" || to === "interrupted"
    : from === "running" && to !== "queued"

export const canTransitionReceipt = (from: ReceiptState["_tag"], to: ReceiptState["_tag"]): boolean =>
  from === "prepared"
    ? to === "submitted" || to === "failed" || to === "unknown-completion"
    : (from === "submitted" || from === "unknown-completion") && (to === "completed" || to === "failed" || to === "unknown-completion")
