import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { BlockId, PageId, validateCanonicalDocument, validatePublication } from "../../src/domain/index.ts"
import { validatePageResponse } from "../../src/paper/correction/index.ts"
import { assembleDocument, exportDocument } from "../../src/paper/reading/index.ts"
import { fixtureTime } from "../fixtures/contracts.ts"
import { tableCorrectionFixture, tableCorrections } from "../fixtures/table-corrections.ts"
import { prepareReading } from "./reading/fixtures.ts"
import { stageExtraction } from "./correction-fixtures.ts"

const pageId = PageId.make("page-1")
const blockId = BlockId.make("block-1")

describe("table fixes through real page checking and final output", () => {
  for (const sample of tableCorrections) it.effect(`keeps the exact model replacement changing ${sample.name}`, () => Effect.gen(function* () {
    const fixture = tableCorrectionFixture(sample.format, sample.original)
    const before = JSON.stringify(fixture.extraction)
    const response = { fixes: [{ blockId, content: sample.replacement }], joins: [] }
    const accepted = yield* Effect.fromResult(validatePageResponse(fixture.extraction, pageId, response))
    expect(accepted).toEqual(response)
    const input = yield* prepareReading(fixture, [accepted])
    const assembled = yield* Effect.fromResult(assembleDocument(input))
    const output = yield* exportDocument(assembled, [])
    expect(output.publication.canonical.blocks[0]).toMatchObject({ content: sample.replacement, format: sample.format, kind: "table", sourceBlockIds: [blockId] })
    expect(validateCanonicalDocument(fixture.document, fixture.extraction, output.publication.canonical)).toEqual([])
    expect(validatePublication({ document: fixture.document, run: { ...input.run, state: { _tag: "succeeded", startedAt: fixtureTime, finishedAt: fixtureTime, revisionId: input.revisionId } }, ...output.publication })).toEqual([])
    const text = new TextDecoder().decode(output.files.find((file) => file.entry.path === "normalized.txt")?.bytes)
    expect(text).toContain(`\n${sample.replacement}\n`)
    expect(output.publication.report.changes).toEqual({ changedBlockIds: [blockId], appliedJoinCount: 0, changedHeadingCount: 0 })
    expect(JSON.stringify(fixture.extraction)).toBe(before)
    expect(output.publication.canonical.sourceBlocks[0]?.content).toBe(sample.original)
  }).pipe(Effect.provide(NodeServices.layer)))

  it("keeps table deletion, duplicate, wrong-page, heading-boundary and join refusals", () => {
    const extraction = stageExtraction([["table", "Item 12", 1], ["paragraph", "Prose", 1], ["table", "Other 13", 2]])
    for (const response of [
      { fixes: [{ blockId: "block-1", content: "  " }], joins: [] },
      { fixes: [{ blockId: "block-1", content: "A" }, { blockId: "block-1", content: "B" }], joins: [] },
      { fixes: [{ blockId: "block-3", content: "Other 99" }], joins: [] },
      { fixes: [{ blockId: "block-1", content: "Table\n# Separate heading" }], joins: [] },
      { fixes: [], joins: [{ firstBlockId: "block-1", secondBlockId: "block-2", answer: "same" }] },
      { fixes: [], joins: [{ firstBlockId: "block-2", secondBlockId: "block-3", answer: "same" }] },
    ]) expect(Result.isFailure(validatePageResponse(extraction, pageId, response))).toBe(true)
    expect(Result.isFailure(validatePageResponse(extraction, PageId.make("page-2"), { fixes: [], joins: [{ firstBlockId: "block-2", secondBlockId: "block-3", answer: "same" }] }))).toBe(true)
  })
})
