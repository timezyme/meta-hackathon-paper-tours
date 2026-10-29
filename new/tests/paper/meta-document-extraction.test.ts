import { Result } from "effect"
import { describe, expect, it } from "vitest"
import { contractFixture } from "../fixtures/contracts.ts"
import { validatePageExtraction, pageExtractionSpec, cropBox } from "../../src/paper/extraction/page.ts"
import { strictSchema } from "../../src/paper/providers/meta/contracts.ts"

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
