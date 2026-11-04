import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { ProviderAttemptId, RunId, type StageReceipt } from "../../../src/domain/index.ts"
import { assembleDocument } from "../../../src/paper/reading/index.ts"
import { contractFixture, fixtureTime } from "../../fixtures/contracts.ts"
import { completeFixture, imageFixture, prepareReading } from "./fixtures.ts"

describe("deterministic reading assembly", () => {
  for (const name of ["references", "notes", "table", "ambiguous-math"] as const) {
    it.effect(`retains ${name} without legacy assembly omissions`, () => Effect.gen(function* () {
      const fixture = contractFixture(name)
      const output = yield* Effect.fromResult(assembleDocument(yield* prepareReading(fixture)))
      expect(output.canonical.sourceBlocks).toEqual(fixture.extraction.sourceBlocks)
      expect(output.canonical.pages).toEqual(fixture.extraction.pages)
      for (const block of fixture.extraction.sourceBlocks.filter((source) => source.kind !== "heading")) expect(output.canonical.blocks.find((resolved) => resolved.id === block.id)?.content).toBe(block.content)
      expect(output.report.ambiguity._tag).toBe("unavailable")
      expect(output.report.verifiedCorrectionCount._tag).toBe("unavailable")
    }))
  }

  it.effect("keeps corrections, heading demotion, cross-page joins, and blank page accounting", () => Effect.gen(function* () {
    const input = yield* completeFixture
    const output = yield* Effect.fromResult(assembleDocument(input))
    expect(output.canonical.pages).toHaveLength(3)
    expect(output.canonical.blocks.map((block) => block.sourceBlockIds).flat()).toEqual(input.extraction.sourceBlocks.map((block) => block.id))
    const joined = output.canonical.blocks[1]
    expect(joined).toMatchObject({ kind: "paragraph", content: "microscope retains the measured value.", sourceBlockIds: ["block-2", "block-3"], headingLevel: null })
    expect(joined?.locations.map((location) => location.pageNumber)).toEqual([1, 2])
    expect(output.report.changes).toEqual({ changedBlockIds: ["block-2"], appliedJoinCount: 1, changedHeadingCount: 1 })
    expect(output.report.checks.find((check) => check.stage === "page-check")?.checkedPageIds).toEqual(["page-1", "page-2", "page-3"])
    expect(output.report.issues).toMatchObject([{ code: "unclassified-content", blockIds: ["block-9"] }])
    expect(input.run.state._tag).toBe("running")
  }))

  it.effect("retains figures and author captions when assets and descriptions are unavailable", () => Effect.gen(function* () {
    const f = yield* imageFixture
    const missing = f.input.extraction.figures.map((figure) => ({ ...figure, asset: { _tag: "unavailable" as const, reason: "Native image missing" }, description: { _tag: "pending" as const } }))
    const input = { ...f.input, extraction: { ...f.input.extraction, figures: missing }, figures: missing }
    const output = yield* Effect.fromResult(assembleDocument(input))
    expect(output.canonical.figures[0]).toMatchObject({ originalCaption: "Figure 1. A synthetic black square.", asset: { _tag: "unavailable" }, description: { _tag: "unavailable" } })
    expect(output.report.issues.map((issue) => issue.code)).toEqual(["figure-asset-unavailable", "figure-description-unavailable"])
    for (const issue of output.report.issues) expect(issue.locations).toEqual(missing[0]?.locations)
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("deduplicates actual receipts, counts same-run replay as performed and retains failed attempts", () => Effect.gen(function* () {
    const input = yield* prepareReading()
    const first = input.receiptUses[0]
    if (first === undefined) return yield* Effect.die("Missing receipt")
    const reused: StageReceipt = { ...first.receipt, id: ProviderAttemptId.make("earlier-extraction"), scope: { ...first.receipt.scope, runId: RunId.make("prior-run") }, stage: "extraction", configuration: { _tag: "extraction", provider: "mineru", version: "4.0.12" }, pageIds: [] }
    const failed: StageReceipt = { ...first.receipt, id: ProviderAttemptId.make("failed-attempt"), state: { _tag: "failed", finishedAt: fixtureTime, providerRequestId: null, failure: { code: "provider-failed", message: "Definite provider failure", retryable: false, stage: "page-check", pageId: null, figureId: null } } }
    const output = yield* Effect.fromResult(assembleDocument({ ...input, receiptUses: [{ ...first, delivery: "reused" }, first, { receipt: reused, delivery: "performed" }, { receipt: failed, delivery: "reused" }] }))
    expect(output.report.receipts.map((use) => [use.receipt.id, use.delivery])).toEqual([[first.receipt.id, "performed"], [reused.id, "reused"], [failed.id, "performed"]])
    expect(output.report.receipts.every((use) => use.receipt.state._tag !== "completed" || use.receipt.state.usage._tag === "unavailable")).toBe(true)
    const conflict = { ...first, receipt: { ...first.receipt, preparedAt: "2026-10-27T13:00:00.000Z" } }
    expect(Result.isFailure(assembleDocument({ ...input, receiptUses: [first, conflict] }))).toBe(true)
    expect(Result.isFailure(assembleDocument({ ...input, receiptUses: [{ ...first, receipt: { ...first.receipt, state: { _tag: "unknown-completion", providerRequestId: "job", observedAt: fixtureTime, reason: "Connection lost" } } }] }))).toBe(true)
  }))

  it.effect("rejects altered resolutions, source loss, missing page checks and missing receipts", () => Effect.gen(function* () {
    const input = yield* completeFixture
    const variants = [
      { ...input, headings: { ...input.headings, appliedJoinCount: 2 } },
      { ...input, headings: { ...input.headings, blocks: input.headings.blocks.slice(1) } },
      { ...input, corrected: { ...input.corrected, checkedPages: input.corrected.checkedPages.slice(1) } },
      { ...input, receiptUses: input.receiptUses.slice(1) },
      { ...input, extraction: { ...input.extraction, pages: [input.extraction.pages[0]] as const } },
    ]
    for (const variant of variants) expect(Result.isFailure(assembleDocument(variant))).toBe(true)
  }))
})
