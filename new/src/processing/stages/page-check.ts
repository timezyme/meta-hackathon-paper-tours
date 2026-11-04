import { Effect } from "effect"
import { CheckedPage, MuseReview, StageReceipt } from "../../domain/index.ts"
import { applyPageChecks, buildPageCheckRequest, pageResponseProblems, salvagePageResponse } from "../../paper/correction/index.ts"
import { type DispatchClaim } from "../../storage/index.ts"
import { type Checkpoint } from ".././checkpoints.ts"
import { executionFailure } from ".././contracts.ts"
import { specFor } from ".././pipeline-shared.ts"
import { type StageContext } from ".././stage-context.ts"
import { type makeMuseReview } from ".././muse-review.ts"

export const makeCheckPages = (context: StageContext, { reviewedMetaCall }: ReturnType<typeof makeMuseReview>) => {
  const { save, readPrivate, progress, limits, headroom, loadExtracted } = context
  const checkPages = Effect.fnUntraced(function* (claim: DispatchClaim, input: Checkpoint) {
    const stage = "page-check"
    const { extracted, extraction } = yield* loadExtracted(claim, input)
    const checked: Array<CheckedPage> = []
    const receipts: Array<StageReceipt> = []
    const reviews: Array<MuseReview> = []
    yield* progress(claim, stage, 0, extraction.pages.length)
    for (const page of extraction.pages) {
      const bytes = yield* readPrivate(claim, page.image)
      const prepared = yield* Effect.fromResult(
        buildPageCheckRequest(extraction, page.id, bytes, limits(claim, "pageCheck"), specFor(claim, stage)),
      )
      const earlier = checked.map((entry) => entry.result)
      const remaining = extraction.pages.length - checked.length - 1
      const response = yield* reviewedMetaCall(claim, {
        stage,
        request: prepared.request,
        limits: limits(claim, "pageCheck"),
        pageIds: [page.id],
        figureId: null,
        inputHashes: [page.image.hash],
        headroomMicrousd: headroom(claim, 0, remaining, true),
        check: (value) => pageResponseProblems(extraction, page.id, value, earlier),
        fallback: (rejected) => {
          const { result, dropped } = salvagePageResponse(extraction, page.id, rejected, earlier)
          const kept = result.fixes.length + result.joins.length
          return {
            value: result,
            summary: `Kept ${kept} proposed change${kept === 1 ? "" : "s"} that passed every check and dropped ${dropped}; all other text on this page stays as extracted.`,
          }
        },
      })
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
    }
    const corrected = yield* Effect.fromResult(applyPageChecks(extraction, checked))
    return { ...extracted, correction: yield* save(claim, { corrected, receipts, ...(reviews.length === 0 ? {} : { reviews }) }) }
  })
  return checkPages
}
