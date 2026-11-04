import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { BlockId, CanonicalDocument, PageId, validateCanonicalDocument, type Extraction } from "../../src/domain/index.ts"
import { applyPageChecks, buildPageCheckRequest, validatePageResponse } from "../../src/paper/correction/index.ts"
import { applyHeadingDecisions } from "../../src/paper/headings/index.ts"
import { printNormalizedDocument } from "../../src/paper/reading/export.ts"
import { canJoinSources } from "../../src/domain/continuation.ts"
import { contractFixture } from "../fixtures/contracts.ts"
import { pageChecks, pngBytes, stageExtraction, stageLimits } from "./correction-fixtures.ts"

const fixture = (): Extraction => ({
  ...stageExtraction([["paragraph", "The library offers", 1], ["unclassified", "Author DOI footer", 1], ["unclassified", "Journal logo", 2], ["unclassified", "Journal header", 2], ["paragraph", "practitioners a method.", 2]]),
  pageFurniture: [{ blockId: BlockId.make("block-2"), role: "footer" }, { blockId: BlockId.make("block-3"), role: "header" }, { blockId: BlockId.make("block-4"), role: "header" }],
})
const proposal = { fixes: [], joins: [{ firstBlockId: BlockId.make("block-1"), secondBlockId: BlockId.make("block-5"), answer: "same" as const }] }
const prepare = (input: Extraction) => Result.getOrThrow(buildPageCheckRequest(input, PageId.make("page-2"), pngBytes, stageLimits))

describe("cross-page continuation with retained furniture", () => {
  it("joins the complete paragraph without absorbing, dropping, or relocating furniture anchors", () => {
    const extraction = fixture()
    const corrected = Result.getOrThrow(applyPageChecks(extraction, pageChecks(extraction, { "page-2": proposal })))
    const headings = Result.getOrThrow(applyHeadingDecisions(extraction, corrected, { headings: [{ blockId: BlockId.make("block-1"), level: null }, { blockId: BlockId.make("block-5"), level: null }] }))
    expect(headings.appliedJoinCount).toBe(1)
    expect(headings.blocks.map((block) => block.id)).toEqual(["block-1", "block-2", "block-3", "block-4"])
    expect(headings.blocks[0]).toMatchObject({ content: "The library offers practitioners a method.", sourceBlockIds: ["block-1", "block-5"], readingOrder: 0 })
    expect(headings.blocks[0]?.locations.map((location) => location.pageNumber)).toEqual([1, 2])
    const base = contractFixture("cross-page")
    const canonical = Schema.decodeUnknownSync(CanonicalDocument)({ ...base.canonical, sourceBlocks: extraction.sourceBlocks, pageFurniture: extraction.pageFurniture, blocks: headings.blocks, headingDecisions: headings.headingDecisions })
    expect(validateCanonicalDocument(base.document, extraction, canonical)).toEqual([])
    const text = printNormalizedDocument(canonical)
    for (const fragment of ["The library offers practitioners a method.", "Author DOI footer", "Journal logo", "Journal header", "Source content on this page is included in [block-1]."]) expect(text).toContain(fragment)
    expect(validateCanonicalDocument(base.document, extraction, { ...canonical, blocks: headings.blocks.filter((block) => block.id !== "block-2") }).some((issue) => issue.code === "coverage")).toBe(true)
    expect(validateCanonicalDocument(base.document, extraction, { ...canonical, pageFurniture: [] }).some((issue) => issue.code === "coverage")).toBe(true)
  })

  it("requires native classification and correct page-boundary roles, never a substantive or unknown gap", () => {
    const original = fixture()
    const variants: ReadonlyArray<Extraction> = [
      { ...original, pageFurniture: undefined },
      { ...original, pageFurniture: original.pageFurniture?.slice(1) },
      { ...original, pageFurniture: original.pageFurniture?.map((item) => ({ ...item, role: "footer" as const })) },
      { ...original, sourceBlocks: original.sourceBlocks.map((block) => block.id === "block-3" ? { ...block, kind: "note" as const } : block) },
      { ...original, sourceBlocks: original.sourceBlocks.map((block) => ({ ...block, locations: [{ _tag: "page" as const, pageId: PageId.make("page-2"), pageNumber: 2 }] })) },
    ]
    for (const extraction of variants) expect(Result.isFailure(validatePageResponse(extraction, PageId.make("page-2"), proposal))).toBe(true)
  })

  it("preserves the exact page model request while carrying native provenance separately", () => {
    const extraction = fixture()
    const { pageFurniture: _furniture, ...legacy } = extraction
    expect(prepare(extraction)).toEqual(prepare(legacy))
  })

  it("never joins adjacent source indexes across an intervening physical page", () => {
    const extraction = stageExtraction([["paragraph", "First", 1], ["paragraph", "Third", 3]])
    const [first, second] = extraction.sourceBlocks
    if (first === undefined || second === undefined) throw new Error("Missing fixture")
    expect(canJoinSources(extraction, first, second)).toBe(false)
  })
})
