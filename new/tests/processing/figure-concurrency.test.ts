import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Clock, Context, DateTime, Deferred, Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { HttpClient, HttpClientError, HttpClientResponse, type HttpClientRequest } from "effect/http"
import { AssembledDocument } from "../../src/paper/reading/index.ts"
import { IdempotencyKey, RunConfiguration, UserId } from "../../src/domain/index.ts"
import { stageSpecs } from "../../src/paper/correction/index.ts"
import { PdfRenderer } from "../../src/paper/pdf/index.ts"
import { makeMetaAgentBoundary, MetaRequest } from "../../src/paper/providers/meta/index.ts"
import { countEndpoint } from "../../src/paper/providers/meta/transport.ts"
import { makeProviderGuard, makeRunRecovery, ProviderGuard, type GuardPolicy } from "../../src/processing/index.ts"
import { ExtractedData, NormalizationStages } from "../../src/processing/pipeline.ts"
import { Assembled, Extracted, type Checkpoint } from "../../src/processing/checkpoints.ts"
import { ArtifactStore, DocumentStore, OutputStore, StorageDatabase, makeArtifactStore, makeDocumentStoreLayer, makeOutputStore, type DispatchClaim } from "../../src/storage/index.ts"

const GENERATE = String.raw`
import os,sys,pymupdf
os.umask(0o077)
with pymupdf.open() as d:
    p=d.new_page(width=240,height=240)
    p.insert_text((20,25),"Four figures",fontsize=10)
    for n,(x,y) in enumerate([(20,40),(100,40),(180,40),(20,140)],1):
        p.draw_rect(pymupdf.Rect(x,y,x+40,y+40),color=(0,0,1),fill=(0,0,1))
        p.insert_text((x,y+52),f"Figure {n}.",fontsize=8)
    d.save(sys.argv[1])
`
const boxes = [{ x: 80, y: 160, width: 180, height: 180 }, { x: 410, y: 160, width: 180, height: 180 }, { x: 740, y: 160, width: 180, height: 180 }, { x: 80, y: 580, width: 180, height: 180 }]
const correctedSecond = { x: 400, y: 150, width: 200, height: 200 }
const figureAt = (box: { readonly x: number; readonly y: number }) => box.y > 500 ? 4 : box.x < 300 ? 1 : box.x < 700 ? 2 : 3
const block = (kind: string, content: string) => ({ kind, content, format: "text", furniture: null })
const model = (stage: keyof typeof stageSpecs) => ({ provider: "meta", model: "muse-spark-1.3", reasoning: stage === "headings" ? "medium" : "high", promptName: stageSpecs[stage].promptName, promptVersion: stageSpecs[stage].promptVersion, maxOutputTokens: 16384 })
const policy = (maxConcurrentCalls: number): GuardPolicy => ({
  mode: "live", enabled: true, metaCredentialConfigured: true, mineruCredentialConfigured: false, mineruEndpoint: null, budgetId: "figure-concurrency", authorizedBudgetMicrousd: 37_000_000,
  maximumCostMicrousd: { extraction: 2_500_000, "page-check": 1_500_000, headings: 1_500_000, figures: 1_500_000 },
  maxConcurrentCalls, maxOutputTokens: 16384, maxRequestBytes: 48 * 1024 * 1024, maxResponseBytes: 2 * 1024 * 1024, callDeadlineMilliseconds: 4000,
})
const CropInput = Schema.Struct({ figureCropReview: Schema.Struct({ round: Schema.Int, box: Schema.Struct({ x: Schema.Number, y: Schema.Number, width: Schema.Number, height: Schema.Number }) }) })
const HeadingInput = Schema.Struct({ candidates: Schema.Array(Schema.Struct({ blockId: Schema.String, blockType: Schema.String })) })

interface Calls {
  readonly started: Array<string>
  readonly finished: Array<string>
  readonly peak: Record<string, number>
}
// "out-of-order" holds the third figure's call until three calls are in flight and the first two until the third
// finishes, so they finish out of document order. "after-first-failure" holds the second and third figures' crop reviews until the
// first figure's crop review has failed, so they are still running when it fails.
interface Fixture {
  readonly gate: "none" | "out-of-order" | "after-first-failure"
  readonly failFirstCrop: () => boolean
}

const harness = (maxConcurrentCalls: number, fixture: Fixture) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-figure-concurrency-" })
  const pythonBin = path.resolve("data/python/.venv/bin/python")
  const sourcePath = path.join(root, "source.pdf")
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  yield* Effect.scoped(Effect.gen(function* () {
    const process = yield* spawner.spawn(ChildProcess.make(pythonBin, ["-I", "-c", GENERATE, sourcePath]))
    expect(yield* process.exitCode).toBe(0)
  }))
  const calls: Calls = { started: [], finished: [], peak: {} }
  const inFlight: Record<string, number> = {}
  const thirdDone = { crop: yield* Deferred.make<void>(), description: yield* Deferred.make<void>() }
  const firstFailed = Effect.suspend(() => attempts).pipe(Effect.map((rows) => rows.some((row) => row.status === "unknown" && row.stage_key.includes("figure-page-1-block-2\"") && row.stage_key.includes("figure-crop"))))
  const answer = (request: HttpClientRequest.HttpClientRequest, result: Schema.Json) =>
    HttpClientResponse.fromWeb(request, Response.json({ id: `meta-fixture-${calls.started.length}`, model: "muse-spark-1.3", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(result) } }], usage: { prompt_tokens: 2000, completion_tokens: 100 } }))
  const http = HttpClient.make((request, url) => Effect.gen(function* () {
    if (url.href === countEndpoint) return HttpClientResponse.fromWeb(request, Response.json({ object: "response.input_tokens", input_tokens: 2000 }))
    if (request.body._tag !== "Uint8Array") return yield* Effect.die("Expected guarded request bytes")
    const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MetaRequest))(new TextDecoder().decode(request.body.body)).pipe(Effect.orDie)
    const schema = body.response_format.json_schema.name
    const text = body.messages[1].content.find((part) => part.type === "text")
    if (text?.type !== "text") return yield* Effect.die("Expected source context")
    if (schema === "page-extraction") {
      calls.started.push("extraction")
      const blocks = [block("heading", "Four figures"), ...boxes.flatMap((_, index) => [block("figure", "[Figure]"), block("caption", `Figure ${index + 1}.`)])]
      return answer(request, { pageNumber: 1, coverage: "complete", blank: false, blocks, figures: boxes.map((box, index) => ({ blockIndex: 1 + index * 2, captionBlockIndices: [2 + index * 2], box })) })
    }
    if (schema === "page-check") { calls.started.push("page-check"); return answer(request, { fixes: [], joins: [] }) }
    if (schema === "headings") {
      calls.started.push("headings")
      const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(HeadingInput))(text.text).pipe(Effect.orDie)
      return answer(request, { headings: input.candidates.map((candidate) => ({ blockId: candidate.blockId, level: candidate.blockType === "heading" ? 1 : null })) })
    }
    let kind: string
    let figure: number
    let result: Schema.Json
    if (schema === "figures-crop-review") {
      const crop = (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CropInput))(text.text).pipe(Effect.orDie)).figureCropReview
      figure = figureAt(crop.box)
      kind = `crop:${figure}:${crop.round}`
      result = figure === 2 && crop.round === 1 ? { verdict: "corrected", box: correctedSecond } : { verdict: "confirmed", box: null }
    } else {
      const link = body.messages[1].content.findLast((part) => part.type === "text")
      figure = Number(/Figure ID: figure-page-1-block-(\d+)/u.exec(link?.type === "text" ? link.text : "")?.[1]) / 2
      kind = `description:${figure}`
      result = { description: `Figure ${figure} is a blue square.` }
    }
    const stage = kind.split(":")[0] ?? kind
    calls.started.push(kind)
    inFlight[stage] = (inFlight[stage] ?? 0) + 1
    calls.peak[stage] = Math.max(calls.peak[stage] ?? 0, inFlight[stage])
    const bounded = Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.void })
    if (fixture.gate === "out-of-order" && (figure === 1 || figure === 2) && kind !== "crop:2:2") yield* Deferred.await(stage === "crop" ? thirdDone.crop : thirdDone.description).pipe(bounded)
    if (fixture.gate === "out-of-order" && figure === 3) yield* Effect.gen(function* () { while ((inFlight[stage] ?? 0) < 3) yield* Effect.sleep("10 millis") }).pipe(bounded)
    if (fixture.gate === "after-first-failure" && (kind === "crop:2:1" || kind === "crop:3:1")) {
      while (!(yield* firstFailed)) yield* Effect.sleep("20 millis")
      yield* Effect.sleep("100 millis")
    }
    yield* Effect.sleep("20 millis")
    inFlight[stage] -= 1
    calls.finished.push(kind)
    if (figure === 3) yield* Deferred.succeed(stage === "crop" ? thirdDone.crop : thirdDone.description, undefined)
    if (kind === "crop:1:1" && fixture.failFirstCrop()) {
      return yield* Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, description: "Offline connection loss" }) }))
    }
    return answer(request, result)
  }).pipe(Effect.catchTag("StorageFailure", Effect.die)))

  const context = yield* Layer.build(makeDocumentStoreLayer({ dataDirectory: root, queueLimit: 5 }))
  const store = Context.get(context, DocumentStore)
  const database = Context.get(context, StorageDatabase)
  const owner = UserId.make("figure-concurrency-owner")
  const configuration = yield* Schema.decodeUnknownEffect(RunConfiguration)({ extractionProvider: "meta", extractionVersion: "muse-spark-1.3", extractionModel: model("extraction"), pageCheck: model("page-check"), headings: model("headings"), figures: model("figures"), figureCropPromptVersion: "amuseme-2", maxProviderAttempts: 3, deadlineMilliseconds: 120000, spendingCapUsd: 30 })
  yield* store.admit({ ownerId: owner, idempotencyKey: IdempotencyKey.make("four-figures"), bytes: yield* fs.readFile(sourcePath), originalFilename: "four-figures.pdf", pageCount: 1, pipelineVersion: "amuseme-meta-3", configuration })
  const artifacts = yield* makeArtifactStore(root).pipe(Effect.provide(context))
  const outputs = yield* makeOutputStore().pipe(Effect.provideService(ArtifactStore, artifacts), Effect.provide(context))
  const renderer = yield* PdfRenderer.pipe(Effect.provide(PdfRenderer.layer({ pythonBin })))
  const guardPolicy = policy(maxConcurrentCalls)
  const guard = yield* makeProviderGuard(guardPolicy).pipe(Effect.provide(context))
  const recovery = yield* makeRunRecovery(guardPolicy, 5).pipe(Effect.provide(context))
  const stages = yield* NormalizationStages.pipe(Effect.provide(NormalizationStages.layer(makeMetaAgentBoundary(stageSpecs), { policy: guardPolicy, temporaryDirectory: path.join(root, "processing"), metaCredential: Redacted.make("offline-fixture") }).pipe(
    Layer.provide(Layer.mergeAll(Layer.succeedContext(context), Layer.succeed(ArtifactStore, artifacts), Layer.succeed(OutputStore, outputs), Layer.succeed(ProviderGuard, guard), Layer.succeed(HttpClient.HttpClient, http), Layer.succeed(PdfRenderer, renderer))),
  )))
  const claimNext = Effect.gen(function* () {
    const claim = yield* store.claimNext({ workerId: "figure-concurrency", leaseMilliseconds: 120000 })
    if (claim === null) return yield* Effect.die("Expected a claim")
    return claim
  })
  const extracted = (checkpoint: Checkpoint) => Effect.gen(function* () {
    const saved = yield* Schema.decodeUnknownEffect(Extracted)(checkpoint)
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ExtractedData))(new TextDecoder().decode(yield* artifacts.read(owner, saved.documentId, saved.extraction)))
  })
  const publish = (claim: DispatchClaim) => Effect.gen(function* () {
    let checkpoint: Checkpoint = { documentId: claim.document.id, runId: claim.run.id }
    for (const stage of ["extraction", "page-check", "headings", "figures", "assembly"] as const) checkpoint = yield* stages.execute(claim, stage, checkpoint)
    const assembled = yield* Schema.decodeUnknownEffect(Assembled)(checkpoint)
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AssembledDocument))(new TextDecoder().decode(yield* artifacts.read(owner, claim.document.id, assembled.publication)))
  })
  const attempts = database.query("figure-concurrency-attempts", () => database.db.selectFrom("provider_attempts").selectAll().orderBy("created_at", "asc").execute())
  const retry = (previous: DispatchClaim) => Effect.gen(function* () {
    yield* store.updateRun(previous, { _tag: "interrupted", finishedAt: DateTime.formatIso(yield* DateTime.now), failure: { code: "provider-unknown-completion", message: "Fixture connection loss", retryable: true, stage: "extraction", pageId: null, figureId: null } })
    const leased = Effect.all([attempts, Clock.currentTimeMillis]).pipe(Effect.map(([rows, now]) => rows.some((row) => row.status === "unknown" && row.lease_expires_at > now)))
    while (yield* leased) yield* Effect.sleep("100 millis")
    yield* recovery.requestRetry({ ownerId: owner, documentId: previous.document.id, previousRunId: previous.run.id, idempotencyKey: IdempotencyKey.make("figure-concurrency-retry"), acknowledgesUnknownCompletion: true })
    return yield* claimNext
  })
  return { calls, claimNext, stages, extracted, publish, attempts, retry }
})

const published = (document: AssembledDocument) => ({
  figures: document.canonical.figures.map((figure) => ({
    id: figure.id, description: figure.description._tag === "generated" ? figure.description.text : null, asset: figure.asset._tag === "available" ? figure.asset.artifact.hash : null,
  })),
  crops: (document.report.figureCrops ?? []).map(({ attemptIds, ...crop }) => ({ ...crop, attempts: attemptIds.length })),
  issues: document.report.issues.map((issue) => [issue.code, issue.figureId]),
})

describe("figure work runs a few chains at a time", () => {
  it.live("keeps at most three figure chains in flight and publishes the same document as one call at a time", () => Effect.gen(function* () {
    const sequential = yield* harness(1, { gate: "none", failFirstCrop: () => false })
    const one = yield* sequential.publish(yield* sequential.claimNext)
    expect(sequential.calls.peak).toEqual({ crop: 1, description: 1 })
    const concurrent = yield* harness(4, { gate: "out-of-order", failFirstCrop: () => false })
    const many = yield* concurrent.publish(yield* concurrent.claimNext)
    expect(concurrent.calls.peak).toEqual({ crop: 3, description: 3 })
    expect(concurrent.calls.finished.indexOf("crop:1:1")).toBeGreaterThan(concurrent.calls.finished.indexOf("crop:3:1"))
    expect(concurrent.calls.finished.indexOf("description:1")).toBeGreaterThan(concurrent.calls.finished.indexOf("description:3"))
    expect(published(many)).toEqual(published(one))
    expect(published(many).figures).toEqual([1, 2, 3, 4].map((figure) => expect.objectContaining({ id: `figure-page-1-block-${figure * 2}`, description: `Figure ${figure} is a blue square.` })))
    expect(published(many).crops.map((crop) => [crop.figureId, crop.outcome, crop.attempts])).toEqual([
      ["figure-page-1-block-2", "confirmed", 1], ["figure-page-1-block-4", "corrected", 2], ["figure-page-1-block-6", "confirmed", 1], ["figure-page-1-block-8", "confirmed", 1],
    ])
    expect(many.report.receipts.filter(({ receipt }) => receipt.stage === "figures").map(({ receipt }) => [receipt.task ?? "description", receipt.figureId]).toSorted()).toEqual(
      one.report.receipts.filter(({ receipt }) => receipt.stage === "figures").map(({ receipt }) => [receipt.task ?? "description", receipt.figureId]).toSorted(),
    )
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { timeout: 60000 })

  it.live("lets sibling calls finish when one chain fails, and the retry sends only the unfinished figures", () => Effect.gen(function* () {
    let failing = true
    const run = yield* harness(4, { gate: "after-first-failure", failFirstCrop: () => failing })
    const claim = yield* run.claimNext
    const failed = yield* run.stages.execute(claim, "extraction", { documentId: claim.document.id, runId: claim.run.id }).pipe(Effect.flip)
    expect(failed.failure).toMatchObject({ code: "provider-unknown-completion", stage: "extraction" })
    expect(run.calls.started.filter((call) => call.startsWith("crop")).toSorted()).toEqual(["crop:1:1", "crop:2:1", "crop:2:2", "crop:3:1"])
    const crops = (yield* run.attempts).filter((row) => row.stage_key.includes("figure-crop"))
    expect(crops.map((row) => row.status).toSorted()).toEqual(["completed", "completed", "completed", "unknown"])

    failing = false
    const before = run.calls.started.length
    const retried = yield* run.retry(claim)
    const input = { documentId: retried.document.id, runId: retried.run.id }
    const data = yield* run.extracted(yield* run.stages.execute(retried, "extraction", input))
    expect(run.calls.started.slice(before).toSorted()).toEqual(["crop:1:1", "crop:4:1"])
    expect(data.cropReviews?.map((crop) => [crop.figureId, crop.outcome])).toEqual([
      ["figure-page-1-block-2", "confirmed"], ["figure-page-1-block-4", "corrected"], ["figure-page-1-block-6", "confirmed"], ["figure-page-1-block-8", "confirmed"],
    ])
    const resumed = run.calls.started.length
    expect((yield* run.extracted(yield* run.stages.execute(retried, "extraction", input))).cropReviews).toEqual(data.cropReviews)
    expect(run.calls.started).toHaveLength(resumed)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { timeout: 60000 })
})
