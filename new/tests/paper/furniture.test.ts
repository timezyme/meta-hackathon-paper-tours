import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { BlockId, PageId, checkedExtraction, furnitureProblems, withFurniture, type Extraction, type PageCheck, type SourceBlock } from "../../src/domain/index.ts"
import { canJoinSources } from "../../src/domain/continuation.ts"
import { applyPageChecks, salvagePageResponse, validatePageResponse } from "../../src/paper/correction/index.ts"
import { assembleDocument } from "../../src/paper/reading/index.ts"
import { contractFixture } from "../fixtures/contracts.ts"
import { pageChecks, stageExtraction } from "./correction-fixtures.ts"
import { prepareReading } from "./reading/fixtures.ts"

const page1 = PageId.make("page-1")
const page2 = PageId.make("page-2")
const id = (value: string) => BlockId.make(value)
const prose = "This paragraph explains the method in substantive detail and must never be treated as running page furniture by any reviewer."
const fixture = (rows: ReadonlyArray<readonly [SourceBlock["kind"], string, number]> = [
  ["paragraph", "Journal of Open Source Software", 1],
  ["paragraph", "The library offers", 1],
  ["paragraph", "3", 1],
  ["paragraph", "Journal of Open Source Software", 2],
  ["paragraph", "practitioners a method.", 2],
]): Extraction => stageExtraction(rows)
const header = (blockId: string) => ({ blockId: id(blockId), role: "header" as const })
const footer = (blockId: string) => ({ blockId: id(blockId), role: "footer" as const })
const pageNumber = (blockId: string) => ({ blockId: id(blockId), role: "page_number" as const })
const join = { firstBlockId: id("block-2"), secondBlockId: id("block-5"), answer: "same" as const }
const results = (first: PageCheck, second: PageCheck): Record<string, PageCheck> => ({ "page-1": first, "page-2": second })

describe("page-check furniture classifications", () => {
  it("accepts short repeated running heads and page numbers at the page edges", () => {
    const extraction = fixture()
    expect(furnitureProblems(extraction, page1, [header("block-1"), pageNumber("block-3")])).toEqual([])
    expect(furnitureProblems(extraction, page2, [header("block-4")])).toEqual([])
    expect(furnitureProblems(extraction, page1, [footer("block-3")])).toEqual([])
  })

  it("rejects prose, non-numbers, unique lines, interior blocks, other pages, protected kinds and duplicates", () => {
    const extraction = fixture([
      ["paragraph", "Unique opening line", 1], ["paragraph", prose, 1], ["paragraph", "Running title", 1], ["table", "<table><tr><td>12</td></tr></table>", 1], ["paragraph", "Running title", 2],
    ])
    const rejected = (pageId: PageId, proposals: Parameters<typeof furnitureProblems>[2], fragment: string) => {
      const problems = furnitureProblems(extraction, pageId, proposals)
      expect(problems.length).toBeGreaterThan(0)
      expect(problems.join("\n")).toContain(fragment)
    }
    rejected(page1, [footer("block-2")], "short line")
    rejected(page1, [pageNumber("block-1")], "look like a page number")
    rejected(page1, [header("block-1")], "repeat on another page")
    rejected(page1, [header("block-3")], "before all of this page's other content")
    rejected(page1, [header("block-5")], "only a block on this page")
    rejected(page1, [footer("block-4")], "a table block cannot become page furniture")
    rejected(page2, [header("block-5"), footer("block-5")], "more than once")
  })

  it("rejects a reclassification that conflicts with native furniture and treats a matching one as a no-op", () => {
    const extraction = { ...fixture(), pageFurniture: [pageNumber("block-3")] }
    expect(furnitureProblems(extraction, page1, [pageNumber("block-3")])).toEqual([])
    expect(furnitureProblems(extraction, page1, [footer("block-3")]).join("")).toContain("already page_number")
  })

  it("keeps a cross-page join across accepted furniture and refuses it without the classification", () => {
    const extraction = fixture()
    const second = { fixes: [], joins: [join], furniture: [header("block-4")] }
    expect(Result.isFailure(validatePageResponse(extraction, page2, { fixes: [], joins: [join], furniture: [] }))).toBe(true)
    expect(Result.isFailure(validatePageResponse(extraction, page2, second))).toBe(true)
    const earlier = withFurniture(extraction, [pageNumber("block-3")])
    expect(Result.getOrThrow(validatePageResponse(earlier, page2, second))).toEqual(second)
    const checked = pageChecks(extraction, results({ fixes: [], joins: [], furniture: [header("block-1"), pageNumber("block-3")] }, second))
    const corrected = Result.getOrThrow(applyPageChecks(extraction, checked))
    const effective = checkedExtraction(extraction, checked)
    expect(effective.pageFurniture).toEqual([header("block-1"), pageNumber("block-3"), header("block-4")])
    expect(effective.sourceBlocks.filter((block) => block.kind === "unclassified").map((block) => block.id)).toEqual(["block-1", "block-3", "block-4"])
    expect(corrected.blocks.find((block) => block.id === "block-3")?.kind).toBe("unclassified")
    const [, before, , , after] = effective.sourceBlocks
    const [, nativeBefore, , , nativeAfter] = extraction.sourceBlocks
    if (before === undefined || after === undefined || nativeBefore === undefined || nativeAfter === undefined) throw new Error("Missing fixture blocks")
    expect(canJoinSources(effective, before, after)).toBe(true)
    expect(canJoinSources(extraction, nativeBefore, nativeAfter)).toBe(false)
  })

  it("salvages valid furniture before the joins that depend on it and drops invalid furniture", () => {
    const extraction = withFurniture(fixture(), [pageNumber("block-3")])
    const salvaged = salvagePageResponse(extraction, page2, { fixes: [], joins: [join], furniture: [header("block-4"), header("block-5")] })
    expect(salvaged).toEqual({ result: { fixes: [], joins: [join], furniture: [header("block-4")] }, dropped: 1 })
  })

  it.effect("assembles accepted furniture like native furniture and publishes a valid document", () => Effect.gen(function* () {
    const base = contractFixture("cross-page")
    const extraction = fixture()
    const input = yield* prepareReading({ ...base, extraction }, [{ fixes: [], joins: [], furniture: [header("block-1"), pageNumber("block-3")] }, { fixes: [], joins: [join], furniture: [header("block-4")] }])
    const output = yield* Effect.fromResult(assembleDocument(input))
    expect(output.canonical.pageFurniture).toEqual([header("block-1"), pageNumber("block-3"), header("block-4")])
    expect(output.report.pageCheckFurniture).toEqual([header("block-1"), pageNumber("block-3"), header("block-4")])
    expect(output.report.issues.filter((issue) => issue.code === "unclassified-content")).toEqual([])
    const joined = output.canonical.blocks.find((block) => block.sourceBlockIds.includes(id("block-5")))
    expect(joined).toMatchObject({ content: "The library offers practitioners a method.", sourceBlockIds: ["block-2", "block-5"] })
    for (const furniture of ["block-1", "block-3", "block-4"]) expect(output.canonical.blocks.find((block) => block.id === furniture)?.kind).toBe("unclassified")
    expect(output.extraction.sourceBlocks.find((block) => block.id === "block-2")?.content).toBe("The library offers")
  }))
})
