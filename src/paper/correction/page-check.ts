import { Result, Schema } from "effect"
import { PageCheck, validateCheckedPages, validatePageCheck, type BlockId, type CheckedPage, type Extraction, type PageId, type SourceBlock } from "../../domain/index.ts"
import { executionFailure, type ExecutionFailure } from "../../processing/index.ts"
import { makeMetaRequest, type MetaRequest, type MetaStageSpec } from "../providers/meta/contracts.ts"
import { CorrectedText } from "./contracts.ts"
import { preservesOneBlock, restoreHeadingMark } from "./format.ts"
import { PAGE_REVIEW_PROMPT } from "./prompt.ts"
import { boundRequest, imageContent, invalidStage, stageJsonSchema, type StageRequestLimits } from "./requests.ts"

export const pageCheckSpec: MetaStageSpec = { instructions: PAGE_REVIEW_PROMPT, promptName: "page-check", promptVersion: "amuseme-2", schema: stageJsonSchema(PageCheck) }
const onPage = (block: SourceBlock, pageId: PageId): boolean => block.locations.some((location) => location.pageId === pageId)
const replacementContent = (block: SourceBlock, content: string): string => block.kind === "table" ? content : restoreHeadingMark(block.content, content)

export const previousPageContext = (extraction: Extraction, pageId: PageId): ReadonlyArray<SourceBlock> => {
  const page = extraction.pages.find((item) => item.id === pageId)
  const previous = page === undefined ? undefined : extraction.pages.find((item) => item.pageNumber === page.pageNumber - 1)
  if (previous === undefined) return []
  const blocks = extraction.sourceBlocks.filter((block) => onPage(block, previous.id))
  let start = blocks.length
  let paragraphs = 0
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.kind === "paragraph") {
      start = index
      paragraphs += 1
      if (paragraphs === 3) break
    }
  }
  return blocks.slice(start)
}

export const buildPageCheckRequest = (extraction: Extraction, pageId: PageId, verifiedPng: Uint8Array, limits: StageRequestLimits): Result.Result<{ readonly request: MetaRequest; readonly previousContextIds: ReadonlyArray<BlockId> }, ExecutionFailure> => {
  const page = extraction.pages.find((item) => item.id === pageId)
  if (page === undefined) return Result.fail(executionFailure("conflict", "Page check targets an unknown source page"))
  const image = imageContent(verifiedPng, "image/png", page.image.byteCount)
  if (Result.isFailure(image)) return Result.fail(image.failure)
  const previous = previousPageContext(extraction, pageId)
  const text = JSON.stringify({ previousPageContext: previous, currentPage: { pageId, pageNumber: page.pageNumber, blocks: extraction.sourceBlocks.filter((block) => onPage(block, pageId)) } })
  return boundRequest(makeMetaRequest("page-check", pageCheckSpec, [{ type: "text", text }, image.success], limits.maxOutputTokens), limits).pipe(Result.map((request) => ({ request, previousContextIds: previous.map((block) => block.id) })))
}

export const validatePageResponse = (extraction: Extraction, pageId: PageId, value: unknown): Result.Result<PageCheck, ExecutionFailure> => {
  const result = Schema.decodeUnknownResult(PageCheck)(value, { onExcessProperty: "error" })
  if (Result.isFailure(result)) return Result.fail(invalidStage("Page response does not match PageCheck"))
  const issues = validatePageCheck(extraction, pageId, previousPageContext(extraction, pageId).map((block) => block.id), result.success)
  if (issues.length > 0 || result.success.fixes.some((fix) => {
    const original = extraction.sourceBlocks.find((block) => block.id === fix.blockId)
    if (original === undefined) return true
    if (original.kind === "table" && (original.format === "text" || original.format === "html" && /^<table[\s>][\s\S]*<\/table>$/iu.test(fix.content.trim()))) return false
    return !preservesOneBlock(replacementContent(original, fix.content))
  })) return Result.fail(invalidStage("Page response changes invalid blocks, deletes text, or proposes invalid joins"))
  return Result.succeed(result.success)
}

export const applyPageChecks = (extraction: Extraction, checkedPages: ReadonlyArray<CheckedPage>): Result.Result<CorrectedText, ExecutionFailure> => {
  if (validateCheckedPages(extraction, checkedPages).length > 0) return Result.fail(invalidStage("Every source page needs one valid, matching page check"))
  const fixes = new Map<BlockId, string>()
  for (const checked of checkedPages) {
    const context = previousPageContext(extraction, checked.pageId).map((block) => block.id)
    if (JSON.stringify(context) !== JSON.stringify(checked.previousContextIds)) return Result.fail(invalidStage("Page check context does not match the original preceding page"))
    const result = validatePageResponse(extraction, checked.pageId, checked.result)
    if (Result.isFailure(result)) return Result.fail(result.failure)
    for (const fix of result.success.fixes) {
      if (fixes.has(fix.blockId)) return Result.fail(invalidStage("A source block was corrected more than once"))
      fixes.set(fix.blockId, fix.content)
    }
  }
  const changedBlockIds: Array<BlockId> = []
  const blocks = extraction.sourceBlocks.map((block) => {
    const replacement = fixes.get(block.id)
    const content = replacement === undefined ? block.content : replacementContent(block, replacement)
    if (content !== block.content) changedBlockIds.push(block.id)
    return { ...block, content }
  })
  return Result.succeed({ scope: extraction.scope, blocks, joins: checkedPages.flatMap((page) => page.result.joins), changedBlockIds, checkedPages: [...checkedPages] })
}

const equalCorrected = Schema.toEquivalence(CorrectedText)
export const validateCorrectedText = (extraction: Extraction, corrected: CorrectedText): Result.Result<CorrectedText, ExecutionFailure> => applyPageChecks(extraction, corrected.checkedPages).pipe(Result.flatMap((expected) => equalCorrected(expected, corrected) ? Result.succeed(corrected) : Result.fail(invalidStage("Corrected text does not match its original extraction and page checks"))))
