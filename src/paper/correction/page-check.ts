import { Result, Schema } from "effect"
import { checkedExtraction, furnitureProblems, PageCheck, PageFurniture, validateCheckedPages, validatePageCheck, withFurniture, type BlockId, type CheckedPage, type Extraction, type PageId, type SourceBlock } from "../../domain/index.ts"
import { executionFailure, type ExecutionFailure } from "../../processing/index.ts"
import { makeMetaRequest, type MetaRequest, type MetaStageSpec } from "../providers/meta/contracts.ts"
import { CorrectedText } from "./contracts.ts"
import { preservesOneBlock, restoreHeadingMark } from "./format.ts"
import { PAGE_REVIEW_PROMPT, PAGE_REVIEW_PROMPT_V3, pageCheckPromptVersion } from "../../domain/prompt-templates.ts"
import { boundRequest, imageContent, invalidStage, stageJsonSchema, type StageRequestLimits } from "./requests.ts"

export const PageCheckAnswer = Schema.Struct({ fixes: PageCheck.fields.fixes, joins: PageCheck.fields.joins, furniture: Schema.Array(PageFurniture) })
export const pageCheckSpec: MetaStageSpec = { instructions: PAGE_REVIEW_PROMPT_V3, promptName: "page-check", promptVersion: pageCheckPromptVersion, schema: stageJsonSchema(PageCheckAnswer) }
export const pageCheckSpecV2: MetaStageSpec = { instructions: PAGE_REVIEW_PROMPT, promptName: "page-check", promptVersion: "amuseme-2", schema: stageJsonSchema(Schema.Struct({ fixes: PageCheck.fields.fixes, joins: PageCheck.fields.joins })) }
export const pageCheckSpecFor = (promptVersion: string): MetaStageSpec => promptVersion === pageCheckSpecV2.promptVersion ? pageCheckSpecV2 : pageCheckSpec
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

export const buildPageCheckRequest = (extraction: Extraction, pageId: PageId, verifiedPng: Uint8Array, limits: StageRequestLimits, spec: MetaStageSpec = pageCheckSpec): Result.Result<{ readonly request: MetaRequest; readonly previousContextIds: ReadonlyArray<BlockId> }, ExecutionFailure> => {
  const page = extraction.pages.find((item) => item.id === pageId)
  if (page === undefined) return Result.fail(executionFailure("conflict", "Page check targets an unknown source page"))
  const image = imageContent(verifiedPng, "image/png", page.image.byteCount)
  if (Result.isFailure(image)) return Result.fail(image.failure)
  const previous = previousPageContext(extraction, pageId)
  const text = JSON.stringify({ previousPageContext: previous, currentPage: { pageId, pageNumber: page.pageNumber, blocks: extraction.sourceBlocks.filter((block) => onPage(block, pageId)) } })
  return boundRequest(makeMetaRequest("page-check", spec, [{ type: "text", text }, image.success], limits.maxOutputTokens), limits).pipe(Result.map((request) => ({ request, previousContextIds: previous.map((block) => block.id) })))
}

type PageFix = PageCheck["fixes"][number]
type PageJoin = PageCheck["joins"][number]
const contextIds = (extraction: Extraction, pageId: PageId) => previousPageContext(extraction, pageId).map((block) => block.id)
const fixProblems = (extraction: Extraction, pageId: PageId, context: ReadonlyArray<BlockId>, fix: PageFix): ReadonlyArray<string> => {
  const problems = validatePageCheck(extraction, pageId, context, { fixes: [fix], joins: [] }).map((issue) => `Fix for block ${fix.blockId}: ${issue.message}`)
  const original = extraction.sourceBlocks.find((block) => block.id === fix.blockId)
  if (problems.length > 0 || original === undefined) return problems
  if (original.kind === "table" && (original.format === "text" || original.format === "html" && /^<table[\s>][\s\S]*<\/table>$/iu.test(fix.content.trim()))) return []
  return preservesOneBlock(replacementContent(original, fix.content)) ? [] : [`Fix for block ${fix.blockId}: the replacement must stay exactly one block; a heading block holds only its heading line and no other block gains a heading line`]
}
const joinProblems = (extraction: Extraction, pageId: PageId, context: ReadonlyArray<BlockId>, join: PageJoin, furniture: ReadonlyArray<PageFurniture>): ReadonlyArray<string> =>
  validatePageCheck(withFurniture(extraction, furniture), pageId, context, { fixes: [], joins: [join] }).map((issue) => `Join ${join.firstBlockId} -> ${join.secondBlockId}: ${issue.message}`)
const pageSchemaProblem = "The answer does not match the schema { fixes: [{ blockId, content }], joins: [{ firstBlockId, secondBlockId, answer }], furniture: [{ blockId, role }] }"
type PageFurniture = typeof PageFurniture.Type
const earlierBase = (extraction: Extraction, earlier: ReadonlyArray<PageCheck>): Extraction =>
  earlier.reduce((current, check) => withFurniture(current, check.furniture ?? []), extraction)
const repeated = (values: ReadonlyArray<string>) => values.filter((value, index) => values.indexOf(value) !== index)

export const pageResponseProblems = (extraction: Extraction, pageId: PageId, value: unknown, earlier: ReadonlyArray<PageCheck> = []): Result.Result<PageCheck, ReadonlyArray<string>> => {
  const decoded = Schema.decodeUnknownResult(PageCheck)(value, { onExcessProperty: "error" })
  if (Result.isFailure(decoded)) return Result.fail([pageSchemaProblem])
  const { fixes, joins } = decoded.success
  const furniture = decoded.success.furniture ?? []
  const context = contextIds(extraction, pageId)
  const base = earlierBase(extraction, earlier)
  const earlierFixes = new Set(earlier.flatMap((check) => check.fixes.map((fix) => fix.blockId)))
  const earlierFirst = new Set(earlier.flatMap((check) => check.joins.map((join) => join.firstBlockId)))
  const earlierSecond = new Set(earlier.flatMap((check) => check.joins.map((join) => join.secondBlockId)))
  const problems = [
    ...validatePageCheck(base, pageId, context, { fixes: [], joins: [] }).map((issue) => issue.message),
    ...furnitureProblems(base, pageId, furniture),
    ...[...new Set(repeated(fixes.map((fix) => fix.blockId)))].map((id) => `Block ${id} has more than one fix`),
    ...[...new Set(repeated(joins.map((join) => join.firstBlockId)))].map((id) => `Block ${id} starts more than one join`),
    ...[...new Set(repeated(joins.map((join) => join.secondBlockId)))].map((id) => `Block ${id} continues more than one join`),
    ...fixes.flatMap((fix) => [...fixProblems(base, pageId, context, fix), ...earlierFixes.has(fix.blockId) ? [`Fix for block ${fix.blockId}: an earlier page check already fixed this block`] : []]),
    ...joins.flatMap((join) => [...joinProblems(base, pageId, context, join, furniture),
      ...earlierFirst.has(join.firstBlockId) || earlierSecond.has(join.secondBlockId) ? [`Join ${join.firstBlockId} -> ${join.secondBlockId}: an earlier page check already joins one of these blocks`] : []]),
  ]
  return problems.length === 0 ? Result.succeed(decoded.success) : Result.fail(problems)
}

export const validatePageResponse = (extraction: Extraction, pageId: PageId, value: unknown, earlier: ReadonlyArray<PageCheck> = []): Result.Result<PageCheck, ExecutionFailure> =>
  pageResponseProblems(extraction, pageId, value, earlier).pipe(Result.mapError((problems) => invalidStage(problems[0] === pageSchemaProblem
    ? "Page response does not match PageCheck" : "Page response changes invalid blocks, deletes text, or proposes invalid joins")))

export const salvagePageResponse = (extraction: Extraction, pageId: PageId, value: unknown, earlier: ReadonlyArray<PageCheck> = []): { readonly result: PageCheck; readonly dropped: number } => {
  const decoded = Schema.decodeUnknownResult(PageCheck)(value, { onExcessProperty: "error" })
  if (Result.isFailure(decoded)) return { result: { fixes: [], joins: [] }, dropped: 0 }
  const proposed = decoded.success.furniture ?? []
  const furniture: Array<PageFurniture> = []
  const keeps = (check: PageCheck) => Result.isSuccess(pageResponseProblems(extraction, pageId, check, earlier))
  for (let added = true; added;) {
    added = false
    for (const item of proposed) {
      if (furniture.includes(item) || !keeps({ fixes: [], joins: [], furniture: [...furniture, item] })) continue
      furniture.push(item)
      added = true
    }
  }
  const withAnswerFurniture = (check: Omit<PageCheck, "furniture">): PageCheck => decoded.success.furniture === undefined ? check : { ...check, furniture }
  const fixes: Array<PageFix> = []
  const joins: Array<PageJoin> = []
  for (const fix of decoded.success.fixes) if (keeps(withAnswerFurniture({ fixes: [...fixes, fix], joins: [] }))) fixes.push(fix)
  for (const join of decoded.success.joins) if (keeps(withAnswerFurniture({ fixes, joins: [...joins, join] }))) joins.push(join)
  const total = decoded.success.fixes.length + decoded.success.joins.length + proposed.length
  const result = withAnswerFurniture({ fixes, joins })
  return keeps(result) ? { result, dropped: total - fixes.length - joins.length - furniture.length } : { result: { fixes: [], joins: [] }, dropped: total }
}

export const applyPageChecks = (extraction: Extraction, checkedPages: ReadonlyArray<CheckedPage>): Result.Result<CorrectedText, ExecutionFailure> => {
  if (validateCheckedPages(extraction, checkedPages).length > 0) return Result.fail(invalidStage("Every source page needs one valid, matching page check"))
  const withCheckedFurniture = checkedExtraction(extraction, checkedPages)
  const fixes = new Map<BlockId, string>()
  const pageNumber = (checked: CheckedPage) => extraction.pages.find((page) => page.id === checked.pageId)?.pageNumber ?? 0
  for (const checked of checkedPages) {
    const context = previousPageContext(extraction, checked.pageId).map((block) => block.id)
    if (JSON.stringify(context) !== JSON.stringify(checked.previousContextIds)) return Result.fail(invalidStage("Page check context does not match the original preceding page"))
    const earlier = checkedPages.filter((other) => pageNumber(other) < pageNumber(checked)).toSorted((left, right) => pageNumber(left) - pageNumber(right)).map((other) => other.result)
    const result = validatePageResponse(extraction, checked.pageId, checked.result, earlier)
    if (Result.isFailure(result)) return Result.fail(result.failure)
    for (const fix of result.success.fixes) {
      if (fixes.has(fix.blockId)) return Result.fail(invalidStage("A source block was corrected more than once"))
      fixes.set(fix.blockId, fix.content)
    }
  }
  const changedBlockIds: Array<BlockId> = []
  const blocks = withCheckedFurniture.sourceBlocks.map((block) => {
    const replacement = fixes.get(block.id)
    const content = replacement === undefined ? block.content : replacementContent(block, replacement)
    if (content !== block.content) changedBlockIds.push(block.id)
    return { ...block, content }
  })
  return Result.succeed({ scope: extraction.scope, blocks, joins: checkedPages.flatMap((page) => page.result.joins), changedBlockIds, checkedPages: [...checkedPages] })
}

const equalCorrected = Schema.toEquivalence(CorrectedText)
export const validateCorrectedText = (extraction: Extraction, corrected: CorrectedText): Result.Result<CorrectedText, ExecutionFailure> => applyPageChecks(extraction, corrected.checkedPages).pipe(Result.flatMap((expected) => equalCorrected(expected, corrected) ? Result.succeed(corrected) : Result.fail(invalidStage("Corrected text does not match its original extraction and page checks"))))
