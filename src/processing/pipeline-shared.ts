import { Effect, Equal, Redacted, Result, Schema, SchemaTransformation } from "effect"
import type { PlatformError } from "effect/PlatformError"
import {
  ArtifactHash,
  Figure,
  FigureCropReview,
  Issue,
  MuseReview,
  StageReceipt,
  stageConfiguration,
  Extraction,
  type FigureId,
  type ImageArtifact,
  type Page,
  type PageId,
  type PixelBox,
  type ProviderAttemptId,
  type ProviderTask,
  type Stage,
  type Failure,
  type FailureCode,
} from "../domain/index.ts"
import { CorrectedText, pageCheckSpecFor, stageSpecs, type StageRequestLimits } from "../paper/correction/index.ts"
import { pageExtractionProblems, type ValidatedPageExtraction } from "../paper/extraction/page.ts"
import { SavedExtraction } from "../paper/extraction/index.ts"
import { figureCropRounds } from "../paper/figures/index.ts"
import { HeadingResponse } from "../paper/headings/index.ts"
import { PdfRenderError } from "../paper/pdf/index.ts"
import { type MetaRequest, type MetaStage, type MetaStageSpec } from "../paper/providers/meta/index.ts"
import { PrivateArtifact, StorageFailure, type DispatchClaim } from "../storage/index.ts"
import { type Checkpoint } from "./checkpoints.ts"
import { ExecutionFailure, GuardPolicy, executionFailure, type GuardError } from "./contracts.ts"

const Reviews = Schema.optionalKey(Schema.Array(MuseReview))
const ExtractionReceipts = Schema.Struct({
  conversion: SavedExtraction,
  receipts: Schema.NonEmptyArray(StageReceipt),
  reviews: Reviews,
  cropReviews: Schema.optionalKey(Schema.Array(FigureCropReview)),
  cropReceipts: Schema.optionalKey(Schema.Array(StageReceipt)),
})
const normalizedReceipts = Schema.toType(ExtractionReceipts)
const CurrentExtractedData = Schema.Struct({ ...ExtractionReceipts.fields, receipt: Schema.optionalKey(Schema.Never) }).pipe(
  Schema.decodeTo(
    normalizedReceipts,
    SchemaTransformation.transform({
      decode: ({ receipt: _receipt, ...current }) => current,
      encode: (current) => current,
    }),
  ),
)
const LegacyExtractedData = Schema.Struct({
  conversion: SavedExtraction,
  receipt: StageReceipt,
  receipts: Schema.optionalKey(Schema.Never),
  reviews: Schema.optionalKey(Schema.Never),
  cropReviews: Schema.optionalKey(Schema.Never),
  cropReceipts: Schema.optionalKey(Schema.Never),
}).pipe(
  Schema.decodeTo(
    normalizedReceipts,
    SchemaTransformation.transform({
      decode: ({ conversion, receipt }): typeof normalizedReceipts.Type => ({ conversion, receipts: [receipt] }),
      encode: ({ conversion, receipts }) => ({ conversion, receipt: receipts[0] }),
    }),
  ),
)
export const ExtractedData = Schema.Union([CurrentExtractedData, LegacyExtractedData])
export type ExtractedData = typeof ExtractedData.Type
export const CorrectedData = Schema.Struct({ corrected: CorrectedText, receipts: Schema.Array(StageReceipt), reviews: Reviews })
export const HeadingData = Schema.Struct({ response: HeadingResponse, receipt: Schema.NullOr(StageReceipt), reviews: Reviews })
export const DescribedData = Schema.Struct({
  figures: Schema.Array(Figure),
  issues: Schema.Array(Issue),
  receipts: Schema.Array(StageReceipt),
  reviews: Reviews,
})
export const privateRef = ({ hash, byteCount }: PrivateArtifact): PrivateArtifact => ({ hash, byteCount })
export const unsupported = () => Effect.fail(executionFailure("conflict", "The response belongs to another processing stage"))
export const imageTokenUpperBound = 131072
export const figureImageAllowanceBytes = 100 * 1024 * 1024
export const figureChainLimit = 3
export const isPageExtraction = (receipt: StageReceipt) => receipt.stage === "extraction" && receipt.task === undefined

const isPageReceipt = (receipt: StageReceipt, page: Page | undefined, configuration: ReturnType<typeof stageConfiguration>) =>
  receipt.stage === "extraction" &&
  Equal.equals(receipt.configuration, configuration) &&
  receipt.pageIds.length === 1 &&
  receipt.pageIds[0] === page?.id
const belongsToRun = (receipt: StageReceipt, claim: DispatchClaim) =>
  receipt.ownerId === claim.document.ownerId &&
  receipt.scope.documentId === claim.document.id &&
  receipt.scope.sourceHash === claim.document.sourceHash &&
  receipt.pipelineVersion === claim.run.pipelineVersion &&
  receipt.schemaVersion === claim.run.schemaVersion
const isAccepted = (receipt: StageReceipt) => receipt.state._tag === "completed" && receipt.state.validation._tag === "accepted"
export const receiptsCoverPagesInOrder = (claim: DispatchClaim, extraction: Extraction, receipts: ReadonlyArray<StageReceipt>) => {
  const configuration = stageConfiguration(claim.run.configuration, "extraction")
  return (
    new Set(receipts.map((receipt) => receipt.id)).size === receipts.length &&
    receipts.length === extraction.pages.length &&
    receipts.every(
      (receipt, index) =>
        isPageReceipt(receipt, extraction.pages[index], configuration) && belongsToRun(receipt, claim) && isAccepted(receipt),
    )
  )
}
export const sameArtifact = (stored: PrivateArtifact, expected: PrivateArtifact) =>
  stored.hash === expected.hash && stored.byteCount === expected.byteCount
export const deliveryFor = (claim: DispatchClaim, receipt: StageReceipt) =>
  receipt.scope.runId === claim.run.id ? ("performed" as const) : ("reused" as const)
export const missingGuideReservation = () =>
  executionFailure("processing-unavailable", "The reading guide requires an explicit provider reservation")
export const reviewedFigureBoxes = (
  page: Page,
  extracted: ValidatedPageExtraction,
  boxes: ReadonlyMap<number, PixelBox>,
): Result.Result<ValidatedPageExtraction, ExecutionFailure> => {
  if (boxes.size === 0) return Result.succeed(extracted)
  const figures = extracted.figures.map((figure) => {
    const box = boxes.get(figure.blockIndex)
    return box === undefined ? figure : { ...figure, box: { x: box.x, y: box.y, width: box.width, height: box.height } }
  })
  return Result.mapError(pageExtractionProblems(page, { ...extracted, figures }), () =>
    executionFailure("invalid-provider-response", "A reviewed figure crop no longer fits its page"),
  )
}
export const isUnavailableFigureFailure = (failure: ExecutionFailure | StorageFailure) =>
  failure._tag === "ExecutionFailure" && failure.code !== "provider-unknown-completion" && failure.code !== "conflict"

export interface MetaCall {
  readonly stage: MetaStage
  readonly task?: ProviderTask
  readonly headroomMicrousd?: number
  readonly request: MetaRequest
  readonly limits: StageRequestLimits
  readonly validationTurn?: Effect.Effect<void, ExecutionFailure>
  readonly validate: (value: Schema.Json) => Result.Result<unknown, ExecutionFailure>
  readonly pageIds: ReadonlyArray<PageId>
  readonly figureId: FigureId | null
  readonly inputHashes: ReadonlyArray<ArtifactHash>
  readonly savedInput?: unknown
}
export type Checked<A> = Result.Result<A, ReadonlyArray<string>>
export interface ReviewedUnit<A, F> extends Omit<MetaCall, "validate"> {
  readonly check: (value: Schema.Json) => Checked<A>
  readonly headroomMicrousd: number
  readonly fallback: (rejected: Schema.Json | null) => { readonly value: F; readonly summary: string } | null
  readonly unavailable?: (failure: ExecutionFailure, dispatched: boolean) => boolean
}
export type Reviewed<A, F> =
  | { readonly _tag: "accepted"; readonly value: A; readonly receipt: StageReceipt; readonly review: MuseReview | null }
  | {
      readonly _tag: "fallback"
      readonly value: F
      readonly attemptId: ProviderAttemptId | null
      readonly review: MuseReview | null
      readonly reason: string
    }
export const problemLimit = 20
const problemTextLimit = 400
const problemPreviewLength = problemTextLimit - 3
export const conciseProblems = (problems: ReadonlyArray<string>): readonly [string, ...Array<string>] => {
  const listed = problems
    .slice(0, problemLimit)
    .map((problem) => (problem.length > problemTextLimit ? `${problem.slice(0, problemPreviewLength)}...` : problem))
  const more = problems.length > problemLimit ? [`${problems.length - problemLimit} more problems`] : []
  const [first, ...rest] = [...listed, ...more]
  return first === undefined ? ["The answer did not pass validation"] : [first, ...rest]
}
export const rejectionMessage = (problems: ReadonlyArray<string>) =>
  `Muse review needed: ${conciseProblems(problems).slice(0, 3).join("; ")}`
export const reviewUnavailable = (failure: GuardError | ExecutionFailure): failure is ExecutionFailure =>
  failure._tag === "ExecutionFailure" && (failure.code === "limit-exceeded" || failure.code === "provider-failed")
export const preflightUnavailable = (failure: GuardError | ExecutionFailure): failure is ExecutionFailure =>
  failure._tag === "ExecutionFailure" && failure.code !== "processing-unavailable"
export interface CroppedFigure {
  readonly box: PixelBox
  readonly asset: ImageArtifact
  readonly bytes: Uint8Array
}
export const cropProblemText = (problem: string) =>
  problem.length > problemTextLimit ? `${problem.slice(0, problemPreviewLength)}...` : problem
export const cropWarning = (outcome: "unconfirmed" | "not-reviewed", reason: string) =>
  outcome === "not-reviewed"
    ? `Muse could not check this figure's crop (${reason}); the extractor's proposed region is published unreviewed and may cut off part of the figure or include nearby text.`
    : `Muse did not confirm this figure's crop after ${figureCropRounds} review rounds; the published region holds the extractor's proposal and Muse's last correction, unless that would take in another figure, and may include nearby text or cut off part of the figure.`
const pageLocations = (extraction: Extraction, pageIds: ReadonlyArray<PageId>) =>
  extraction.pages
    .filter((page) => pageIds.includes(page.id))
    .map((page) => ({ _tag: "page" as const, pageId: page.id, pageNumber: page.pageNumber }))
export const fallbackIssue = (review: MuseReview, extraction: Extraction): Array<Issue> => {
  const [first, ...rest] = pageLocations(extraction, review.pageIds)
  if (review.outcome !== "fallback" || review.stage === "figures" || first === undefined) return []
  const message = `Muse review could not correct the ${review.stage} answer. ${review.fallback ?? "A safe fallback was used."}`
  return [{ code: "provider-failure", message, stage: review.stage, locations: [first, ...rest], blockIds: [], figureId: null }]
}
export const specFor = (claim: DispatchClaim, stage: MetaStage): MetaStageSpec =>
  stage === "page-check" ? pageCheckSpecFor(claim.run.configuration.pageCheck.promptVersion) : stageSpecs[stage]
export type StageError = ExecutionFailure | StorageFailure | PdfRenderError | PlatformError | Schema.SchemaError
export type StageHandler = (claim: DispatchClaim, input: Checkpoint) => Effect.Effect<Checkpoint, StageError>
export const retryableCodes: ReadonlyArray<FailureCode> = ["provider-unknown-completion", "provider-failed", "storage-failed"]
const localFileFailure = {
  code: "storage-failed",
  message: "A private processing file could not be read or written",
} as const
const invalidOutput = {
  code: "invalid-provider-response",
  message: "The processing output did not pass validation",
} as const
export const stageFailure = (error: StageError, stage: typeof Stage.Type): Failure => {
  const { code, message } = error._tag === "PlatformError" ? localFileFailure : error._tag === "SchemaError" ? invalidOutput : error
  return { code, message, retryable: retryableCodes.includes(code), stage, pageId: null, figureId: null }
}
export interface MetaPreflight {
  readonly inputTokens: number
  readonly framingReserveTokens: number
}

export interface PipelineOptions {
  readonly temporaryDirectory: string
  readonly policy: GuardPolicy
  readonly metaCredential: Redacted.Redacted<string>
  readonly mineruToken?: Redacted.Redacted<string>
  readonly mineruEndpoint?: string
}
export const reviewLoop = Effect.fnUntraced(function* <A, E, R>(
  first: number,
  last: number,
  step: (round: number) => Effect.Effect<A | null, E, R>,
  exhausted: Effect.Effect<A, E, R>,
) {
  for (let round = first; round <= last; round += 1) {
    const result = yield* step(round)
    if (result !== null) return result
  }
  return yield* exhausted
})
