import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Mastra } from "@mastra/core/mastra"
import { LibSQLStore } from "@mastra/libsql"
import { Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { CanonicalDocument, IdempotencyKey, ProcessingReport, RunConfiguration, UserId, type OutputRevisionId, type RunState } from "../../src/domain/index.ts"
import { makeAmuseMe } from "../../src/mastra/amuseme.ts"
import { makeNormalizationBoundary } from "../../src/mastra/normalize-workflow.ts"
import { stageSpecs } from "../../src/paper/correction/index.ts"
import { PdfRenderer } from "../../src/paper/pdf/index.ts"
import { makeMetaAgentBoundary, MetaRequest } from "../../src/paper/providers/meta/index.ts"
import { countEndpoint } from "../../src/paper/providers/meta/transport.ts"
import { makeProviderGuard, ProviderGuard, type GuardPolicy } from "../../src/processing/index.ts"
import type { WorkflowStageFailure } from "../../src/processing/contracts.ts"
import { NormalizationStages } from "../../src/processing/pipeline.ts"
import { AssembledDocument } from "../../src/paper/reading/index.ts"
import { Assembled } from "../../src/processing/checkpoints.ts"
import {
  ArtifactStore, DocumentStore, OutputStore, StorageDatabase, makeArtifactStore, makeDocumentStoreLayer, makeOutputStore,
  type StorageFailure,
} from "../../src/storage/index.ts"

const model = (stage: keyof typeof stageSpecs) => ({ provider: "meta", model: "muse-spark-1.3", reasoning: stage === "headings" ? "medium" : "high", promptName: stageSpecs[stage].promptName, promptVersion: stageSpecs[stage].promptVersion, maxOutputTokens: 16384 })
const policy: GuardPolicy = { mode: "fixture", enabled: true, metaCredentialConfigured: true, mineruCredentialConfigured: true, mineruEndpoint: "https://amuseme-fixture.invalid", budgetId: "pipeline-fixture", authorizedBudgetMicrousd: 100, maximumCostMicrousd: { extraction: 1, "page-check": 1, headings: 1, figures: 1 }, maxConcurrentCalls: 1, maxOutputTokens: 16384, maxRequestBytes: 48 * 1024 * 1024, maxResponseBytes: 2 * 1024 * 1024, callDeadlineMilliseconds: 100000 }
const owner = UserId.make("pipeline-fixture-owner")
const pageInput = Schema.Struct({ currentPage: Schema.Struct({ blocks: Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.String })) }) })
const headingInput = Schema.Struct({ candidates: Schema.Array(Schema.Struct({ blockId: Schema.String, blockType: Schema.String })) })


type Provider = "meta" | "mineru"
type Scenario = "success" | "invalid-page" | "oversized-context" | "invalid-extraction" | "figure-extraction" | "denied"
  | "guide-success" | "guide-invalid" | "guide-tampered" | "guide-budget" | "guide-preflight" | "guide-review-corrected" | "guide-review-exhausted" | "review-budget"
type FixtureError = Schema.SchemaError | StorageFailure | WorkflowStageFailure
interface Outcome {
  readonly state: RunState
  readonly calls: ReadonlyArray<string>
  readonly reviewInputs: ReadonlyArray<string>
  readonly attempts: ReadonlyArray<Record<string, unknown>>
  readonly currentRevisionId: OutputRevisionId | null
  readonly readOutput: (revisionId: OutputRevisionId, name: string) => Effect.Effect<string, StorageFailure>
}

const runPipeline = (
  provider: Provider,
  scenario: Scenario,
  expectOutcome: (outcome: Outcome) => Effect.Effect<void, FixtureError>,
) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dataDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-pipeline-" })
  const pythonBin = path.resolve("data/python/.venv/bin/python")
  const pdf = yield* fs.readFile(path.resolve("tests/fixtures/normal.pdf"))
  yield* Effect.gen(function* () {
    const store = yield* DocumentStore
    const guided = scenario.startsWith("guide-")
    const activePolicy = guided ? { ...policy, maximumCostMicrousd: { ...policy.maximumCostMicrousd, guide: 1 } } : policy
    const configuration = yield* Schema.decodeUnknownEffect(RunConfiguration)({
      extractionProvider: provider, extractionVersion: provider === "mineru" ? "4.0.12" : "muse-spark-1.3", ...(provider === "meta" ? { extractionModel: model("extraction") } : {}),
      pageCheck: model("page-check"), headings: model("headings"), figures: model("figures"), ...(guided ? { guide: model("guide") } : {}),
      maxProviderAttempts: provider === "meta" && !scenario.includes("review") ? 1 : 10, deadlineMilliseconds: 120000,
      spendingCapUsd: scenario === "guide-budget" || scenario === "review-budget" ? 0.000003 : 1,
    })
    yield* store.admit({ ownerId: owner, idempotencyKey: IdempotencyKey.make("fixture-pipeline"), bytes: pdf, originalFilename: "normal.pdf", pageCount: 1, pipelineVersion: "amuseme-1", configuration })
    const claim = yield* store.claimNext({ workerId: "integration", leaseMilliseconds: 120000 })
    if (claim === null) return yield* Effect.die("Expected accepted fixture")
    const artifacts = yield* makeArtifactStore(dataDirectory)
    const outputs = yield* makeOutputStore().pipe(Effect.provideService(ArtifactStore, artifacts))
    const guard = yield* makeProviderGuard(activePolicy)
    const calls: Array<string> = []
    const reviewInputs: Array<string> = []
    const reviewing = scenario === "guide-review-corrected" || scenario === "guide-review-exhausted" || scenario === "review-budget"
    const http = HttpClient.make((request, url) => Effect.gen(function* () {
      if (url.href === countEndpoint) {
        calls.push("count")
        if (scenario === "guide-preflight" && calls.filter((call) => call === "count").length === 4) return HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 }))
        return HttpClientResponse.fromWeb(request, Response.json({ object: "response.input_tokens", input_tokens: scenario === "oversized-context" ? 524289 : 2000 }))
      }
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON body")
      const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MetaRequest))(new TextDecoder().decode(request.body.body))
      const name = body.response_format.json_schema.name
      calls.push(name)
      const review = name.endsWith("-review")
      const stage = ({ "extraction-review": "page-extraction", "page-check-review": "page-check", "headings-review": "headings", "guide-review": "reading-guide" } as Record<string, string>)[name] ?? name
      const text = body.messages[1].content.find((part) => part.type === "text")
      if (text?.type !== "text") return yield* Effect.die("Expected complete text")
      const reviewText = body.messages[1].content.at(-1)
      if (review && (reviewText?.type !== "text" || !body.messages[0].content.startsWith("You are the Muse reviewer"))) return yield* Effect.die("Expected a Muse reviewer brief and review evidence")
      if (review && reviewText?.type === "text") reviewInputs.push(reviewText.text)
      const invalid = scenario === "guide-review-exhausted" || scenario === "review-budget" || (scenario === "guide-review-corrected" && !review)
      let result: Schema.Json
      if (stage === "page-extraction") {
        result = { pageNumber: 1, coverage: scenario === "invalid-extraction" ? "incomplete" : "complete", blank: false, figures: scenario === "figure-extraction" ? [{ blockIndex: 99, captionBlockIndices: [], box: null }] : [], blocks: [
          { kind: "heading", content: "A synthetic document", format: "text", furniture: null },
          { kind: "paragraph", content: "The result is l2 units.", format: "text", furniture: null },
          { kind: "note", content: "1", format: "text", furniture: "page_number" },
          { kind: "equation", content: "x = 2", format: "latex", furniture: null },
        ] }
      } else if (stage === "page-check") {
        const current = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(pageInput))(text.text)
        const block = current.currentPage.blocks.find((entry) => entry.kind === "paragraph")
        result = { fixes: [{ blockId: scenario === "invalid-page" || reviewing && invalid ? "foreign-block" : block?.id ?? "missing", content: "The result is 12 units." }], joins: [] }
      } else if (stage === "reading-guide") {
        const sources = [{ sourceBlockId: "page-1-block-2", quote: scenario === "guide-invalid" || reviewing && invalid ? "The result is 12 units." : "The result is l2 units." }]
        result = { title: "A reported result", overview: { text: "The document presents a synthetic result.", sources }, steps: [{ title: "Inspect the result", explanation: { text: "Compare the reported value with the original source.", sources } }], claims: [{ claim: { text: "The document reports a numerical result.", sources }, support: { text: "The source states the result directly.", strength: "partial", sources }, limits: [{ text: "The quoted statement alone does not establish generality.", sources }] }] }
      } else {
        const current = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(headingInput))(text.text)
        result = { headings: scenario === "guide-review-exhausted" ? [] : current.candidates.map((candidate) => ({ blockId: candidate.blockId, level: candidate.blockType === "heading" ? 1 : null })) }
      }
      return HttpClientResponse.fromWeb(request, Response.json({ id: `fixture-${stage}`, model: "muse-spark-1.3", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(result) } }], usage: { prompt_tokens: 2000, completion_tokens: 100 } }))
    }).pipe(Effect.orDie))
    const meta = makeMetaAgentBoundary(stageSpecs)
    const stages = yield* NormalizationStages.pipe(Effect.provide(NormalizationStages.layer(meta, { policy: activePolicy, temporaryDirectory: path.join(dataDirectory, "processing"), metaCredential: Redacted.make("fixture"), mineruToken: Redacted.make("fixture"), mineruEndpoint: policy.mineruEndpoint! }).pipe(Layer.provide(Layer.mergeAll(
      Layer.succeed(ArtifactStore, artifacts), Layer.succeed(OutputStore, outputs), Layer.succeed(ProviderGuard, guard), Layer.succeed(HttpClient.HttpClient, http),
      PdfRenderer.layer({ pythonBin }),
    )))))
    const runEffect = Effect.runPromiseWith(yield* Effect.context())
    const boundary = makeNormalizationBoundary((current, stage, input, signal) => runEffect(Effect.gen(function* () {
      if (stage === "guide" && scenario === "guide-success") {
        const first = yield* stages.execute(current, stage, input)
        const second = yield* stages.execute(current, stage, input)
        expect(second).toEqual(first)
        expect(calls.filter((call) => call === "reading-guide")).toHaveLength(1)
        return second
      }
      if (scenario === "guide-review-corrected" && (stage === "page-check" || stage === "guide")) {
        const first = yield* stages.execute(current, stage, input)
        const before = calls.length
        const second = yield* stages.execute(current, stage, input)
        expect(second).toEqual(first)
        expect(calls.slice(before).filter((call) => call !== "count")).toEqual([])
        return second
      }
      if (stage === "export" && scenario === "guide-tampered") {
        const checkpoint = yield* Schema.decodeUnknownEffect(Assembled)(input)
        const publication = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AssembledDocument))(new TextDecoder().decode(yield* artifacts.read(owner, current.document.id, checkpoint.publication)))
        const guide = publication.canonical.guide
        if (guide === undefined) return yield* Effect.die("Expected a saved guide")
        const tampered = { ...publication, canonical: { ...publication.canonical, guide: { ...guide, overview: { ...guide.overview, text: "A fabricated explanation with unchanged valid quotations." } } } }
        const saved = yield* artifacts.put(owner, current.document.id, new TextEncoder().encode(JSON.stringify(tampered)))
        return yield* stages.execute(current, stage, { ...checkpoint, publication: saved })
      }
      return yield* stages.execute(current, stage, input)
    }).pipe(Effect.catchTags({ SchemaError: Effect.die, StorageFailure: Effect.die }), Effect.match({ onSuccess: (value) => ({ _tag: "success" as const, value }), onFailure: (error) => ({ _tag: "failure" as const, failure: error.failure }) })), { signal }))
    const storage = new LibSQLStore({ id: "pipeline-fixture", url: `file:${dataDirectory}/mastra.sqlite`, maxRetries: 1 })
    yield* Effect.promise(() => storage.init())
    yield* Effect.acquireRelease(Effect.sync(() => new Mastra({ ...makeAmuseMe(4180, { meta, normalization: boundary }), storage })), (mastra) => Effect.promise(() => mastra.shutdown()))
    const state = yield* boundary.starter.startOrReconnect(claim)
    const database = yield* StorageDatabase
    const attempts = yield* database.query("pipeline-attempts", () => database.db.selectFrom("provider_attempts").selectAll().execute())
    const { currentRevisionId } = yield* store.detail(owner, claim.document.id)
    const readOutput = (revisionId: OutputRevisionId, name: string) =>
      outputs.read(owner, claim.document.id, revisionId, name).pipe(Effect.map((file) => new TextDecoder().decode(file.bytes)))
    yield* expectOutcome({ state, calls, reviewInputs, attempts, currentRevisionId, readOutput })
  }).pipe(Effect.provide(makeDocumentStoreLayer({ dataDirectory, queueLimit: 5 })))
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const expectSucceeded = Effect.fnUntraced(function* (outcome: Outcome, expectedCalls: ReadonlyArray<string>, receiptCount: number) {
  expect(outcome.state._tag, JSON.stringify({ state: outcome.state, calls: outcome.calls })).toBe("succeeded")
  if (outcome.state._tag !== "succeeded") return yield* Effect.die(JSON.stringify(outcome.state))
  const normalized = yield* outcome.readOutput(outcome.state.revisionId, "normalized.txt")
  expect(normalized).toContain("The result is 12 units.")
  expect(normalized).not.toContain("l2 units")
  const readJson = <A>(name: string, schema: Schema.Codec<A, unknown>) => outcome.state._tag === "succeeded"
    ? outcome.readOutput(outcome.state.revisionId, name).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))))
    : Effect.die("Expected a published revision")
  const canonical = yield* readJson("document.json", CanonicalDocument)
  expect(canonical.sourceBlocks.some((block) => block.content.includes("l2 units"))).toBe(true)
  const report = yield* readJson("processing-report.json", ProcessingReport)
  expect(report.changes.changedBlockIds).toHaveLength(1)
  expect(report.receipts).toHaveLength(receiptCount)
  expect(report.receipts.every((entry) => entry.delivery === "performed" && entry.receipt.state._tag === "completed")).toBe(true)
  expect(outcome.calls).toEqual(expectedCalls)
  expect(canonical.pageFurniture).toEqual([{ blockId: "page-1-block-3", role: "page_number" }])
  expect(report.issues).toEqual([])
  expect(normalized).toContain("x = 2")
  expect(canonical.figures).toEqual([])
  return { canonical, report, normalized }
})
const readPublication = Effect.fnUntraced(function* (outcome: Outcome) {
  const state = outcome.state
  if (state._tag !== "succeeded" && state._tag !== "succeeded-with-issues") return yield* Effect.die(JSON.stringify(state))
  const readJson = <A>(name: string, schema: Schema.Codec<A, unknown>) => outcome.readOutput(state.revisionId, name).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))))
  return { canonical: yield* readJson("document.json", CanonicalDocument), report: yield* readJson("processing-report.json", ProcessingReport), normalized: yield* outcome.readOutput(state.revisionId, "normalized.txt") }
})
const expectReviewedPublication = (outcome: Outcome) => {
  expect(outcome.state._tag, JSON.stringify({ state: outcome.state, calls: outcome.calls })).toBe("succeeded-with-issues")
  return readPublication(outcome)
}
const expectFailedBeforePublication = (outcome: Outcome, pageChecks: number) => {
  expect(outcome.state._tag).toBe("failed")
  expect(outcome.currentRevisionId).toBeNull()
  expect(outcome.calls.filter((call) => call === "page-check")).toHaveLength(pageChecks)
}
const expectGuideFailure = (outcome: Outcome, stage: string, code: string) => {
  expectFailedBeforePublication(outcome, 1)
  expect(outcome.state).toMatchObject({ failure: { stage, code } })
}
const pipelineTest = <E>(name: string, run: Effect.Effect<void, E>) => it.live(name, () => run, { timeout: 30000 })

describe("full saved processing pipeline with the real renderer, guard, registered agents, workflow and output store", () => {
  pipelineTest("meta success publishes corrected text without a guide", runPipeline("meta", "success", (outcome) => Effect.gen(function* () {
    const { canonical } = yield* expectSucceeded(outcome, ["count", "page-extraction", "count", "page-check", "count", "headings"], 3)
    expect(canonical.guide).toBeUndefined()
  })))

  pipelineTest("meta guide success makes one paid guide call", runPipeline("meta", "guide-success", (outcome) => Effect.gen(function* () {
    const expectedCalls = ["count", "page-extraction", "count", "page-check", "count", "headings", "count", "reading-guide", "count"]
    const { canonical, report, normalized } = yield* expectSucceeded(outcome, expectedCalls, 4)
    expect(canonical.guide?.overview.sources).toEqual([{ sourceBlockId: "page-1-block-2", quote: "The result is l2 units." }])
    expect(report.receipts.find(({ receipt }) => receipt.stage === "guide")?.receipt.id).toBe(canonical.guide?.providerAttemptId)
    expect(report.checks.map((check) => check.stage)).toEqual(["extraction", "page-check", "headings", "figures", "assembly", "guide", "export"])
    expect(normalized).not.toContain("The document presents a synthetic result.")
    expect(outcome.attempts).toHaveLength(4)
    const guideAttempt = outcome.attempts.find((row) => row["id"] === canonical.guide?.providerAttemptId)
    expect(guideAttempt).toMatchObject({ status: "completed", validation_state: "accepted", reserved_microusd: 1, actual_microusd: null })
  })))

  pipelineTest("meta invalid page check without attempt allowance falls back without a review call", runPipeline("meta", "invalid-page", (outcome) => Effect.gen(function* () {
    const { report, normalized } = yield* expectReviewedPublication(outcome)
    expect(outcome.calls.filter((call) => call.endsWith("-review"))).toEqual([])
    expect(normalized).toContain("l2 units")
    expect(report.museReviews).toEqual([expect.objectContaining({ stage: "page-check", agent: "page-check-review", rounds: 0, outcome: "fallback", problems: [expect.stringContaining("foreign-block")] })])
    expect(report.issues).toEqual([expect.objectContaining({ code: "provider-failure", stage: "page-check" })])
  })))

  pipelineTest("meta review corrects rejected page-check and guide answers, and replays them without new calls", runPipeline("meta", "guide-review-corrected", (outcome) => Effect.gen(function* () {
    expect(outcome.state._tag, JSON.stringify(outcome.state)).toBe("succeeded")
    const { canonical, report, normalized } = yield* readPublication(outcome)
    expect(normalized).toContain("The result is 12 units.")
    expect(outcome.calls.filter((call) => call !== "count")).toEqual(["page-extraction", "page-check", "page-check-review", "headings", "reading-guide", "guide-review"])
    expect(outcome.reviewInputs).toHaveLength(2)
    expect(outcome.reviewInputs[0]).toContain("foreign-block")
    expect(outcome.reviewInputs[1]).toContain("is not an exact substring of block page-1-block-2")
    expect(report.museReviews?.map(({ stage, agent, rounds, outcome: result, fallback }) => ({ stage, agent, rounds, result, fallback }))).toEqual([
      { stage: "page-check", agent: "page-check-review", rounds: 1, result: "corrected", fallback: null },
      { stage: "guide", agent: "guide-review", rounds: 1, result: "corrected", fallback: null },
    ])
    expect(report.issues).toEqual([])
    const guideReview = report.museReviews?.[1]
    expect(canonical.guide?.providerAttemptId).toBe(guideReview?.attemptIds[1])
    const reviewAttempts = outcome.attempts.filter((row) => JSON.parse(String(row["intent_json"])).retry._tag === "review")
    expect(reviewAttempts).toHaveLength(2)
    expect(reviewAttempts.every((row) => row["validation_state"] === "accepted" && row["reserved_microusd"] === 1)).toBe(true)
    expect(outcome.attempts.filter((row) => row["validation_state"] === "rejected")).toHaveLength(2)
  })))

  pipelineTest("meta review exhausted after two rounds publishes safe fallbacks with disclosed issues", runPipeline("meta", "guide-review-exhausted", (outcome) => Effect.gen(function* () {
    const { canonical, report, normalized } = yield* expectReviewedPublication(outcome)
    expect(normalized).toContain("l2 units")
    expect(canonical.guide).toBeUndefined()
    for (const stage of ["page-check", "headings", "guide"]) expect(outcome.calls.filter((call) => call === `${stage}-review`)).toHaveLength(2)
    expect(report.museReviews?.map(({ stage, rounds, outcome: result }) => ({ stage, rounds, result }))).toEqual([
      { stage: "page-check", rounds: 2, result: "fallback" }, { stage: "headings", rounds: 2, result: "fallback" }, { stage: "guide", rounds: 2, result: "fallback" },
    ])
    expect(report.museReviews?.every((review) => review.attemptIds.length === 3 && review.fallback !== null)).toBe(true)
    expect(report.issues.map((issue) => [issue.code, issue.stage])).toEqual([["provider-failure", "page-check"], ["provider-failure", "headings"], ["provider-failure", "guide"]])
    expect(canonical.blocks.filter((block) => block.kind === "heading").map((block) => block.headingLevel)).toEqual([2])
  })))

  pipelineTest("meta review that would exceed the spending allowance falls back without a review call", runPipeline("meta", "review-budget", (outcome) => Effect.gen(function* () {
    const { report } = yield* expectReviewedPublication(outcome)
    expect(outcome.calls.filter((call) => call.endsWith("-review"))).toEqual([])
    expect(outcome.calls).toContain("headings")
    expect(report.museReviews).toEqual([expect.objectContaining({ stage: "page-check", rounds: 0, outcome: "fallback" })])
    expect(outcome.attempts).toHaveLength(3)
  })))

  pipelineTest("meta oversized context fails before any page check", runPipeline("meta", "oversized-context", (outcome) => Effect.sync(() => {
    expectFailedBeforePublication(outcome, 0)
    expect(outcome.calls).not.toContain("headings")
  })))

  for (const scenario of ["invalid-extraction", "figure-extraction"] as const) {
    pipelineTest(`meta ${scenario} records one rejected extraction response and has no fallback`, runPipeline("meta", scenario, (outcome) => Effect.sync(() => {
      expectFailedBeforePublication(outcome, 0)
      expect(outcome.calls).toEqual(["count", "page-extraction", "count"])
      expect(outcome.attempts).toHaveLength(1)
      expect(outcome.attempts[0]).toMatchObject({ status: "completed", validation_state: "rejected" })
      expect(outcome.attempts[0]?.["response_json"]).toContain("bodyBase64")
    })))
  }

  pipelineTest("mineru is denied without any call or reservation", runPipeline("mineru", "denied", (outcome) => Effect.sync(() => {
    expectFailedBeforePublication(outcome, 0)
    expect(outcome.calls).toEqual([])
    expect(outcome.attempts).toEqual([])
  })))

  pipelineTest("meta guide-invalid publishes without a guide when no review is allowed", runPipeline("meta", "guide-invalid", (outcome) => Effect.gen(function* () {
    const { canonical, report } = yield* expectReviewedPublication(outcome)
    expect(canonical.guide).toBeUndefined()
    expect(report.museReviews).toEqual([expect.objectContaining({ stage: "guide", rounds: 0, outcome: "fallback", problems: expect.arrayContaining([expect.stringContaining("The result is 12 units.")]) })])
    expect(report.checks.find((check) => check.stage === "guide")?.result).toBe("issues")
    expect(outcome.attempts.at(-1)).toMatchObject({ status: "completed", validation_state: "rejected" })
  })))

  pipelineTest("meta guide-tampered fails export verification", runPipeline("meta", "guide-tampered", (outcome) => Effect.sync(() => {
    expectGuideFailure(outcome, "export", "invalid-artifacts")
  })))

  pipelineTest("meta guide-budget fails extraction before any reservation", runPipeline("meta", "guide-budget", (outcome) => Effect.sync(() => {
    expectFailedBeforePublication(outcome, 0)
    expect(outcome.state).toMatchObject({ failure: { stage: "extraction", code: "limit-exceeded" } })
    expect(outcome.attempts).toEqual([])
    expect(outcome.calls).toEqual([])
  })))

  pipelineTest("meta guide-preflight failure makes no guide call", runPipeline("meta", "guide-preflight", (outcome) => Effect.sync(() => {
    expectGuideFailure(outcome, "guide", "provider-failed")
    expect(outcome.attempts).toHaveLength(3)
    expect(outcome.calls).not.toContain("reading-guide")
  })))
})
