import { Effect, Result } from "effect"
import {
  buildHeadingRequest,
  extractorHeadingDecisions,
  headingResponseProblems,
  validateHeadingResponse,
} from "../../paper/headings/index.ts"
import { type DispatchClaim } from "../../storage/index.ts"
import { type Checkpoint } from ".././checkpoints.ts"
import { type StageContext } from ".././stage-context.ts"
import { type makeMuseReview } from ".././muse-review.ts"

export const makeClassifyHeadings = (context: StageContext, { reviewedMetaCall }: ReturnType<typeof makeMuseReview>) => {
  const { save, progress, limits, headroom, loadCorrected } = context
  const classifyHeadings = Effect.fnUntraced(function* (claim: DispatchClaim, input: Checkpoint) {
    const stage = "headings"
    const { corrected, correction, extraction } = yield* loadCorrected(claim, input)
    yield* progress(claim, stage, 0, 1)
    const request = yield* Effect.fromResult(buildHeadingRequest(extraction, correction.corrected, limits(claim, "headings")))
    const response = yield* reviewedMetaCall(claim, {
      stage,
      request,
      limits: limits(claim, "headings"),
      pageIds: extraction.pages.map((page) => page.id),
      figureId: null,
      inputHashes: [],
      headroomMicrousd: headroom(claim),
      check: (value) => headingResponseProblems(correction.corrected, value),
      fallback: () => {
        const decisions = extractorHeadingDecisions(correction.corrected)
        return Result.isSuccess(validateHeadingResponse(extraction, correction.corrected, decisions))
          ? { value: decisions, summary: "Kept the extractor's own heading classification, with at most one level-1 title." }
          : null
      },
    })
    yield* progress(claim, stage, 1, 1)
    const receipt = response._tag === "accepted" ? response.receipt : null
    return {
      ...corrected,
      hierarchy: yield* save(claim, {
        response: response.value,
        receipt,
        ...(response.review === null ? {} : { reviews: [response.review] }),
      }),
    }
  })
  return classifyHeadings
}
