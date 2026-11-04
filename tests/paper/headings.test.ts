import { Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { CanonicalDocument, PageCheck, validateCanonicalDocument } from "../../src/domain/index.ts"
import { applyPageChecks, formatCorrectedText } from "../../src/paper/correction/index.ts"
import { applyHeadingDecisions, buildHeadingRequest, HeadingResponse, headingCandidates, validateHeadingResponse } from "../../src/paper/headings/index.ts"
import { contractFixture } from "../fixtures/contracts.ts"
import { correctedFixture, pageChecks, stageExtraction, stageLimits } from "./correction-fixtures.ts"

describe("pure heading decisions and deferred joins", () => {
  it("sends all original heading/paragraph candidates and the full corrected document at medium effort", () => {
    const extraction = stageExtraction([["heading", "Paper", 1], ["paragraph", "Methods", 1], ["list", "1. first item", 1], ["table", "<table>full values</table>", 1], ["heading", "References", 2], ["reference", "[1] Full reference", 2], ["note", "Complete footnote", 2]])
    const corrected = correctedFixture(extraction)
    expect(headingCandidates(corrected).map((candidate) => candidate.blockId)).toEqual(["block-1", "block-2", "block-5"])
    const request = Result.getOrThrow(buildHeadingRequest(extraction, corrected, stageLimits))
    expect(request.reasoning_effort).toBe("medium")
    const content = JSON.stringify(request.messages[1].content)
    for (const block of extraction.sourceBlocks) expect(content).toContain(block.content)
    expect(content).toContain("blockId")
  })

  it.each([
    { headings: [{ blockId: "block-1", level: 1 }] },
    { headings: [{ blockId: "block-1", level: 1 }, { blockId: "block-1", level: null }] },
    { headings: [{ blockId: "block-1", level: 1 }, { blockId: "unknown", level: null }] },
    { headings: [{ blockId: "block-2", level: null }, { blockId: "block-1", level: 1 }] },
    { headings: [{ blockId: "block-1", level: 1 }, { blockId: "block-2", level: 1 }] },
    { headings: [{ blockId: "block-1", level: 7 }, { blockId: "block-2", level: null }] },
  ])("rejects incomplete, duplicate, reordered, unknown, multiple-title and invalid-level decisions: %j", (value) => {
    const { extraction } = contractFixture()
    expect(Result.isFailure(validateHeadingResponse(extraction, correctedFixture(extraction), value))).toBe(true)
  })

  it("keeps a retained heading separate even when a join was proposed", () => {
    const extraction = stageExtraction([["paragraph", "Ends here.", 1], ["heading", "## References", 1], ["reference", "[1] Keep this reference.", 1], ["list", "- Keep this item.", 1]])
    const check = Schema.decodeUnknownSync(PageCheck)({ fixes: [], joins: [{ firstBlockId: "block-1", secondBlockId: "block-2", answer: "same" }] })
    const corrected = Result.getOrThrow(applyPageChecks(extraction, pageChecks(extraction, { "page-1": check })))
    const response = Schema.decodeUnknownSync(HeadingResponse)({ headings: [{ blockId: "block-1", level: null }, { blockId: "block-2", level: 2 }] })
    const result = Result.getOrThrow(applyHeadingDecisions(extraction, corrected, response))
    expect(result.appliedJoinCount).toBe(0)
    expect(result.blocks.map((block) => block.kind)).toEqual(["paragraph", "heading", "reference", "list"])
    expect(formatCorrectedText(extraction, result.blocks)).toContain("[1] Keep this reference.")
  })

  it.each(["-", "‐"])("applies a chain only after explicit heading demotion and preserves Unicode/math/source locations (%s)", (hyphen) => {
    const extraction = stageExtraction([["paragraph", `α inter${hyphen}`, 1], ["heading", "## national $x_1$", 2], ["paragraph", "and β.", 2], ["table", "<table>π</table>", 2]])
    const check = Schema.decodeUnknownSync(PageCheck)({ fixes: [], joins: [{ firstBlockId: "block-1", secondBlockId: "block-2", answer: "word" }, { firstBlockId: "block-2", secondBlockId: "block-3", answer: "same" }] })
    const corrected = Result.getOrThrow(applyPageChecks(extraction, pageChecks(extraction, { "page-2": check })))
    const response = Schema.decodeUnknownSync(HeadingResponse)({ headings: [{ blockId: "block-1", level: null }, { blockId: "block-2", level: null }, { blockId: "block-3", level: null }] })
    const before = structuredClone(extraction)
    const result = Result.getOrThrow(applyHeadingDecisions(extraction, corrected, response))
    expect(result.blocks[0]).toMatchObject({ id: "block-1", content: "α international $x_1$ and β.", sourceBlockIds: ["block-1", "block-2", "block-3"], headingLevel: null })
    expect(result.appliedJoinCount).toBe(2)
    expect(result.blocks[0]?.locations).toHaveLength(3)
    expect(result.blocks[1]?.content).toBe("<table>π</table>")
    expect(extraction).toEqual(before)
    const canonical = Schema.decodeUnknownSync(CanonicalDocument)({ ...contractFixture("cross-page").canonical, pages: extraction.pages, sourceBlocks: extraction.sourceBlocks, blocks: result.blocks, headingDecisions: result.headingDecisions })
    expect(validateCanonicalDocument(contractFixture("cross-page").document, extraction, canonical)).toEqual([])
  })

  it("keeps list-like paragraph content after null demotion and rejects partial-block headings", () => {
    const extraction = stageExtraction([["heading", "## 1. first item", 1], ["paragraph", "Methods\nA paragraph follows", 1], ["note", "Preserved note", 1]])
    const corrected = correctedFixture(extraction)
    const invalid = { headings: [{ blockId: "block-1", level: null }, { blockId: "block-2", level: 2 }] }
    expect(Result.isFailure(validateHeadingResponse(extraction, corrected, invalid))).toBe(true)
    const response = Schema.decodeUnknownSync(HeadingResponse)({ headings: [{ blockId: "block-1", level: null }, { blockId: "block-2", level: null }] })
    const result = Result.getOrThrow(applyHeadingDecisions(extraction, corrected, response))
    expect(result.blocks[0]?.content).toBe("1. first item")
    expect(result.blocks[1]?.content).toBe("Methods\nA paragraph follows")
    expect(result.blocks[2]?.content).toBe("Preserved note")
  })

  it("rejects stale corrected artifacts and excessive full context without truncation", () => {
    const { extraction } = contractFixture()
    const corrected = correctedFixture(extraction)
    expect(Result.isFailure(buildHeadingRequest(extraction, { ...corrected, blocks: [] }, stageLimits))).toBe(true)
    expect(Result.isFailure(buildHeadingRequest(extraction, corrected, { ...stageLimits, maxRequestBytes: 100 }))).toBe(true)
  })
})
