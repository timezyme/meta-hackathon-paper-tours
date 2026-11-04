import { Crypto, Effect, Result, Schema } from "effect"
import { ArtifactHash, GuideContent, guideSourceProblems, type CanonicalDocument, type StageReceipt } from "../../domain/index.ts"
import { executionFailure, type ExecutionFailure } from "../../processing/contracts.ts"
import { decodeMetaOutput, stableJson } from "../providers/meta/contracts.ts"

const invalidGuide = (message: string) => executionFailure("invalid-provider-response", message)
const invalidSavedGuide = () => executionFailure("invalid-provider-response", "The reading guide differs from its saved provider evidence")

export const guideInput = (canonical: CanonicalDocument) => ({
  sourceHash: canonical.sourceHash,
  sourceBlocks: canonical.sourceBlocks.map(({ id, kind, content }) => ({ id, kind, content })),
  normalizedBlocks: canonical.blocks.map(({ id, sourceBlockIds, kind, content }) => ({ id, sourceBlockIds, kind, content })),
  figureContext: canonical.figures.map(({ id, captionBlockIds, originalCaption, description }) => ({ id, captionBlockIds, originalCaption, aiDescription: description._tag === "generated" ? description.text : null })),
})

const guideSchemaProblem = "The answer does not match the bounded reading-guide schema (field lengths, at most 10 steps, 6 claims, 3 limits and 4 sources per passage)"
export const guideResponseProblems = (canonical: CanonicalDocument, value: unknown): Result.Result<GuideContent, ReadonlyArray<string>> => {
  const decoded = Schema.decodeUnknownResult(GuideContent)(value, { onExcessProperty: "error" })
  if (Result.isFailure(decoded)) return Result.fail([guideSchemaProblem])
  const problems = guideSourceProblems(decoded.success, canonical.sourceBlocks)
  return problems.length === 0 ? Result.succeed(decoded.success) : Result.fail(problems)
}
export const validateGuideResponse = (canonical: CanonicalDocument, value: unknown): Result.Result<GuideContent, ExecutionFailure> =>
  guideResponseProblems(canonical, value).pipe(Result.mapError((problems) => invalidGuide(problems[0] === guideSchemaProblem
    ? "The reading guide does not match its bounded schema" : "Every guide quotation must match a unique passage in its immutable source block")))

export const verifySavedGuide = Effect.fn("verifySavedGuide")(function* (canonical: CanonicalDocument, receipt: StageReceipt, response: Schema.Json) {
  const guide = canonical.guide
  if (guide === undefined || receipt.stage !== "guide" || guide.providerAttemptId !== receipt.id || receipt.state._tag !== "completed" || receipt.state.validation._tag !== "accepted") return yield* invalidSavedGuide()
  const crypto = yield* Crypto.Crypto
  const hash = (text: string) => crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(Effect.map((bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")), Effect.mapError(invalidSavedGuide))
  if (receipt.state.responseHash !== (yield* hash(stableJson(response))) || receipt.inputHashes.length !== 2 || receipt.inputHashes[0] !== ArtifactHash.make(canonical.sourceHash) || receipt.inputHashes[1] !== (yield* hash(JSON.stringify(guideInput(canonical))))) return yield* invalidSavedGuide()
  const saved = yield* Effect.fromResult(validateGuideResponse(canonical, yield* decodeMetaOutput(response)))
  const { providerAttemptId: _providerAttemptId, ...content } = guide
  if (!Schema.toEquivalence(GuideContent)(saved, content)) return yield* invalidSavedGuide()
})
