import { Result, Schema } from "effect"
import { HeadingDecision, type Block, type BlockId, type Extraction } from "../../domain/index.ts"
import { canJoinSources } from "../../domain/continuation.ts"
import type { ExecutionFailure } from "../../processing/index.ts"
import type { CorrectedText } from "../correction/contracts.ts"
import { formatCorrectedText, headingMark, oneHeadingLine, withoutHeadingMark } from "../correction/format.ts"
import { validateCorrectedText } from "../correction/page-check.ts"
import { boundRequest, invalidStage, stageJsonSchema, type StageRequestLimits } from "../correction/requests.ts"
import { makeMetaRequest, type MetaRequest, type MetaStageSpec } from "../providers/meta/contracts.ts"
import { HEADING_CHECK_PROMPT } from "./prompt.ts"

export const HeadingResponse = Schema.Struct({ headings: Schema.Array(HeadingDecision) })
export type HeadingResponse = typeof HeadingResponse.Type
export const headingsSpec: MetaStageSpec = { instructions: HEADING_CHECK_PROMPT, promptName: "headings", promptVersion: "amuseme-1", schema: stageJsonSchema(HeadingResponse) }

export const headingCandidates = (corrected: CorrectedText) => corrected.blocks.filter((block) => block.kind === "heading" || block.kind === "paragraph").map((block) => ({
  blockId: block.id, firstLine: withoutHeadingMark(block.content).split(/\r?\n/u)[0] ?? "", mark: headingMark(block.content), blockType: block.kind, content: block.content,
}))

export const buildHeadingRequest = (extraction: Extraction, corrected: CorrectedText, limits: StageRequestLimits): Result.Result<MetaRequest, ExecutionFailure> => validateCorrectedText(extraction, corrected).pipe(Result.flatMap(() => boundRequest(makeMetaRequest("headings", headingsSpec, [{ type: "text", text: JSON.stringify({ document: formatCorrectedText(extraction, corrected.blocks), candidates: headingCandidates(corrected) }) }], limits.maxOutputTokens), { ...limits, imageTokenUpperBound: 0 })))

export const validateHeadingResponse = (extraction: Extraction, corrected: CorrectedText, value: unknown): Result.Result<HeadingResponse, ExecutionFailure> => {
  const valid = validateCorrectedText(extraction, corrected)
  if (Result.isFailure(valid)) return Result.fail(valid.failure)
  const response = Schema.decodeUnknownResult(HeadingResponse)(value, { onExcessProperty: "error" })
  if (Result.isFailure(response)) return Result.fail(invalidStage("Heading response does not match its schema"))
  const candidates = headingCandidates(corrected)
  if (response.success.headings.length !== candidates.length || response.success.headings.filter((decision) => decision.level === 1).length > 1 || response.success.headings.some((decision, index) => {
    const candidate = candidates[index]
    return candidate === undefined || candidate.blockId !== decision.blockId || (decision.level !== null && !oneHeadingLine(candidate.content)) || (candidate.content.trim() !== "" && withoutHeadingMark(candidate.content).trim() === "")
  })) return Result.fail(invalidStage("Heading decisions must classify every eligible source block exactly once in order"))
  return Result.succeed(response.success)
}

export interface HeadingResolution {
  readonly blocks: ReadonlyArray<Block>
  readonly headingDecisions: ReadonlyArray<typeof HeadingDecision.Type>
  readonly appliedJoinCount: number
  readonly changedHeadingCount: number
}

const joinText = (first: string, second: string, answer: "same" | "word"): string => {
  const left = first.trimEnd()
  const right = second.trim()
  return answer === "word" ? left.replace(/[-‐]$/u, "") + right : /[-‐]$/u.test(left) ? left + right : `${left} ${right}`
}

export const applyHeadingDecisions = (extraction: Extraction, corrected: CorrectedText, response: HeadingResponse): Result.Result<HeadingResolution, ExecutionFailure> => {
  const valid = validateHeadingResponse(extraction, corrected, response)
  if (Result.isFailure(valid)) return Result.fail(valid.failure)
  const decisions = new Map(response.headings.map((decision) => [decision.blockId, decision.level]))
  let changedHeadingCount = 0
  const resolved: Array<Block> = corrected.blocks.map((block): Block => {
    const level = decisions.get(block.id)
    const kind = level === undefined ? block.kind : level === null ? "paragraph" : "heading"
    const content = level === undefined ? block.content : level === null ? withoutHeadingMark(block.content) : `${"#".repeat(level)} ${withoutHeadingMark(block.content).trim()}`
    if (level !== undefined && (kind !== block.kind || content !== block.content)) changedHeadingCount += 1
    return { ...block, kind, content, headingLevel: level ?? null, sourceBlockIds: [block.id] }
  })
  const joins = new Map<BlockId, CorrectedText["joins"][number]>(corrected.joins.map((join) => [join.secondBlockId, join]))
  const blocks: Array<Block> = []
  let appliedJoinCount = 0
  for (const block of resolved) {
    const join = joins.get(block.id)
    const previousIndex = join === undefined ? -1 : blocks.findIndex((candidate) => candidate.sourceBlockIds.at(-1) === join.firstBlockId)
    const previous = blocks[previousIndex]
    const previousSource = join === undefined ? undefined : extraction.sourceBlocks.find((source) => source.id === join.firstBlockId)
    if (previous !== undefined && previousSource !== undefined && join !== undefined && previous.kind === "paragraph" && block.kind === "paragraph" && canJoinSources(extraction, previousSource, block)) {
      blocks[previousIndex] = { ...previous, content: joinText(previous.content, block.content, join.answer), sourceBlockIds: [...previous.sourceBlockIds, ...block.sourceBlockIds], locations: [...previous.locations, ...block.locations] }
      appliedJoinCount += 1
    } else blocks.push(block)
  }
  return Result.succeed({ blocks, headingDecisions: response.headings, appliedJoinCount, changedHeadingCount })
}
