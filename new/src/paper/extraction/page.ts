import { EXTRACTION_PROMPT_V2 } from "../../domain/prompt-templates.ts"
import { Result, Schema } from "effect"
import { BlockId, FigureId, type Document, type Extraction, type Figure, type ImageArtifact, type Issue, type Page, type PixelBox, type RunId, type SourceBlock } from "../../domain/index.ts"
import { boundRequest, imageContent, invalidStage, stageJsonSchema, type StageRequestLimits } from "../correction/requests.ts"
import { makeMetaRequest } from "../providers/meta/contracts.ts"
import { SparkExtractionResponse } from "./index.ts"

const invalid = () => Result.fail(invalidStage("The extraction does not account for this page or its figure regions"))
const Region = Schema.Struct({ x: Schema.Finite, y: Schema.Finite, width: Schema.Finite, height: Schema.Finite })
export const PageExtractionResponse = Schema.Struct({
  pageNumber: Schema.Int,
  coverage: Schema.Literals(["complete", "incomplete"]),
  blank: Schema.Boolean,
  blocks: SparkExtractionResponse.fields.blocks,
  figures: Schema.Array(Schema.Struct({ blockIndex: Schema.Int, captionBlockIndices: Schema.Array(Schema.Int), box: Schema.NullOr(Region) })),
})
export type PageExtractionResponse = typeof PageExtractionResponse.Type
export const pageExtractionSpec = {
  promptName: "page-extraction", promptVersion: "2",
  instructions: EXTRACTION_PROMPT_V2,
  schema: stageJsonSchema(PageExtractionResponse),
}
export const cropBox = (box: typeof Region.Type): PixelBox => ({
  coordinateSystem: "rendered-page-top-left-pixels", x: Math.floor(box.x), y: Math.floor(box.y),
  width: Math.ceil(box.x + box.width) - Math.floor(box.x), height: Math.ceil(box.y + box.height) - Math.floor(box.y),
})
export const validatePageExtraction = (page: Page, value: unknown) => Schema.decodeUnknownResult(PageExtractionResponse)(value, { onExcessProperty: "error" }).pipe(
  Result.mapError(() => invalidStage("The page extraction response does not match its strict schema")),
  Result.flatMap((response) => {
    if (response.pageNumber !== page.pageNumber || response.coverage !== "complete") return invalid()
    if (response.blank) return response.blocks.length === 0 && response.figures.length === 0 ? Result.succeed(response) : invalid()
    if (response.figures.length > 100 || response.blocks.length === 0 || response.blocks.some((block) => block.content.trim() === "" || block.kind === "table" && block.format !== "html" || block.kind === "figure" && block.furniture !== null)) return invalid()
    const figures = new Set<number>()
    const captions = new Set<number>()
    for (const figure of response.figures) {
      if (figures.has(figure.blockIndex) || response.blocks[figure.blockIndex]?.kind !== "figure") return invalid()
      figures.add(figure.blockIndex)
      for (const index of figure.captionBlockIndices) {
        if (captions.has(index) || response.blocks[index]?.kind !== "caption" || response.blocks[index]?.furniture !== null) return invalid()
        captions.add(index)
      }
      if (figure.box !== null) {
        const box = cropBox(figure.box)
        if (figure.box.x < 0 || figure.box.y < 0 || figure.box.width <= 0 || figure.box.height <= 0 || box.x + box.width > page.width || box.y + box.height > page.height || box.width <= 0 || box.height <= 0) return invalid()
      }
    }
    return response.blocks.some((block, index) => block.kind === "figure" && !figures.has(index)) ? invalid() : Result.succeed(response)
  }),
)
export const buildPageExtractionRequest = (page: Page, pageCount: number, bytes: Uint8Array, limits: StageRequestLimits) => imageContent(bytes, page.image.mediaType, page.image.byteCount).pipe(
  Result.flatMap((image) => boundRequest(makeMetaRequest("extraction", pageExtractionSpec, [{ type: "text", text: JSON.stringify({ pageNumber: page.pageNumber, pageCount, width: page.width, height: page.height }) }, image], limits.maxOutputTokens), limits)),
)
export const convertPageExtraction = (document: Document, runId: RunId, page: Page, response: PageExtractionResponse, assets: ReadonlyMap<number, ImageArtifact>): { readonly extraction: Extraction; readonly issues: ReadonlyArray<Issue> } => {
  const locations = [{ _tag: "page" as const, pageId: page.id, pageNumber: page.pageNumber }] as const
  const sourceBlocks: Array<SourceBlock> = response.blocks.map((block, index) => ({ id: BlockId.make(`page-${page.pageNumber}-block-${index + 1}`), kind: block.kind === "code" || block.furniture !== null ? "unclassified" : block.kind, readingOrder: index, content: block.content, format: block.format, locations }))
  const issues: Array<Issue> = sourceBlocks.filter((block, index) => block.kind === "unclassified" && response.blocks[index]?.furniture === null).map((block) => ({ code: "unclassified-content", message: "Extracted content is retained without a supported block classification.", stage: "extraction", locations, blockIds: [block.id], figureId: null }))
  const figures = response.figures.map((proposal): Figure => {
    const source = sourceBlocks[proposal.blockIndex]!
    const captions = proposal.captionBlockIndices.map((index) => sourceBlocks[index]!)
    const id = FigureId.make(`figure-page-${page.pageNumber}-block-${proposal.blockIndex + 1}`)
    const box = proposal.box === null ? null : cropBox(proposal.box)
    const artifact = assets.get(proposal.blockIndex)
    const reason = "A verified figure region image is unavailable; the figure and caption are retained."
    if (box === null || artifact === undefined) issues.push({ code: "figure-asset-unavailable", message: reason, stage: "extraction", locations, blockIds: [source.id], figureId: id })
    return { id, sourceBlockIds: [source.id], locations, captionBlockIds: captions.map((caption) => caption.id), originalCaption: captions.map((caption) => caption.content).join("\n\n"), asset: box === null || artifact === undefined ? { _tag: "unavailable" as const, reason } : { _tag: "available" as const, artifact, provenance: { _tag: "rendered-page-region" as const, recipe: "page-png-integer-crop-1" as const, sourceHash: document.sourceHash, pageId: page.id, pageNumber: page.pageNumber, pageImageHash: page.image.hash, pageWidth: page.width, pageHeight: page.height, box, width: box.width, height: box.height } }, description: { _tag: "pending" as const } }
  })
  return { extraction: { schemaVersion: "1", scope: { documentId: document.id, runId, sourceHash: document.sourceHash }, pages: [page], sourceBlocks, figures, pageFurniture: response.blocks.flatMap((block, index) => block.furniture === null ? [] : [{ blockId: sourceBlocks[index]!.id, role: block.furniture }]) }, issues }
}
