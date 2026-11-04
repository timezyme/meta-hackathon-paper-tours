import { Effect, Result, Schema } from "effect"
import { MuseReview, type ProviderAttemptId } from "../domain/index.ts"
import { boundRequest, invalidStage } from "../paper/correction/index.ts"
import { makeMuseReviewRequest, metaAssistantText, museReviewAgentId, museReviewRounds } from "../paper/providers/meta/index.ts"
import { type DispatchClaim } from "../storage/index.ts"
import { ExecutionFailure, type AttemptInput } from "./contracts.ts"
import {
  type ReviewedUnit,
  type Reviewed,
  conciseProblems,
  rejectionMessage,
  reviewUnavailable,
  preflightUnavailable,
  specFor,
  type StageError,
  reviewLoop,
} from "./pipeline-shared.ts"
import { type StageContext } from "./stage-context.ts"

export const makeMuseReview = (context: StageContext) => {
  const { attemptCall, reviewAttempt } = context
  const reviewedMetaCall = Effect.fnUntraced(function* <A, F>(
    claim: DispatchClaim,
    unit: ReviewedUnit<A, F>,
    initialAttempt?: ReturnType<typeof attemptCall>,
  ) {
    const validate = (value: Schema.Json) => Result.mapError(unit.check(value), (problems) => invalidStage(rejectionMessage(problems)))
    const attemptIds: Array<ProviderAttemptId> = []
    let problems: ReadonlyArray<string> | null = null
    let lastRejected: Schema.Json | null = null
    const record = (outcome: MuseReview["outcome"], fallback: string | null): MuseReview | null => {
      const [first, ...rest] = attemptIds
      return problems === null || first === undefined
        ? null
        : {
            stage: unit.stage,
            agent: museReviewAgentId(unit.stage),
            pageIds: unit.pageIds,
            figureId: unit.figureId,
            problems: conciseProblems(problems),
            rounds: attemptIds.length - 1,
            attemptIds: [first, ...rest],
            outcome,
            fallback,
          }
    }
    const fallBack = (reason: string): Effect.Effect<Reviewed<A, F>, ExecutionFailure> => {
      const safe = unit.fallback(lastRejected)
      if (safe === null) return Effect.fail(invalidStage(reason))
      return Effect.succeed({
        _tag: "fallback",
        value: safe.value,
        attemptId: attemptIds.at(-1) ?? null,
        review: record("fallback", safe.summary),
        reason: safe.summary,
      })
    }
    let request = unit.request
    let retry: AttemptInput["retry"] = { _tag: "none" }
    return yield* reviewLoop(
      0,
      museReviewRounds,
      Effect.fnUntraced(function* (round: number): Effect.fn.Return<Reviewed<A, F> | null, StageError> {
        const call = { ...unit, request, validate }
        const outcome = yield* reviewAttempt(
          claim,
          round === 0 && initialAttempt !== undefined ? initialAttempt : attemptCall(claim, call, retry),
          unit.check,
          false,
          (failure, phase) =>
            round === 0
              ? unit.unavailable?.(failure, phase === "dispatched") === true
              : phase === "preflight"
                ? preflightUnavailable(failure)
                : reviewUnavailable(failure),
        )
        if (outcome._tag === "unavailable") return yield* fallBack(outcome.failure.message)
        const { response: rejected, answer: decoded, verdict } = outcome
        if (Result.isSuccess(verdict)) {
          if (round > 0) attemptIds.push(rejected.receipt.id)
          return {
            _tag: "accepted",
            value: verdict.success,
            receipt: rejected.receipt,
            review: round === 0 ? null : record("corrected", null),
          } satisfies Reviewed<A, F>
        }
        const current = verdict.failure
        attemptIds.push(rejected.receipt.id)
        problems ??= current
        if (decoded !== null) lastRejected = decoded
        const state = rejected.receipt.state
        const text = metaAssistantText(rejected.response)
        if (round >= museReviewRounds || text === null || state._tag !== "completed") return yield* fallBack(rejectionMessage(current))
        const review = boundRequest(
          makeMuseReviewRequest(unit.stage, specFor(claim, unit.stage), unit.request, {
            round: round + 1,
            rejectedAnswer: text,
            rejectedAnswerSha256: state.responseHash,
            problems: conciseProblems(current),
          }),
          unit.limits,
        )
        if (Result.isFailure(review)) return yield* fallBack(review.failure.message)
        request = review.success
        retry = {
          _tag: "review",
          previousAttemptId: rejected.receipt.id,
          round: round === 0 ? 1 : 2,
          headroomMicrousd: Math.max(0, unit.headroomMicrousd),
        }
        return null
      }),
      Effect.die("Muse review must finish within its round limit"),
    )
  })

  return { reviewedMetaCall }
}
