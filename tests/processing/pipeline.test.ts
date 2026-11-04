import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Mastra } from "@mastra/core/mastra"
import { LibSQLStore } from "@mastra/libsql"
import { Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { CanonicalDocument, IdempotencyKey, ProcessingReport, RunConfiguration, UserId } from "../../src/domain/index.ts"
import { makeAmuseMe } from "../../src/mastra/amuseme.ts"
import { makeNormalizationBoundary } from "../../src/mastra/normalize-workflow.ts"
import { stageSpecs } from "../../src/paper/correction/index.ts"
import { PdfRenderer } from "../../src/paper/pdf/index.ts"
import { makeMetaAgentBoundary, MetaRequest } from "../../src/paper/providers/meta/index.ts"
import { countEndpoint } from "../../src/paper/providers/meta/transport.ts"
import { MineruArchiveReader } from "../../src/paper/providers/mineru/index.ts"
import { makeProviderGuard, ProviderGuard, type GuardPolicy } from "../../src/processing/index.ts"
import { NormalizationStages } from "../../src/processing/pipeline.ts"
import { ArtifactStore, DocumentStore, OutputStore, StorageDatabase, makeArtifactStore, makeDocumentStoreLayer, makeOutputStore } from "../../src/storage/index.ts"

const model = (stage: "extraction" | "page-check" | "headings" | "figures") => ({ provider: "meta", model: "muse-spark-1.3", reasoning: stage === "headings" ? "medium" : "high", promptName: stageSpecs[stage].promptName, promptVersion: stageSpecs[stage].promptVersion, maxOutputTokens: 16384 })
const policy: GuardPolicy = { mode: "fixture", enabled: true, metaCredentialConfigured: true, mineruCredentialConfigured: true, mineruEndpoint: "https://amuseme-fixture.invalid", budgetId: "pipeline-fixture", authorizedBudgetMicrousd: 100, maximumCostMicrousd: { extraction: 1, "page-check": 1, headings: 1, figures: 1 }, maxConcurrentCalls: 1, maxOutputTokens: 16384, maxRequestBytes: 48 * 1024 * 1024, maxResponseBytes: 2 * 1024 * 1024, callDeadlineMilliseconds: 100000 }
const owner = UserId.make("pipeline-fixture-owner")
const pageInput = Schema.Struct({ currentPage: Schema.Struct({ blocks: Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.String })) }) })
const headingInput = Schema.Struct({ candidates: Schema.Array(Schema.Struct({ blockId: Schema.String, blockType: Schema.String })) })

for (const [provider, scenario] of [["mineru", "success"], ["mineru", "invalid-page"], ["mineru", "oversized-context"], ["meta", "success"], ["meta", "invalid-extraction"], ["meta", "figure-extraction"]] as const) {
  describe(`full saved processing pipeline: ${provider} ${scenario}`, () => {
    it.live("uses the real renderer, archive decoder, guard, registered agents, workflow and output store", () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dataDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-pipeline-" })
      yield* fs.makeDirectory(path.join(dataDirectory, "archives"))
      const pythonBin = path.resolve("data/python/.venv/bin/python")
      const pdf = yield* fs.readFile(path.resolve("tests/fixtures/normal.pdf"))
      const zip = yield* fs.readFile(path.resolve("tests/fixtures/mineru-normal.zip"))
      yield* Effect.gen(function* () {
        const store = yield* DocumentStore
        const configuration = yield* Schema.decodeUnknownEffect(RunConfiguration)({ extractionProvider: provider, extractionVersion: provider === "mineru" ? "4.0.12" : "muse-spark-1.3", ...(provider === "meta" ? { extractionModel: model("extraction") } : {}), pageCheck: model("page-check"), headings: model("headings"), figures: model("figures"), maxProviderAttempts: provider === "meta" ? 1 : 10, deadlineMilliseconds: 120000, spendingCapUsd: 1 })
        yield* store.admit({ ownerId: owner, idempotencyKey: IdempotencyKey.make("fixture-pipeline"), bytes: pdf, originalFilename: "normal.pdf", pageCount: 1, pipelineVersion: "amuseme-1", configuration })
        const claim = yield* store.claimNext({ workerId: "integration", leaseMilliseconds: 120000 })
        if (claim === null) return yield* Effect.die("Expected accepted fixture")
        const artifacts = yield* makeArtifactStore(dataDirectory)
        const outputs = yield* makeOutputStore().pipe(Effect.provideService(ArtifactStore, artifacts))
        const guard = yield* makeProviderGuard(policy)
        const calls: Array<string> = []
        const http = HttpClient.make((request, url) => Effect.gen(function* () {
          if (url.origin === policy.mineruEndpoint) {
            calls.push(`mineru:${request.method}`)
            return HttpClientResponse.fromWeb(request, request.method === "POST" ? Response.json({ callId: url.pathname.split("/").at(-1) }) : new Response(new Uint8Array(zip), { headers: { "content-type": "application/zip" } }))
          }
          if (url.href === countEndpoint) {
            calls.push("count")
            return HttpClientResponse.fromWeb(request, Response.json({ object: "response.input_tokens", input_tokens: scenario === "oversized-context" ? 524289 : 2000 }))
          }
          if (request.body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON body")
          const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MetaRequest))(new TextDecoder().decode(request.body.body))
          const stage = body.response_format.json_schema.name
          calls.push(stage)
          const text = body.messages[1].content.find((part) => part.type === "text")
          if (text?.type !== "text") return yield* Effect.die("Expected complete text")
          let result: Schema.Json
          if (stage === "page-extraction") {
            result = { pageNumber: 1, coverage: scenario === "invalid-extraction" ? "incomplete" : "complete", hasFigures: scenario === "figure-extraction", blocks: [
              { kind: "heading", content: "A synthetic document", format: "text", furniture: null },
              { kind: "paragraph", content: "The result is l2 units.", format: "text", furniture: null },
              { kind: "note", content: "1", format: "text", furniture: "page_number" },
              { kind: "equation", content: "x = 2", format: "latex", furniture: null },
            ] }
          } else if (stage === "page-check") {
            const current = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(pageInput))(text.text)
            const block = current.currentPage.blocks.find((entry) => entry.kind === "paragraph")
            result = { fixes: [{ blockId: scenario === "invalid-page" ? "foreign-block" : block?.id ?? "missing", content: "The result is 12 units." }], joins: [] }
          } else {
            const current = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(headingInput))(text.text)
            result = { headings: current.candidates.map((candidate) => ({ blockId: candidate.blockId, level: candidate.blockType === "heading" ? 1 : null })) }
          }
          return HttpClientResponse.fromWeb(request, Response.json({ id: `fixture-${stage}`, model: "muse-spark-1.3", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(result) } }], usage: { prompt_tokens: 2000, completion_tokens: 100 } }))
        }).pipe(Effect.orDie))
        const meta = makeMetaAgentBoundary(stageSpecs)
        const stages = yield* NormalizationStages.pipe(Effect.provide(NormalizationStages.layer(meta, { policy, temporaryDirectory: path.join(dataDirectory, "processing"), metaCredential: Redacted.make("fixture"), mineruToken: Redacted.make("fixture"), mineruEndpoint: policy.mineruEndpoint! }).pipe(Layer.provide(Layer.mergeAll(
          Layer.succeed(ArtifactStore, artifacts), Layer.succeed(OutputStore, outputs), Layer.succeed(ProviderGuard, guard), Layer.succeed(HttpClient.HttpClient, http),
          PdfRenderer.layer({ pythonBin }), MineruArchiveReader.layer({ pythonBin, tempDirectory: path.join(dataDirectory, "archives") }),
        )))))
        const runEffect = Effect.runPromiseWith(yield* Effect.context())
        const boundary = makeNormalizationBoundary((current, stage, input, signal) => runEffect(stages.execute(current, stage, input).pipe(Effect.match({ onSuccess: (value) => ({ _tag: "success" as const, value }), onFailure: (error) => ({ _tag: "failure" as const, failure: error.failure }) })), { signal }))
        const storage = new LibSQLStore({ id: "pipeline-fixture", url: `file:${dataDirectory}/mastra.sqlite`, maxRetries: 1 })
        yield* Effect.promise(() => storage.init())
        yield* Effect.acquireRelease(Effect.sync(() => new Mastra({ ...makeAmuseMe(4180, { meta, normalization: boundary }), storage })), (mastra) => Effect.promise(() => mastra.shutdown()))
        const state = yield* boundary.starter.startOrReconnect(claim)
        if (scenario === "success") {
          expect(state._tag, JSON.stringify({ state, calls })).toBe("succeeded")
          if (state._tag !== "succeeded") return yield* Effect.die(JSON.stringify(state))
          const file = yield* outputs.read(owner, claim.document.id, state.revisionId, "normalized.txt")
          const normalized = new TextDecoder().decode(file.bytes)
          expect(normalized).toContain("The result is 12 units.")
          expect(normalized).not.toContain("l2 units")
          const canonical = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CanonicalDocument))(new TextDecoder().decode((yield* outputs.read(owner, claim.document.id, state.revisionId, "document.json")).bytes))
          expect(canonical.sourceBlocks.some((block) => block.content.includes("l2 units"))).toBe(true)
          const report = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ProcessingReport))(new TextDecoder().decode((yield* outputs.read(owner, claim.document.id, state.revisionId, "processing-report.json")).bytes))
          expect(report.changes.changedBlockIds).toHaveLength(1)
          expect(report.receipts).toHaveLength(3)
          expect(report.receipts.every((entry) => entry.delivery === "performed" && entry.receipt.state._tag === "completed")).toBe(true)
          expect(calls).toEqual(provider === "mineru" ? ["mineru:POST", "mineru:GET", "count", "page-check", "count", "headings"] : ["count", "page-extraction", "count", "page-check", "count", "headings"])
          if (provider === "meta") {
            expect(canonical.pageFurniture).toEqual([{ blockId: "page-1-block-3", role: "page_number" }])
            expect(report.issues).toEqual([])
            expect(normalized).toContain("x = 2")
            expect(canonical.figures).toEqual([])
          }
        } else {
          expect(state._tag).toBe("failed")
          expect((yield* store.detail(owner, claim.document.id)).currentRevisionId).toBeNull()
          expect(calls.filter((call) => call === "page-check")).toHaveLength(scenario === "invalid-page" ? 1 : 0)
          expect(calls).not.toContain("headings")
          if (provider === "meta") {
            expect(calls).toEqual(["count", "page-extraction"])
            const database = yield* StorageDatabase
            const attempts = yield* database.query("rejected-extraction", () => database.db.selectFrom("provider_attempts").selectAll().execute())
            expect(attempts).toHaveLength(1)
            expect(attempts[0]).toMatchObject({ status: "completed", validation_state: "rejected" })
            expect(attempts[0]?.response_json).toContain("bodyBase64")
          }
        }
      }).pipe(Effect.provide(makeDocumentStoreLayer({ dataDirectory, queueLimit: 5 })))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { timeout: 30000 })
  })
}
