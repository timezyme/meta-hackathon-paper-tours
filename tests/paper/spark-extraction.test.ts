import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { HttpClient } from "effect/http"
import { describe, expect } from "vitest"
import { RunConfiguration, StageReceipt } from "../../src/domain/index.ts"
import { convertSparkExtraction, extractionSpec, SavedExtraction } from "../../src/paper/extraction/index.ts"
import { stableJson, strictSchema } from "../../src/paper/providers/meta/contracts.ts"
import { ProviderAdapter, ProviderGuard } from "../../src/processing/index.ts"
import { Admission, DocumentStore } from "../../src/storage/index.ts"
import { contractFixture } from "../fixtures/contracts.ts"
import { registered, request, response, rows, runWith, settings, specs, storeLayer } from "./meta/fixtures.ts"

const fixture = contractFixture()
const model = { provider: "meta", model: "muse-spark-1.3", reasoning: "high", promptName: specs.extraction.promptName, promptVersion: "1", maxOutputTokens: 1000 } as const
const configuration = { ...fixture.run.configuration, extractionProvider: "meta", extractionVersion: "muse-spark-1.3", extractionModel: model, spendingCapUsd: 1 }
const extracted = { pageNumber: 1, coverage: "complete", hasFigures: false, blocks: [
  { kind: "heading", content: "  A title  ", format: "text", furniture: null },
  { kind: "equation", content: String.raw`\sum_{i=0}^{n} x_i = 2`, format: "latex", furniture: null },
  { kind: "table", content: "<table><tr><td>1</td><td>2</td></tr></table>", format: "html", furniture: null },
  { kind: "code", content: "```python\r\nfor α in values:\r\n\tprint(α)  \r\n```", format: "markdown", furniture: null },
  { kind: "note", content: "7", format: "text", furniture: "page_number" },
] }
const makeClaim = (maxOutputTokens = 1000) => Effect.gen(function* () {
  const documents = yield* DocumentStore
  yield* documents.admit(yield* Schema.decodeUnknownEffect(Admission)({ ownerId: "spark-owner", idempotencyKey: "spark-upload", originalFilename: "fixture.pdf", bytes: new TextEncoder().encode("%PDF fixture"), pageCount: 1, pipelineVersion: "trial-1", configuration: { ...configuration, extractionModel: { ...model, maxOutputTokens }, deadlineMilliseconds: 100_000 } }))
  const claim = yield* documents.claimNext({ workerId: "spark-test", leaseMilliseconds: 100_000 })
  if (claim === null) return yield* Effect.die("Expected extraction claim")
  return claim
})

describe("bounded Spark extraction", () => {
  it("has a strict response schema and preserves literal blocks, page locations and furniture", () => {
    expect(strictSchema(extractionSpec.schema)).toBe(true)
    const result = convertSparkExtraction(fixture.document, fixture.run.id, fixture.extraction.pages[0], extracted)
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) return
    expect(result.success.extraction.sourceBlocks.map((block) => block.content)).toEqual(extracted.blocks.map((block) => block.content))
    expect(result.success.extraction.sourceBlocks[3]).toMatchObject({ kind: "code", format: "markdown", content: extracted.blocks[3]!.content, locations: [{ _tag: "page", pageId: fixture.extraction.pages[0].id, pageNumber: 1 }] })
    expect(result.success.extraction.sourceBlocks.every((block) => block.locations[0]._tag === "page")).toBe(true)
    expect(result.success.extraction.pageFurniture).toEqual([{ blockId: "page-1-block-5", role: "page_number" }])
    expect(result.success.issues).toEqual([])
    expect(result.success.extraction.figures).toEqual([])
    expect(Schema.decodeUnknownSync(SavedExtraction)({ ...result.success, accounting: [] })).toEqual(result.success)
  })
  it("warns only for genuinely unclassified content while preserving code and furniture", () => {
    const result = convertSparkExtraction(fixture.document, fixture.run.id, fixture.extraction.pages[0], { ...extracted, blocks: [...extracted.blocks, { kind: "unclassified", content: "[unreadable] unknown notation", format: "text", furniture: null }] })
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) return
    expect(result.success.issues).toMatchObject([{ code: "unclassified-content", blockIds: ["page-1-block-6"], locations: [{ _tag: "page", pageId: fixture.extraction.pages[0].id, pageNumber: 1 }] }])
    expect(result.success.extraction.sourceBlocks[3]?.kind).toBe("code")
    expect(result.success.extraction.sourceBlocks[4]?.kind).toBe("unclassified")
    expect(result.success.extraction.pageFurniture).toEqual([{ blockId: "page-1-block-5", role: "page_number" }])
    expect(result.success.extraction.sourceBlocks[5]?.content).toBe("[unreadable] unknown notation")
  })
  for (const invalid of [
    { ...extracted, pageNumber: 2 }, { ...extracted, coverage: "incomplete" }, { ...extracted, blocks: [] }, { ...extracted, hasFigures: true },
    { ...extracted, blocks: [{ ...extracted.blocks[0], content: " " }] }, { ...extracted, blocks: [{ ...extracted.blocks[0], kind: "figure" }] },
    { ...extracted, blocks: [{ ...extracted.blocks[0], sourceId: "model-controlled" }] },
  ]) it("rejects invalid, empty, incomplete or unsupported extraction without dropping content", () => {
    expect(Result.isFailure(convertSparkExtraction(fixture.document, fixture.run.id, fixture.extraction.pages[0], invalid))).toBe(true)
  })
  it("retains old configurations and rejects wrong provider/version/model agreements", () => {
    expect(Schema.is(RunConfiguration)(fixture.run.configuration)).toBe(true)
    expect(Schema.is(RunConfiguration)(configuration)).toBe(true)
    for (const changed of [{ extractionModel: undefined }, { extractionProvider: "mineru" }, { extractionVersion: "wrong" }, { extractionModel: { ...model, provider: "other" } }, { extractionModel: { ...model, model: "other" } }]) expect(Schema.is(RunConfiguration)({ ...configuration, ...changed })).toBe(false)
    const receipt = fixture.report.receipts[0]!.receipt
    expect(Schema.is(StageReceipt)({ ...receipt, stage: "extraction", configuration: { _tag: "extraction", provider: "mineru", version: "4.0.12" } })).toBe(true)
    expect(Schema.is(StageReceipt)({ ...receipt, stage: "extraction", configuration: { _tag: "extraction", provider: "meta", version: "muse-spark-1.3" } })).toBe(false)
  })
  it.effect("uses the real guard and registered extraction agent with byte-identical zero-send replay", () => Effect.gen(function* () {
    const options = yield* settings
    let sends = 0
    yield* Effect.gen(function* () {
      const claim = yield* makeClaim()
      const guard = yield* ProviderGuard
      const input = yield* request("extraction")
      const adapter = yield* runWith(registered(), HttpClient.make((req) => Effect.sync(() => {
        sends += 1
        expect(req.body._tag === "Uint8Array" && new TextDecoder().decode(req.body.body)).toBe(stableJson(input.request))
        return response(req)
      })))
      const first = yield* guard.execute(claim, input).pipe(Effect.provideService(ProviderAdapter, adapter))
      const before = (yield* rows)[0]
      const second = yield* guard.execute(claim, input).pipe(Effect.provideService(ProviderAdapter, adapter))
      expect(first.delivery).toBe("performed")
      expect(second.delivery).toBe("reused")
      expect(second.response).toEqual(first.response)
      expect(second.receipt).toEqual(first.receipt)
      expect((yield* rows)[0]).toEqual(before)
      expect(first.receipt.configuration).toEqual({ _tag: "extraction", provider: "meta", version: "muse-spark-1.3", model })
      expect(sends).toBe(1)
      expect(JSON.parse(before!.intent_json).maxOutputTokens).toBe(1000)
    }).pipe(Effect.provide(storeLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))
  it.effect("enforces nested extraction output limits before reserving or sending", () => Effect.gen(function* () {
    const options = yield* settings
    yield* Effect.gen(function* () {
      const claim = yield* makeClaim(1001)
      const guard = yield* ProviderGuard
      const result = yield* guard.prepare(claim, yield* request("extraction")).pipe(Effect.result)
      expect(Result.isFailure(result) && result.failure.code).toBe("limit-exceeded")
      expect(yield* rows).toEqual([])
    }).pipe(Effect.provide(storeLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))
  it.effect("includes extraction model settings in admission identity", () => Effect.gen(function* () {
    const options = yield* settings
    yield* Effect.gen(function* () {
      yield* makeClaim()
      const store = yield* DocumentStore
      const result = yield* store.admit(yield* Schema.decodeUnknownEffect(Admission)({ ownerId: "spark-owner", idempotencyKey: "spark-upload", originalFilename: "fixture.pdf", bytes: new TextEncoder().encode("%PDF fixture"), pageCount: 1, pipelineVersion: "trial-1", configuration: { ...configuration, extractionModel: { ...model, maxOutputTokens: 999 }, deadlineMilliseconds: 100_000 } })).pipe(Effect.result)
      expect(Result.isFailure(result) && result.failure.code).toBe("conflict")
    }).pipe(Effect.provide(storeLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))
})
