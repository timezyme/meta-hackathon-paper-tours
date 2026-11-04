import { Effect } from "effect"
import { buildGuideRequest, guideInput, guideResponseProblems } from "../../paper/guide/index.ts"
import { AssembledDocument } from "../../paper/reading/index.ts"
import { type DispatchClaim } from "../../storage/index.ts"
import { type Checkpoint } from ".././checkpoints.ts"
import { executionFailure } from ".././contracts.ts"
import { deliveryFor, missingGuideReservation, fallbackIssue } from ".././pipeline-shared.ts"
import { type StageContext } from ".././stage-context.ts"
import { type makeMuseReview } from ".././muse-review.ts"

export const makeWriteGuide = (context: StageContext, { reviewedMetaCall }: ReturnType<typeof makeMuseReview>) => {
  const { options, save, progress, loadAssembled } = context
  const writeGuide = Effect.fnUntraced(function* (claim: DispatchClaim, input: Checkpoint) {
    const stage = "guide"
    const { assembled, publication } = yield* loadAssembled(claim, input)
    const configuration = claim.run.configuration.guide
    if (configuration === undefined) return assembled
    if (options.policy.maximumCostMicrousd.guide === undefined) return yield* missingGuideReservation()
    yield* progress(claim, stage, 0, 1)
    const guideLimits = {
      maxOutputTokens: configuration.maxOutputTokens,
      maxRequestBytes: options.policy.maxRequestBytes,
      imageTokenUpperBound: 0,
    }
    const request = yield* Effect.fromResult(buildGuideRequest(publication.canonical, guideLimits))
    const pageIds = publication.canonical.pages.map((page) => page.id)
    const response = yield* reviewedMetaCall(claim, {
      stage,
      request,
      limits: guideLimits,
      pageIds,
      figureId: null,
      inputHashes: [],
      savedInput: guideInput(publication.canonical),
      headroomMicrousd: 0,
      check: (value) => guideResponseProblems(publication.canonical, value),
      fallback: () => ({ value: null, summary: "Published the document without a reading guide." }),
    })
    const report = publication.report
    const museReviews = [
      ...(report.museReviews ?? []).filter((review) => review.stage !== "guide"),
      ...(response.review === null ? [] : [response.review]),
    ]
    const reviewed = museReviews.length === 0 ? {} : { museReviews }
    const checks = report.checks.filter((check) => check.stage !== "guide")
    let guided: AssembledDocument
    if (response._tag === "accepted") {
      const guide = { ...response.value, providerAttemptId: response.receipt.id }
      const delivery = deliveryFor(claim, response.receipt)
      guided = {
        ...publication,
        canonical: { ...publication.canonical, guide },
        report: {
          ...report,
          ...reviewed,
          receipts: [
            ...report.receipts.filter(({ receipt }) => receipt.id !== response.receipt.id),
            { delivery, receipt: response.receipt },
          ],
          checks: [...checks, { stage, checkedPageIds: pageIds, result: "passed" }],
        },
      }
    } else {
      if (response.review === null) return yield* executionFailure("invalid-provider-response", response.reason)
      const issues = report.issues.filter((issue) => issue.stage !== "guide")
      guided = {
        ...publication,
        report: {
          ...report,
          ...reviewed,
          issues: [...issues, ...fallbackIssue(response.review, publication.extraction)],
          checks: [...checks, { stage, checkedPageIds: pageIds, result: "issues" }],
        },
      }
    }
    const saved = yield* save(claim, guided)
    yield* progress(claim, stage, 1, 1)
    return { ...assembled, publication: saved }
  })
  return writeGuide
}
