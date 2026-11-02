import { Crypto, Effect, Result, Schema } from "effect"
import { ArtifactHash, GuideContent, validGuideSources, type CanonicalDocument, type StageReceipt } from "../../domain/index.ts"
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

export const validateGuideResponse = (canonical: CanonicalDocument, value: unknown): Result.Result<GuideContent, ExecutionFailure> => {
  const decoded = Schema.decodeUnknownResult(GuideContent)(value, { onExcessProperty: "error" })
  if (Result.isFailure(decoded)) return Result.fail(invalidGuide("The reading guide does not match its bounded schema"))
  if (!validGuideSources(decoded.success, canonical.sourceBlocks)) return Result.fail(invalidGuide("Every guide quotation must match a unique passage in its immutable source block"))
  return Result.succeed(decoded.success)
}

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
