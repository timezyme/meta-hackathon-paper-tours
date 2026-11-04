import { Effect, Result } from "effect"
import { CheckedPage, MuseReview, StageReceipt } from "../../domain/index.ts"
import { applyPageChecks, buildPageCheckRequest, invalidStage, pageResponseProblems, salvagePageResponse } from "../../paper/correction/index.ts"
import { type DispatchClaim } from "../../storage/index.ts"
import { type Checkpoint } from ".././checkpoints.ts"
import { executionFailure } from ".././contracts.ts"
import { rejectionMessage, specFor } from ".././pipeline-shared.ts"
import { type StageContext } from ".././stage-context.ts"
import { type makeMuseReview } from ".././muse-review.ts"

export const makeCheckPages = (context: StageContext, { reviewedMetaCall }: ReturnType<typeof makeMuseReview>) => {
  const { options, startFirstAttempt, settleFirstAttemptsInOrder, save, readPrivate, progress, limits, headroom, loadExtracted } = context
  const checkPages = Effect.fnUntraced(function* (claim: DispatchClaim, input: Checkpoint) {
    const stage = "page-check"
    const { extracted, extraction } = yield* loadExtracted(claim, input)
    const checked: Array<CheckedPage> = []
    const receipts: Array<StageReceipt> = []
    const reviews: Array<MuseReview> = []
    yield* progress(claim, stage, 0, extraction.pages.length)
    const pageCall = Effect.fnUntraced(function* (page: typeof extraction.pages[number], index: number) {
      const bytes = yield* readPrivate(claim, page.image)
      const prepared = yield* Effect.fromResult(
        buildPageCheckRequest(extraction, page.id, bytes, limits(claim, "pageCheck"), specFor(claim, stage)),
      )
      return {
        ...prepared,
        stage: "page-check" as const,
        limits: limits(claim, "pageCheck"),
        pageIds: [page.id],
        figureId: null,
        inputHashes: [page.image.hash],
        headroomMicrousd: headroom(claim, 0, extraction.pages.length - index - 1, true),
      }
    })
    const calls: Array<Effect.Success<ReturnType<typeof pageCall>>> = []
    yield* settleFirstAttemptsInOrder(
      extraction.pages,
      options.policy.maxConcurrentCalls,
      (page, index, turn) => Effect.gen(function* () {
        const call = yield* pageCall(page, index)
        calls[index] = call
        return yield* startFirstAttempt(claim, {
          ...call,
          validationTurn: turn,
          validate: (value) => Result.mapError(pageResponseProblems(extraction, page.id, value, checked.map((entry) => entry.result)), (problems) => invalidStage(rejectionMessage(problems))),
        })
      }),
      (first, page, index) => Effect.gen(function* () {
        const prepared = calls[index]!
        const earlier = checked.map((entry) => entry.result)
        const response = yield* reviewedMetaCall(claim, {
          ...prepared,
          check: (value) => pageResponseProblems(extraction, page.id, value, earlier),
          fallback: (rejected) => {
            const { result, dropped } = salvagePageResponse(extraction, page.id, rejected, earlier)
            const kept = result.fixes.length + result.joins.length
            return {
              value: result,
              summary: `Kept ${kept} proposed change${kept === 1 ? "" : "s"} that passed every check and dropped ${dropped}; all other text on this page stays as extracted.`,
            }
          },
        }, first)
        const providerAttemptId = response._tag === "accepted" ? response.receipt.id : response.attemptId
        if (providerAttemptId === null)
          return yield* executionFailure("invalid-provider-response", "A page check fallback requires its reviewed attempt")
        checked.push({
          scope: extraction.scope,
          pageId: page.id,
          previousContextIds: prepared.previousContextIds,
          result: response.value,
          providerAttemptId,
        })
        if (response._tag === "accepted") receipts.push(response.receipt)
        if (response.review !== null) reviews.push(response.review)
        yield* progress(claim, stage, checked.length, extraction.pages.length)
      }),
    )
    const corrected = yield* Effect.fromResult(applyPageChecks(extraction, checked))
    return { ...extracted, correction: yield* save(claim, { corrected, receipts, ...(reviews.length === 0 ? {} : { reviews }) }) }
  })
  return checkPages
}
