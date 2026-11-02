import { Result, Schema } from "effect"
import { CanonicalDocument, GuideContent } from "../../domain/index.ts"
import type { ExecutionFailure } from "../../processing/contracts.ts"
import { boundRequest, invalidStage, stageJsonSchema, type StageRequestLimits } from "../correction/requests.ts"
import { makeMetaRequest, type MetaRequest, type MetaStageSpec } from "../providers/meta/contracts.ts"
import { guideInput } from "./evidence.ts"
import { READING_GUIDE_PROMPT } from "./prompt.ts"

export { guideInput, guideResponseProblems, validateGuideResponse, verifySavedGuide } from "./evidence.ts"
export const guideSpec: MetaStageSpec = { instructions: READING_GUIDE_PROMPT, promptName: "reading-guide", promptVersion: "amuseme-1", schema: stageJsonSchema(GuideContent) }

export const buildGuideRequest = (canonical: CanonicalDocument, limits: StageRequestLimits): Result.Result<MetaRequest, ExecutionFailure> => {
  const decoded = Schema.decodeUnknownResult(CanonicalDocument)(canonical, { onExcessProperty: "error" })
  if (Result.isFailure(decoded) || !canonical.sourceBlocks.some((block) => block.content.trim() !== "") || new Set(canonical.sourceBlocks.map((block) => block.id)).size !== canonical.sourceBlocks.length) return Result.fail(invalidStage("The reading guide requires valid immutable source blocks"))
  return boundRequest(makeMetaRequest("guide", guideSpec, [{ type: "text", text: JSON.stringify(guideInput(decoded.success)) }], limits.maxOutputTokens), { ...limits, imageTokenUpperBound: 0 })
}

