import { NodeServices } from "@effect/platform-node"
import { Effect, Result } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { contractFixture } from "../fixtures/contracts.ts"
import { validatePageExtraction, pageExtractionSpec, cropBox, convertPageExtraction } from "../../src/paper/extraction/page.ts"
import { strictSchema } from "../../src/paper/providers/meta/contracts.ts"
import { assembleDocument, exportDocument } from "../../src/paper/reading/index.ts"
import { prepareReading } from "./reading/fixtures.ts"

const page = contractFixture().extraction.pages[0]!
const block = { kind: "paragraph", content: "Literal source", format: "text", furniture: null } as const
const response = { pageNumber: 1, coverage: "complete", blank: false, blocks: [block], figures: [] }
describe("document page extraction", () => {
  it("uses strict v2 schema and accepts explicit blank pages", () => {
    expect(strictSchema(pageExtractionSpec.schema)).toBe(true)
    expect(Result.isSuccess(validatePageExtraction(page, { ...response, blank: true, blocks: [] }))).toBe(true)
    expect(Result.isFailure(validatePageExtraction(page, { ...response, blank: true }))).toBe(true)
    expect(Result.isFailure(validatePageExtraction(page, { ...response, blocks: [] }))).toBe(true)
  })
  it("checks physical page identity and complete coverage", () => {
    expect(Result.isFailure(validatePageExtraction(page, { ...response, pageNumber: 2 }))).toBe(true)
    expect(Result.isFailure(validatePageExtraction(page, { ...response, coverage: "incomplete" }))).toBe(true)
  })
  it("preserves supported code verbatim and warns only for unknown non-furniture content", () => {
    const fixture = contractFixture()
    const content = "```python\r\nfor α in values:\r\n\tprint(α)  \r\n```"
    const blocks = [{ kind: "code", content, format: "markdown", furniture: null }, { kind: "unclassified", content: "Unknown notation [unreadable]", format: "text", furniture: null }, { kind: "note", content: "7", format: "text", furniture: "page_number" }]
    const checked = validatePageExtraction(page, { ...response, blocks })
    expect(Result.isSuccess(checked)).toBe(true)
    if (Result.isFailure(checked)) return
    const result = convertPageExtraction(fixture.document, fixture.run.id, page, checked.success, new Map())
    expect(result.extraction.sourceBlocks[0]).toEqual({ id: "page-1-block-1", kind: "code", readingOrder: 0, content, format: "markdown", locations: [{ _tag: "page", pageId: page.id, pageNumber: 1 }] })
    expect(result.extraction.sourceBlocks.map((source) => [source.content, source.format])).toEqual(blocks.map((source) => [source.content, source.format]))
    expect(result.issues).toMatchObject([{ code: "unclassified-content", blockIds: ["page-1-block-2"], locations: [{ _tag: "page", pageId: page.id, pageNumber: 1 }] }])
    expect(result.extraction.pageFurniture).toEqual([{ blockId: "page-1-block-3", role: "page_number" }])
  })
  it.effect("retains code classification, exact bytes and locations through assembly and export", () => Effect.gen(function* () {
    const fixture = contractFixture()
    const content = "```python\r\nfor α in values:\r\n\tprint(α)  \r\n```"
    const checked = yield* Effect.fromResult(validatePageExtraction(page, { ...response, blocks: [{ kind: "code", content, format: "markdown", furniture: null }, { kind: "unclassified", content: "Unresolved notation", format: "text", furniture: null }] }))
    const converted = convertPageExtraction(fixture.document, fixture.run.id, page, checked, new Map())
    const assembled = yield* Effect.fromResult(assembleDocument(yield* prepareReading({ ...fixture, extraction: converted.extraction })))
    expect(assembled.canonical.sourceBlocks).toEqual(converted.extraction.sourceBlocks)
    expect(assembled.canonical.blocks[0]).toMatchObject({ kind: "code", content, format: "markdown", sourceBlockIds: ["page-1-block-1"], locations: [{ _tag: "page", pageId: page.id, pageNumber: 1 }] })
    expect(assembled.report.issues).toMatchObject([{ code: "unclassified-content", blockIds: ["page-1-block-2"] }])
    const exported = yield* exportDocument(assembled, [])
    const text = new TextDecoder().decode(exported.files.find((file) => file.entry.path === "normalized.txt")?.bytes)
    expect(text).toContain(`[page-1-block-1][code; markdown] Sources: page-1-block-1\nLocations: page 1/page-1\n${content}`)
    expect(text.split(content)).toHaveLength(2)
    const json = JSON.parse(new TextDecoder().decode(exported.files.find((file) => file.entry.path === "document.json")?.bytes))
    expect(json.sourceBlocks[0]).toEqual(converted.extraction.sourceBlocks[0])
    expect(json.blocks[0]).toEqual(assembled.canonical.blocks[0])
    expect(exported.publication.report.issues).toMatchObject([{ code: "unclassified-content", blockIds: ["page-1-block-2"] }])
  }).pipe(Effect.provide(NodeServices.layer)))
  it("rounds a proposed region outward and refuses one pixel beyond a page", () => {
    expect(cropBox( { x: 1.2, y: 2.1, width: 10.3, height: 20.2 })).toEqual({ coordinateSystem: "rendered-page-top-left-pixels", x: 1, y: 2, width: 11, height: 21 })
    const figure = { kind: "figure", content: "[Figure]", format: "text", furniture: null }
    const value = { ...response, blocks: [figure], figures: [{ blockIndex: 0, captionBlockIndices: [], box: { x: 0, y: 0, width: page.width, height: page.height } }] }
    expect(Result.isSuccess(validatePageExtraction(page, value))).toBe(true)
    expect(Result.isFailure(validatePageExtraction(page, { ...value, figures: [{ ...value.figures[0], box: { x: 0, y: 0, width: page.width + 1, height: page.height } }] }))).toBe(true)
    expect(Result.isFailure(validatePageExtraction(page, { ...value, figures: [{ ...value.figures[0], blockIndex: 1 }] }))).toBe(true)
    expect(Result.isFailure(validatePageExtraction(page, { ...value, figures: [value.figures[0], value.figures[0]] }))).toBe(true)
    expect(Result.isFailure(validatePageExtraction(page, { ...value, figures: [{ ...value.figures[0], captionBlockIndices: [0] }] }))).toBe(true)
  })
})
