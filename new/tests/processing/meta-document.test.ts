import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Mastra } from "@mastra/core/mastra"
import { LibSQLStore } from "@mastra/libsql"
import { Effect, FileSystem, Layer, Path, Redacted, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { HttpClient, HttpClientResponse } from "effect/http"
import { CanonicalDocument, PageId, IdempotencyKey, ProcessingReport, RunConfiguration, UserId } from "../../src/domain/index.ts"
import { makeAmuseMe } from "../../src/mastra/amuseme.ts"
import { makeNormalizationBoundary } from "../../src/mastra/normalize-workflow.ts"
import { stageSpecs } from "../../src/paper/correction/index.ts"
import { PdfRenderer } from "../../src/paper/pdf/index.ts"
import { makeMetaAgentBoundary, MetaRequest } from "../../src/paper/providers/meta/index.ts"
import { countEndpoint } from "../../src/paper/providers/meta/transport.ts"
import { makeProviderGuard, ProviderGuard, type GuardPolicy } from "../../src/processing/index.ts"
import { ExtractedData, NormalizationStages } from "../../src/processing/pipeline.ts"
import { ArtifactStore, DocumentStore, OutputStore, StorageDatabase, makeArtifactStore, makeDocumentStoreLayer, makeOutputStore } from "../../src/storage/index.ts"

const GENERATE = String.raw`
import os,sys,pymupdf
os.umask(0o077)
with pymupdf.open() as d:
    p=d.new_page(width=240,height=240)
    for point,text in [((20,25),"A synthetic document"),((20,55),"A; B"),((20,70),"12; 9"),((20,180),"Figure 1. Red square.")]:
        p.insert_text(point,text,fontsize=10)
    p.draw_rect(pymupdf.Rect(100,100,140,140),color=(1,0,0),fill=(1,0,0))
    d.new_page(width=240,height=240)
    p=d.new_page(width=240,height=240)
    p.insert_text((20,25),"References are retained.",fontsize=10)
    p.set_rotation(90)
    if len(sys.argv)>2: d.new_page(width=240,height=240)
    d.save(sys.argv[1])
`
const table = "<table><tr><th>A</th><th>B</th></tr><tr><td>12<br>units</td><td>9</td></tr></table>"
const block = (kind: string, content: string, format = "text") => ({ kind, content, format, furniture: null })
const model = (stage: keyof typeof stageSpecs) => ({ provider: "meta", model: "muse-spark-1.3", reasoning: stage === "headings" ? "medium" : "high", promptName: stageSpecs[stage].promptName, promptVersion: stageSpecs[stage].promptVersion, maxOutputTokens: 16384 })
const policy: GuardPolicy = { mode: "live", enabled: true, metaCredentialConfigured: true, mineruCredentialConfigured: false, mineruEndpoint: null, budgetId: "offline-meta-fixture", authorizedBudgetMicrousd: 100, maximumCostMicrousd: { extraction: 1, "page-check": 1, headings: 1, figures: 1 }, maxConcurrentCalls: 1, maxOutputTokens: 16384, maxRequestBytes: 48 * 1024 * 1024, maxResponseBytes: 2 * 1024 * 1024, callDeadlineMilliseconds: 100000 }
const firstText = Schema.Struct({ pageNumber: Schema.Int })
const headingInput = Schema.Struct({ candidates: Schema.Array(Schema.Struct({ blockId: Schema.String, blockType: Schema.String })) })

for (const scenario of ["complete", "page-two-preflight", "crop-unavailable", "budget-refused"] as const) describe(`Meta document workflow ${scenario}`, () => {
  it.live("publishes all physical pages, literal tables, truthful figure assets and guarded receipts", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-meta-document-" })
    const pythonBin = path.resolve("data/python/.venv/bin/python")
    const sourcePath = path.join(root, "source.pdf")
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    yield* Effect.scoped(Effect.gen(function* () {
      const process = yield* spawner.spawn(ChildProcess.make(pythonBin, ["-I", "-c", GENERATE, sourcePath, ...(scenario === "budget-refused" ? ["4"] : [])]))
      expect(yield* process.exitCode).toBe(0)
    }))
    const pdf = yield* fs.readFile(sourcePath)
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const owner = UserId.make("meta-document-owner")
      const configuration = yield* Schema.decodeUnknownEffect(RunConfiguration)({ extractionProvider: "meta", extractionVersion: "muse-spark-1.3", extractionModel: model("extraction"), pageCheck: model("page-check"), headings: model("headings"), figures: model("figures"), maxProviderAttempts: 1, deadlineMilliseconds: 120000, spendingCapUsd: scenario === "budget-refused" || scenario === "complete" ? 15 : 1 })
      yield* store.admit({ ownerId: owner, idempotencyKey: IdempotencyKey.make("three-page"), bytes: pdf, originalFilename: "three-page.pdf", pageCount: scenario === "budget-refused" ? 4 : 3, pipelineVersion: "amuseme-meta-2", configuration })
      const claim = yield* store.claimNext({ workerId: "meta-document", leaseMilliseconds: 120000 })
      if (claim === null) return yield* Effect.die("Expected claim")
      const artifacts = yield* makeArtifactStore(root)
      const outputs = yield* makeOutputStore().pipe(Effect.provideService(ArtifactStore, artifacts))
      const actualPolicy = scenario === "budget-refused" || scenario === "complete" ? { ...policy, authorizedBudgetMicrousd: 37000000, maximumCostMicrousd: { extraction: 2500000, "page-check": 1500000, headings: 1500000, figures: 1500000 } } : policy
      const guard = yield* makeProviderGuard(actualPolicy)
      const generations: Array<string> = []
      let preflights = 0
      const http = HttpClient.make((request, url) => Effect.gen(function* () {
        if (url.href === countEndpoint) {
          preflights += 1
          return HttpClientResponse.fromWeb(request, scenario === "page-two-preflight" && preflights === 2 ? new Response("unavailable", { status: 503 }) : Response.json({ object: "response.input_tokens", input_tokens: 2000 }))
        }
        if (request.body._tag !== "Uint8Array") return yield* Effect.die("Expected guarded request bytes")
        const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MetaRequest))(new TextDecoder().decode(request.body.body))
        expect(body.model).toBe("muse-spark-1.3")
        const stage = body.response_format.json_schema.name
        const text = body.messages[1].content.find((part) => part.type === "text")
        if (text?.type !== "text") return yield* Effect.die("Expected source context")
        let result: Schema.Json
        if (stage === "page-extraction") {
          const page = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(firstText))(text.text)
          generations.push(`${stage}:${page.pageNumber}`)
          result = { pageNumber: page.pageNumber, coverage: "complete", blank: page.pageNumber === 2, blocks: page.pageNumber === 1 ? [block("heading", "A synthetic document"), block("table", table, "html"), block("figure", "[Figure]"), block("caption", "Figure 1. Red square."), block("figure", "[Figure with unavailable region]"), block("caption", "Figure 2. Region unavailable.")] : page.pageNumber === 2 ? [] : [block("reference", "References are retained.")], figures: page.pageNumber === 1 ? [{ blockIndex: 2, captionBlockIndices: [3], box: { x: 420, y: 420, width: 160, height: 160 } }, { blockIndex: 4, captionBlockIndices: [5], box: null }] : [] }
        } else if (stage === "page-check") { generations.push(stage); result = { fixes: [], joins: [] } }
        else if (stage === "headings") {
          generations.push(stage)
          const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(headingInput))(text.text)
          result = { headings: input.candidates.map((candidate) => ({ blockId: candidate.blockId, level: candidate.blockType === "heading" ? 1 : null })) }
        } else { generations.push(stage); result = { description: "A red square." } }
        return HttpClientResponse.fromWeb(request, Response.json({ id: `meta-fixture-${generations.length}`, model: "muse-spark-1.3", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(result) } }], usage: { prompt_tokens: 2000, completion_tokens: 100 } }))
      }).pipe(Effect.orDie))
      const realRenderer = yield* PdfRenderer.pipe(Effect.provide(PdfRenderer.layer({ pythonBin })))
      const missingCropRuntime = yield* PdfRenderer.pipe(Effect.provide(PdfRenderer.layer({ pythonBin: "/nonexistent-amuseme-fixture-python" })))
      const renderer = PdfRenderer.of({ render: realRenderer.render, crop: scenario === "crop-unavailable" ? missingCropRuntime.crop : realRenderer.crop })
      const meta = makeMetaAgentBoundary(stageSpecs)
      const stages = yield* NormalizationStages.pipe(Effect.provide(NormalizationStages.layer(meta, { policy: actualPolicy, temporaryDirectory: path.join(root, "processing"), metaCredential: Redacted.make("offline-fixture") }).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(ArtifactStore, artifacts), Layer.succeed(OutputStore, outputs), Layer.succeed(ProviderGuard, guard), Layer.succeed(HttpClient.HttpClient, http), Layer.succeed(PdfRenderer, renderer))))))
      const input = { documentId: claim.document.id, runId: claim.run.id }
      if (scenario === "budget-refused") {
        expect(yield* stages.execute(claim, "extraction", input).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { failure: { code: "limit-exceeded", stage: "extraction" } } })
        expect(preflights).toBe(0)
        expect(generations).toEqual([])
        const database = yield* StorageDatabase
        expect(yield* database.query("no-budget-attempts", () => database.db.selectFrom("provider_attempts").selectAll().execute())).toEqual([])
        expect(yield* database.query("no-budget-charges", () => database.db.selectFrom("provider_charges").selectAll().execute())).toEqual([])
        return
      }
      if (scenario === "page-two-preflight") {
        const failed = yield* stages.execute(claim, "extraction", input).pipe(Effect.result)
        expect(failed).toMatchObject({ _tag: "Failure", failure: { failure: { code: "provider-failed", stage: "extraction" } } })
        expect(generations).toEqual(["page-extraction:1"])
        const checkpoint = yield* stages.execute(claim, "extraction", input)
        expect("extraction" in checkpoint).toBe(true)
        expect(generations).toEqual(["page-extraction:1", "page-extraction:2", "page-extraction:3"])
      }
      if (scenario === "complete") {
        const checkpoint = yield* stages.execute(claim, "extraction", input)
        if (!("extraction" in checkpoint)) return yield* Effect.die("Expected extraction checkpoint")
        const saved = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ExtractedData))(new TextDecoder().decode(yield* artifacts.read(owner, claim.document.id, checkpoint.extraction)))
        const receipts = saved.receipts
        if (receipts === undefined) return yield* Effect.die("Expected page receipts")
        const countBefore = preflights
        for (const changed of [[receipts[0]], receipts.map((receipt, index) => index === 1 ? { ...receipt, id: receipts[0]!.id } : receipt), receipts.map((receipt, index) => index === 1 ? { ...receipt, pageIds: [PageId.make("page-1")] } : receipt)]) {
          const reference = yield* artifacts.put(owner, claim.document.id, new TextEncoder().encode(JSON.stringify({ conversion: saved.conversion, receipts: changed })))
          expect(yield* stages.execute(claim, "page-check", { ...checkpoint, extraction: reference }).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { failure: { code: "invalid-provider-response" } } })
        }
        expect(preflights).toBe(countBefore)
      }
      const runEffect = Effect.runPromiseWith(yield* Effect.context())
      const boundary = makeNormalizationBoundary((current, stage, checkpoint, signal) => runEffect(stages.execute(current, stage, checkpoint).pipe(Effect.match({ onSuccess: (value) => ({ _tag: "success" as const, value }), onFailure: (error) => ({ _tag: "failure" as const, failure: error.failure }) })), { signal }))
      const storage = new LibSQLStore({ id: "meta-document", url: `file:${root}/mastra.sqlite`, maxRetries: 1 })
      yield* Effect.promise(() => storage.init())
      yield* Effect.acquireRelease(Effect.sync(() => new Mastra({ ...makeAmuseMe(4180, { meta, normalization: boundary }), storage })), (mastra) => Effect.promise(() => mastra.shutdown()))
      const state = yield* boundary.starter.startOrReconnect(claim)
      expect(state._tag, JSON.stringify({ state, generations })).toBe("succeeded-with-issues")
      if (state._tag !== "succeeded-with-issues") return yield* Effect.die("Expected published output")
      const read = (name: string) => outputs.read(owner, claim.document.id, state.revisionId, name).pipe(Effect.map((file) => new TextDecoder().decode(file.bytes)))
      const canonical = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CanonicalDocument))(yield* read("document.json"))
      const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProcessingReport))(yield* read("processing-report.json"))
      const normalized = yield* read("normalized.txt")
      expect(canonical.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3])
      expect(canonical.sourceBlocks.map((entry) => entry.readingOrder)).toEqual([0, 1, 2, 3, 4, 5, 6])
      expect(canonical.sourceBlocks.find((entry) => entry.kind === "table")?.content).toBe(table)
      expect(canonical.blocks.find((entry) => entry.kind === "table")?.content).toBe(table)
      expect(normalized).toContain(table)
      expect(normalized).toContain("== Page 2")
      expect(normalized).toContain("References are retained.")
      expect(canonical.figures).toHaveLength(2)
      const firstFigure = canonical.figures[0]!
      if (scenario === "crop-unavailable") {
        expect(firstFigure.asset._tag).toBe("unavailable")
        expect(generations).not.toContain("figures")
      } else {
        expect(firstFigure.asset).toMatchObject({ _tag: "available", provenance: { _tag: "rendered-page-region", sourceHash: claim.document.sourceHash, pageId: "page-1", pageNumber: 1, pageImageHash: canonical.pages[0]?.image.hash, width: 160, height: 160 } })
        if (firstFigure.asset._tag !== "available") return yield* Effect.die("Expected crop")
        const image = yield* outputs.read(owner, claim.document.id, state.revisionId, firstFigure.asset.artifact.path)
        const imagePath = path.join(root, "published.png")
        yield* fs.writeFile(imagePath, image.bytes, { mode: 0o600 })
        yield* Effect.scoped(Effect.gen(function* () {
          const process = yield* spawner.spawn(ChildProcess.make(pythonBin, ["-I", "-c", "import pymupdf,sys,json; p=pymupdf.Pixmap(sys.argv[1]); print(json.dumps([p.width,p.height,list(p.pixel(80,80))]))", imagePath]))
          expect(yield* process.stdout.pipe(Stream.decodeText(), Stream.mkString)).toBe("[160, 160, [255, 0, 0]]\n")
          expect(yield* process.exitCode).toBe(0)
        }))
        expect(normalized).toContain("Image origin: rendered source-page region")
      }
      expect(canonical.figures[1]?.asset._tag).toBe("unavailable")
      expect(report.receipts.filter(({ receipt }) => receipt.stage === "extraction").map(({ receipt }) => receipt.pageIds)).toEqual([["page-1"], ["page-2"], ["page-3"]])
      expect(report.receipts.every(({ receipt }) => receipt.configuration.provider === "meta")).toBe(true)
      expect(generations.filter((entry) => entry.startsWith("page-extraction"))).toEqual(["page-extraction:1", "page-extraction:2", "page-extraction:3"])
      const database = yield* StorageDatabase
      const attempts = yield* database.query("meta-document-attempts", () => database.db.selectFrom("provider_attempts").selectAll().execute())
      expect(attempts).toHaveLength(scenario === "crop-unavailable" ? 7 : 8)
      expect(attempts.every((row) => row.validation_state === "accepted")).toBe(true)
      expect(Schema.is(ExtractedData)({ conversion: { extraction: canonical, issues: [] }, receipt: report.receipts[0]?.receipt, receipts: [report.receipts[0]?.receipt] })).toBe(false)
    }).pipe(Effect.provide(makeDocumentStoreLayer({ dataDirectory: root, queueLimit: 5 })))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { timeout: 30000 })
})
