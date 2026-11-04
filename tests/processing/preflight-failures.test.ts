import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { IdempotencyKey, UserId } from "../../src/domain/index.ts"
import { applyPageChecks, stageSpecs } from "../../src/paper/correction/index.ts"
import { PdfRenderer } from "../../src/paper/pdf/index.ts"
import { makeMetaAgentBoundary } from "../../src/paper/providers/meta/index.ts"
import { countEndpoint } from "../../src/paper/providers/meta/transport.ts"
import { MineruArchiveReader } from "../../src/paper/providers/mineru/index.ts"
import { Described } from "../../src/processing/checkpoints.ts"
import { makeProviderGuard, makeRunRecovery, ProviderGuard, type GuardPolicy } from "../../src/processing/index.ts"
import { NormalizationStages } from "../../src/processing/pipeline.ts"
import { ArtifactStore, DocumentStore, OutputStore, StorageDatabase, makeArtifactStore, makeDocumentStoreLayer, makeOutputStore } from "../../src/storage/index.ts"
import { contractFixture } from "../fixtures/contracts.ts"

const policy: GuardPolicy = { mode: "fixture", enabled: true, metaCredentialConfigured: true, mineruCredentialConfigured: true, mineruEndpoint: "https://amuseme-fixture.invalid", budgetId: "preflight-fixture", authorizedBudgetMicrousd: 100, maximumCostMicrousd: { extraction: 1, "page-check": 1, headings: 1, figures: 1 }, maxConcurrentCalls: 1, maxOutputTokens: 1000, maxRequestBytes: 48 * 1024 * 1024, maxResponseBytes: 2 * 1024 * 1024, callDeadlineMilliseconds: 100000 }
const cases = [
  { stage: "figures", failure: "transient", status: 503, body: "{}", code: null },
  { stage: "headings", failure: "transient", status: 503, body: "{}", code: "provider-failed" },
  { stage: "figures", failure: "invalid-count", status: 200, body: "{}", code: "invalid-provider-response" },
  { stage: "figures", failure: "context-limit", status: 200, body: '{"object":"response.input_tokens","input_tokens":524289}', code: "limit-exceeded" },
  { stage: "figures", failure: "rejected", status: 401, body: "{}", code: "processing-unavailable" },
  { stage: "figures", failure: "structural", status: 503, body: "{}", code: "invalid-provider-response" },
] as const

describe("saved-stage token-count failures", () => {
  for (const scenario of cases) it.live(`${scenario.stage}: ${scenario.failure}`, () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dataDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-preflight-" })
    yield* Effect.gen(function* () {
      const fixture = contractFixture("missing-description")
      const documents = yield* DocumentStore
      const owner = UserId.make("preflight-owner")
      const bytes = yield* fs.readFile(path.resolve("tests/fixtures/missing-description.pdf"))
      yield* documents.admit({ ownerId: owner, idempotencyKey: IdempotencyKey.make("preflight-upload"), originalFilename: "missing-description.pdf", bytes, pageCount: 1, pipelineVersion: "1", configuration: fixture.run.configuration })
      const claim = yield* documents.claimNext({ workerId: "preflight-worker", leaseMilliseconds: 120000 })
      if (claim === null) return yield* Effect.die("Expected processing claim")
      const artifacts = yield* makeArtifactStore(dataDirectory)
      const outputs = yield* makeOutputStore().pipe(Effect.provideService(ArtifactStore, artifacts))
      const guard = yield* makeProviderGuard(policy)
      const image = yield* artifacts.put(owner, claim.document.id, yield* fs.readFile(path.resolve("tests/paper/mineru/fixtures/page_1_image_4.jpg")))
      const extraction = { ...fixture.extraction, scope: { documentId: claim.document.id, runId: claim.run.id, sourceHash: claim.document.sourceHash }, figures: fixture.extraction.figures.map((figure) => ({ ...figure, asset: { _tag: "available" as const, artifact: { ...image, path: "images/figure.jpeg", mediaType: "image/jpeg" as const } } })) }
      const template = fixture.report.receipts[0]?.receipt
      if (template === undefined) return yield* Effect.die("Expected fixture receipt")
      const receipt = { ...template, ownerId: owner, scope: extraction.scope }
      const corrected = yield* Effect.fromResult(applyPageChecks(extraction, [{ scope: extraction.scope, pageId: extraction.pages[0]!.id, previousContextIds: [], result: { fixes: [], joins: [] }, providerAttemptId: receipt.id }]))
      const save = (value: unknown) => artifacts.put(owner, claim.document.id, new TextEncoder().encode(JSON.stringify(value)))
      const input = { documentId: claim.document.id, runId: claim.run.id,
        extraction: yield* save({ conversion: { extraction, accounting: [], issues: [] }, receipt }),
        correction: yield* save({ corrected: scenario.failure === "structural" ? { ...corrected, blocks: [] } : corrected, receipts: [receipt] }),
        hierarchy: yield* save({ response: { headings: [] }, receipt }),
      }
      let countCalls = 0
      const client = HttpClient.make((request) => Effect.sync(() => {
        expect(request.url).toBe(countEndpoint)
        countCalls += 1
        return HttpClientResponse.fromWeb(request, new Response(scenario.body, { status: scenario.status }))
      }))
      const pythonBin = path.resolve("data/python/.venv/bin/python")
      const stages = yield* NormalizationStages.pipe(Effect.provide(NormalizationStages.layer(makeMetaAgentBoundary(stageSpecs), { policy, temporaryDirectory: path.join(dataDirectory, "processing"), metaCredential: Redacted.make("fixture"), mineruToken: Redacted.make("fixture"), mineruEndpoint: policy.mineruEndpoint! }).pipe(Layer.provide(Layer.mergeAll(
        Layer.succeed(ArtifactStore, artifacts), Layer.succeed(OutputStore, outputs), Layer.succeed(ProviderGuard, guard), Layer.succeed(HttpClient.HttpClient, client), PdfRenderer.layer({ pythonBin }), MineruArchiveReader.layer({ pythonBin, tempDirectory: dataDirectory }),
      )))))
      const result = yield* stages.execute(claim, scenario.stage, input).pipe(Effect.result)
      expect(countCalls).toBe(scenario.failure === "structural" ? 0 : 1)
      const database = yield* StorageDatabase
      expect(yield* database.query("test-attempts", () => database.db.selectFrom("provider_attempts").select("id").execute())).toEqual([])
      expect(yield* database.query("test-charges", () => database.db.selectFrom("provider_charges").selectAll().execute())).toEqual([])
      if (scenario.code === null) {
        expect(result._tag).toBe("Success")
        if (result._tag !== "Success") return yield* Effect.die("Expected unavailable description checkpoint")
        const saved = yield* Schema.decodeUnknownEffect(Described)(result.success)
        const descriptions = JSON.parse(new TextDecoder().decode(yield* artifacts.read(owner, claim.document.id, saved.descriptions)))
        expect(descriptions.figures).toEqual(extraction.figures.map((figure) => ({ ...figure, description: { _tag: "unavailable", reason: expect.any(String) } })))
        expect(descriptions.issues).toEqual([{ code: "figure-description-unavailable", message: expect.any(String), stage: "figures", locations: extraction.figures[0]!.locations, blockIds: extraction.figures[0]!.sourceBlockIds, figureId: extraction.figures[0]!.id }])
        expect(descriptions.receipts).toEqual([])
      } else {
        expect(result).toMatchObject({ _tag: "Failure", failure: { failure: { code: scenario.code, retryable: scenario.code === "provider-failed" } } })
        if (result._tag === "Failure") {
          yield* documents.updateRun(claim, { _tag: "failed", finishedAt: DateTime.formatIso(yield* DateTime.now), failure: result.failure.failure })
          expect(yield* documents.claimNext({ workerId: "no-auto-retry", leaseMilliseconds: 120000 })).toBeNull()
          expect((yield* documents.detail(owner, claim.document.id)).currentRevisionId).toBeNull()
          const recovery = yield* makeRunRecovery(policy, 5)
          const request = { ownerId: owner, documentId: claim.document.id, previousRunId: claim.run.id, idempotencyKey: IdempotencyKey.make("explicit-retry"), acknowledgesUnknownCompletion: false }
          if (scenario.code === "provider-failed") {
            expect((yield* recovery.requestRetry(request)).runId).not.toBe(claim.run.id)
            expect(countCalls).toBe(1)
          } else if (scenario.code === "invalid-provider-response") expect(yield* recovery.requestRetry(request).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: "invalid-provider-response" } })
        }
      }
    }).pipe(Effect.provide(makeDocumentStoreLayer({ dataDirectory, queueLimit: 5 })))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
