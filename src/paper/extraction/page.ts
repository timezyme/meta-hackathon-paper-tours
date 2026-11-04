import { EXTRACTION_PROMPT_V2, pageExtractionPromptVersion } from "../../domain/prompt-templates.ts"
import { Brand, Result, Schema } from "effect"
import {
  BlockId, FigureId, type CanonicalDocument, type Document, type DocumentId, type Extraction, type Figure, type ImageArtifact, type Issue, type Page,
  type PixelBox, type RunId, type SourceBlock,
} from "../../domain/index.ts"
import { boundRequest, imageContent, invalidStage, stageJsonSchema, type StageRequestLimits } from "../correction/requests.ts"
import { makeMetaRequest } from "../providers/meta/contracts.ts"
import { SparkExtractionResponse } from "./index.ts"

const Region = Schema.Struct({ x: Schema.Finite, y: Schema.Finite, width: Schema.Finite, height: Schema.Finite })
export const PageExtractionResponse = Schema.Struct({
  pageNumber: Schema.Int,
  coverage: Schema.Literals(["complete", "incomplete"]),
  blank: Schema.Boolean,
  blocks: SparkExtractionResponse.fields.blocks,
  figures: Schema.Array(Schema.Struct({ blockIndex: Schema.Int, captionBlockIndices: Schema.Array(Schema.Int), box: Schema.NullOr(Region) })),
})
export type PageExtractionResponse = typeof PageExtractionResponse.Type
export type ValidatedPageExtraction = Brand.Branded<PageExtractionResponse, "ValidatedPageExtraction">
const ValidatedPageExtraction = Brand.nominal<ValidatedPageExtraction>()
export { pageExtractionPromptVersion }
export const pageExtractionSpec = {
  promptName: "page-extraction", promptVersion: pageExtractionPromptVersion,
  instructions: EXTRACTION_PROMPT_V2,
  schema: stageJsonSchema(PageExtractionResponse),
}
export const cropBox = (box: typeof Region.Type): PixelBox => ({
  coordinateSystem: "rendered-page-top-left-pixels", x: Math.floor(box.x), y: Math.floor(box.y),
  width: Math.ceil(box.x + box.width) - Math.floor(box.x), height: Math.ceil(box.y + box.height) - Math.floor(box.y),
})
export const pageBlockId = (pageNumber: number, index: number) => BlockId.make(`page-${pageNumber}-block-${index + 1}`)
export const pageFigureId = (pageNumber: number, blockIndex: number) => FigureId.make(`figure-page-${pageNumber}-block-${blockIndex + 1}`)
type ExtractedBlock = PageExtractionResponse["blocks"][number]
const outsidePage = (page: Page, region: typeof Region.Type) => {
  const box = cropBox(region)
  return region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0
    || box.x + box.width > page.width || box.y + box.height > page.height || box.width <= 0 || box.height <= 0
}
const blockProblem = (block: ExtractedBlock, index: number): ReadonlyArray<string> => [
  ...block.content.trim() === "" ? [`Block ${index} has empty content`] : [],
  ...block.kind === "table" && block.format !== "html" ? [`Block ${index} is a table and must use the html format`] : [],
  ...block.kind === "figure" && block.furniture !== null ? [`Block ${index} is a figure and cannot be page furniture`] : [],
]
export const pageExtractionProblems = (page: Page, value: unknown): Result.Result<ValidatedPageExtraction, ReadonlyArray<string>> => {
  const decoded = Schema.decodeUnknownResult(PageExtractionResponse)(value, { onExcessProperty: "error" })
  if (Result.isFailure(decoded)) return Result.fail([extractionSchemaProblem])
  const response = decoded.success
  const problems: Array<string> = []
  if (response.pageNumber !== page.pageNumber) problems.push(`pageNumber must be the physical page ${page.pageNumber}, not ${response.pageNumber}`)
  if (response.coverage !== "complete") problems.push("coverage is incomplete; transcribe all visible content and return complete")
  if (response.blank) {
    if (response.blocks.length > 0 || response.figures.length > 0) problems.push("A blank page must have empty blocks and figures; set blank to false when the page has content")
    return problems.length === 0 ? Result.succeed(ValidatedPageExtraction(response)) : Result.fail(problems)
  }
  if (response.blocks.length === 0) problems.push("A page that is not blank needs its visible content as blocks")
  if (response.figures.length > 100) problems.push("At most 100 figures are allowed on one page")
  problems.push(...response.blocks.flatMap(blockProblem))
  const figures = new Set<number>()
  const captions = new Set<number>()
  for (const [entry, figure] of response.figures.entries()) {
    if (figures.has(figure.blockIndex)) problems.push(`Figures entry ${entry} repeats block ${figure.blockIndex}`)
    else if (response.blocks[figure.blockIndex]?.kind !== "figure") problems.push(`Figures entry ${entry} points at block ${figure.blockIndex}, which is not a figure block`)
    figures.add(figure.blockIndex)
    for (const index of figure.captionBlockIndices) {
      if (captions.has(index)) problems.push(`Caption block ${index} belongs to more than one figure`)
      else if (response.blocks[index]?.kind !== "caption" || response.blocks[index]?.furniture !== null) problems.push(`Figures entry ${entry} lists block ${index} as a caption, but it is not a caption block on this page`)
      captions.add(index)
    }
    if (figure.box !== null && outsidePage(page, figure.box)) problems.push(`Figures entry ${entry} has a box outside the ${page.width}x${page.height} rendered page; correct it or use null`)
  }
  for (const [index, block] of response.blocks.entries()) if (block.kind === "figure" && !figures.has(index)) problems.push(`Figure block ${index} has no figures entry`)
  return problems.length === 0 ? Result.succeed(ValidatedPageExtraction(response)) : Result.fail(problems)
}
const extractionSchemaProblem = "The answer does not match the strict page-extraction schema"
export const validatePageExtraction = (page: Page, value: unknown): Result.Result<ValidatedPageExtraction, ReturnType<typeof invalidStage>> =>
  pageExtractionProblems(page, value).pipe(Result.mapError((problems) => problems[0] === extractionSchemaProblem
    ? invalidStage("The page extraction response does not match its strict schema") : invalidStage("The extraction does not account for this page or its figure regions")))
export const buildPageExtractionRequest = (page: Page, pageCount: number, bytes: Uint8Array, limits: StageRequestLimits) =>
  imageContent(bytes, page.image.mediaType, page.image.byteCount).pipe(Result.flatMap((image) => {
    const context = { type: "text" as const, text: JSON.stringify({ pageNumber: page.pageNumber, pageCount, width: page.width, height: page.height }) }
    return boundRequest(makeMetaRequest("extraction", pageExtractionSpec, [context, image], limits.maxOutputTokens), limits)
  }))
export const extractionFromCanonical = (canonical: CanonicalDocument, documentId: DocumentId, runId: RunId): Extraction => ({
  schemaVersion: "1", scope: { documentId, runId, sourceHash: canonical.sourceHash },
  pages: canonical.pages, sourceBlocks: canonical.sourceBlocks, figures: canonical.figures,
  ...(canonical.pageFurniture === undefined ? {} : { pageFurniture: canonical.pageFurniture }),
})
export const convertPageExtraction = (
  document: Document, runId: RunId, page: Page, response: ValidatedPageExtraction, assets: ReadonlyMap<number, ImageArtifact>,
): { readonly extraction: Extraction; readonly issues: ReadonlyArray<Issue> } => {
  const locations = [{ _tag: "page" as const, pageId: page.id, pageNumber: page.pageNumber }] as const
  const sourceBlocks: Array<SourceBlock> = response.blocks.map((block, index) => ({
    id: pageBlockId(page.pageNumber, index), kind: block.furniture !== null ? "unclassified" : block.kind,
    readingOrder: index, content: block.content, format: block.format, locations,
  }))
  // SAFETY: ValidatedPageExtraction guarantees every figure and caption index names one of these blocks.
  const blockAt = (index: number) => sourceBlocks[index]!
  const unclassifiedIssue = (block: SourceBlock): Issue => ({
    code: "unclassified-content", message: "Extracted content is retained without a supported block classification.",
    stage: "extraction", locations, blockIds: [block.id], figureId: null,
  })
  const unclassified = sourceBlocks.filter((block, index) => block.kind === "unclassified" && response.blocks[index]?.furniture === null)
  const issues: Array<Issue> = unclassified.map(unclassifiedIssue)
  const figures = response.figures.map((proposal): Figure => {
    const source = blockAt(proposal.blockIndex)
    const captions = proposal.captionBlockIndices.map(blockAt)
    const id = pageFigureId(page.pageNumber, proposal.blockIndex)
    const box = proposal.box === null ? null : cropBox(proposal.box)
    const artifact = assets.get(proposal.blockIndex)
    const reason = "A verified figure region image is unavailable; the figure and caption are retained."
    if (box === null || artifact === undefined) {
      issues.push({ code: "figure-asset-unavailable", message: reason, stage: "extraction", locations, blockIds: [source.id], figureId: id })
    }
    const asset: Figure["asset"] = box === null || artifact === undefined ? { _tag: "unavailable", reason } : {
      _tag: "available", artifact,
      provenance: {
        _tag: "rendered-page-region", recipe: "page-png-integer-crop-1", sourceHash: document.sourceHash, pageId: page.id, pageNumber: page.pageNumber,
        pageImageHash: page.image.hash, pageWidth: page.width, pageHeight: page.height, box, width: box.width, height: box.height,
      },
    }
    return {
      id, sourceBlockIds: [source.id], locations, captionBlockIds: captions.map((caption) => caption.id),
      originalCaption: captions.map((caption) => caption.content).join("\n\n"), asset, description: { _tag: "pending" },
    }
  })
  const pageFurniture = response.blocks.flatMap((block, index) =>
    block.furniture === null ? [] : [{ blockId: pageBlockId(page.pageNumber, index), role: block.furniture }])
  const scope = { documentId: document.id, runId, sourceHash: document.sourceHash }
  return { extraction: { schemaVersion: "1", scope, pages: [page], sourceBlocks, figures, pageFurniture }, issues }
}
