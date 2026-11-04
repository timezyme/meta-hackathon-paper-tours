import { Effect, Semaphore } from "effect"
import { Figure, Issue, MuseReview, StageReceipt } from "../../domain/index.ts"
import { applyFigureDescription, buildFigureRequest, figureResponseProblems, unavailableFigure } from "../../paper/figures/index.ts"
import { type DispatchClaim } from "../../storage/index.ts"
import { type Checkpoint } from ".././checkpoints.ts"
import { isUnavailableFigureFailure } from ".././pipeline-shared.ts"
import { type StageContext } from ".././stage-context.ts"
import { type makeMuseReview } from ".././muse-review.ts"

export const makeDescribeFigures = (context: StageContext, { reviewedMetaCall }: ReturnType<typeof makeMuseReview>) => {
  const { save, readPrivate, progress, limits, headroom, settleInOrder, loadHierarchy } = context
  const describeFigures = Effect.fnUntraced(function* (claim: DispatchClaim, input: Checkpoint) {
    const stage = "figures"
    const { hierarchy, correction, extraction } = yield* loadHierarchy(claim, input)
    const figures: Array<Figure> = []
    const issues: Array<Issue> = []
    const receipts: Array<StageReceipt> = []
    const reviews: Array<MuseReview> = []
    const markUnavailable = (figure: Figure, reason: string) => {
      const unavailable = unavailableFigure(figure, reason)
      figures.push(unavailable.figure)
      issues.push(unavailable.issue)
    }
    let finished = 0
    const counter = yield* Semaphore.make(1)
    const advance = counter.withPermit(
      Effect.gen(function* () {
        finished += 1
        yield* progress(claim, stage, finished, extraction.figures.length)
      }),
    )
    yield* progress(claim, stage, 0, extraction.figures.length)
    const outcomes = yield* settleInOrder(extraction.figures, (figure) =>
      Effect.gen(function* () {
        const bytes = figure.asset._tag === "available" ? yield* readPrivate(claim, figure.asset.artifact) : null
        const preparation = yield* Effect.fromResult(
          buildFigureRequest(extraction, correction.corrected, figure, bytes, limits(claim, "figures")),
        )
        if (preparation._tag === "unavailable") {
          yield* advance
          return preparation
        }
        const response = yield* reviewedMetaCall(claim, {
          stage,
          request: preparation.request,
          limits: limits(claim, "figures"),
          pageIds: figure.locations.map((location) => location.pageId),
          figureId: figure.id,
          inputHashes: figure.asset._tag === "available" ? [figure.asset.artifact.hash] : [],
          headroomMicrousd: headroom(claim),
          check: figureResponseProblems,
          fallback: () => ({ value: null, summary: "Published the figure without an AI description." }),
          unavailable: (failure, dispatched) => (dispatched ? isUnavailableFigureFailure(failure) : failure.code === "provider-failed"),
        })
        yield* advance
        return { _tag: "described" as const, figure, response }
      }),
    )
    for (const outcome of outcomes) {
      if (outcome._tag === "unavailable") {
        figures.push(outcome.figure)
        issues.push(outcome.issue)
        continue
      }
      const { figure, response } = outcome
      if (response.review !== null) reviews.push(response.review)
      if (response._tag === "fallback") markUnavailable(figure, response.reason)
      else {
        figures.push(yield* Effect.fromResult(applyFigureDescription(figure, response.value, response.receipt.id)))
        receipts.push(response.receipt)
      }
    }
    return { ...hierarchy, descriptions: yield* save(claim, { figures, issues, receipts, ...(reviews.length === 0 ? {} : { reviews }) }) }
  })
  return describeFigures
}
