import { NodeServices } from "@effect/platform-node"
import { Mastra } from "@mastra/core/mastra"
import { expect, it } from "@effect/vitest"
import { Effect, Redacted, Result, Schema } from "effect"
import { HttpClient } from "effect/http"
import { BlockId, PageId } from "../../../src/domain/index.ts"
import { PAGE_REVIEW_PROMPT, publicPrompt } from "../../../src/domain/prompt-templates.ts"
import { buildPageCheckRequest, pageCheckSpecFor, pageCheckSpecV2, stageSpecs, validatePageResponse } from "../../../src/paper/correction/index.ts"
import { stageJsonSchema } from "../../../src/paper/correction/requests.ts"
import { makeMetaAgentBoundary } from "../../../src/paper/providers/meta/index.ts"
import { AttemptInput, ProviderAdapter, ProviderGuard } from "../../../src/processing/index.ts"
import { tableCorrectionFixture } from "../../fixtures/table-corrections.ts"
import { pngBytes, stageLimits } from "../correction-fixtures.ts"
import { claim, response, settings, storeLayer } from "./fixtures.ts"

it.effect("saves and replays the real table-check response without HTTP and refuses old-version receipts", () => Effect.gen(function* () {
  const options = yield* settings
  yield* Effect.gen(function* () {
    const owned = yield* claim("table-reader", stageSpecs)
    const guard = yield* ProviderGuard
    const fixture = tableCorrectionFixture("text", "Paramter 12")
    const extraction = { ...fixture.extraction, scope: { ...fixture.extraction.scope, documentId: owned.document.id, runId: owned.run.id, sourceHash: owned.document.sourceHash } }
    const pageId = PageId.make("page-1")
    const built = yield* Effect.fromResult(buildPageCheckRequest(extraction, pageId, pngBytes, { ...stageLimits, maxOutputTokens: 1000 }))
    const input = yield* Schema.decodeUnknownEffect(AttemptInput)({ stage: "page-check", pageIds: [pageId], figureId: null, inputHashes: [owned.document.sourceHash], request: built.request, supportsIdempotency: false, retry: { _tag: "none" } })
    const answer = { fixes: [{ blockId: "block-1", content: "Parameter 99\nExtra 21" }], joins: [], furniture: [] }
    const body = JSON.stringify({ id: "table-completion", model: "muse-spark-1.3", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(answer) } }], usage: { prompt_tokens: 32, completion_tokens: 16 } })
    let sends = 0
    const boundary = makeMetaAgentBoundary(stageSpecs)
    const mastra = yield* Effect.acquireRelease(Effect.sync(() => new Mastra({ agents: boundary.agents })), (instance) => Effect.promise(() => instance.shutdown()))
    const validate = (value: unknown) => Effect.fromResult(validatePageResponse(extraction, pageId, value)).pipe(Effect.tap((accepted) => Effect.sync(() => { expect(accepted).toEqual(answer) })), Effect.asVoid)
    const adapter = yield* boundary.makeAdapter({ credential: Redacted.make("offline"), getAgent: (stage) => mastra.getAgent(stage), validators: { extraction: () => Effect.die("Unexpected extraction"), "page-check": validate, headings: () => Effect.die("Unexpected heading call"), figures: () => Effect.die("Unexpected figure call"), guide: () => Effect.die("Unexpected guide call") } }).pipe(Effect.provideService(HttpClient.HttpClient, HttpClient.make((request) => Effect.sync(() => { sends += 1; return response(request, body) }))))
    const first = yield* guard.execute(owned, input).pipe(Effect.provideService(ProviderAdapter, adapter))
    const replay = yield* guard.execute(owned, input).pipe(Effect.provideService(ProviderAdapter, adapter))
    expect(replay.delivery).toBe("reused")
    expect(replay.response).toEqual(first.response)
    expect(replay.receipt.configuration).toMatchObject({ promptVersion: "amuseme-3" })
    expect(sends).toBe(1)
    yield* adapter.validate(replay.response, replay.receipt)
    if (first.receipt.configuration._tag !== "model") return yield* Effect.die("Expected model receipt")
    expect(Result.isFailure(yield* Effect.result(adapter.validate(first.response, { ...first.receipt, configuration: { ...first.receipt.configuration, promptVersion: "amuseme-1" } })))).toBe(true)
    const oldPrompt = publicPrompt("page-check", "amuseme-1")
    expect(oldPrompt).toContain("Table blocks are final and never get a fix.")
    expect(built.request.messages[0].content).toContain("fix only words, symbols and line breaks")
    const changed = yield* Effect.result(guard.prepare(owned, { ...input, request: { ...built.request, messages: [{ ...built.request.messages[0], content: oldPrompt }, built.request.messages[1]] } }))
    expect(changed).toMatchObject({ _tag: "Failure", failure: { code: "provider-unknown-completion" } })
    expect(sends).toBe(1)
  }).pipe(Effect.scoped, Effect.provide(storeLayer(options)))
}).pipe(Effect.provide(NodeServices.layer)))

it("keeps the amuseme-2 page-check request byte-identical for runs saved before furniture", () => {
  const before = Schema.Struct({
    fixes: Schema.Array(Schema.Struct({ blockId: BlockId, content: Schema.String })),
    joins: Schema.Array(Schema.Struct({ firstBlockId: BlockId, secondBlockId: BlockId, answer: Schema.Literals(["same", "word"]) })),
  })
  expect(pageCheckSpecFor("amuseme-2")).toBe(pageCheckSpecV2)
  expect(JSON.stringify(pageCheckSpecV2.schema)).toBe(JSON.stringify(stageJsonSchema(before)))
  expect(pageCheckSpecV2.instructions).toBe(PAGE_REVIEW_PROMPT)
  expect(pageCheckSpecFor("amuseme-3").promptVersion).toBe("amuseme-3")
})
