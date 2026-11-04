import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, FileSystem, Layer, Path, PlatformError, Redacted, Schema } from "effect"
import { HttpClient } from "effect/http"
import { IdempotencyKey, RunConfiguration, UserId, type Failure } from "../../src/domain/index.ts"
import { stageSpecs } from "../../src/paper/correction/index.ts"
import { PdfRenderer } from "../../src/paper/pdf/index.ts"
import { makeMetaAgentBoundary } from "../../src/paper/providers/meta/index.ts"
import { makeProviderGuard, makeRunRecovery, ProviderGuard, type GuardPolicy } from "../../src/processing/index.ts"
import { NormalizationStages } from "../../src/processing/pipeline.ts"
import { affordablePageLimit } from "../../src/processing/policy.ts"
import {
  ArtifactStore, DocumentStore, OutputStore, StorageDatabase, makeArtifactStore, makeDocumentStoreLayer,
  makeOutputStore, type DispatchClaim,
} from "../../src/storage/index.ts"

const policy: GuardPolicy = {
  mode: "fixture", enabled: true, metaCredentialConfigured: true, mineruCredentialConfigured: false,
  mineruEndpoint: null, budgetId: "stage-failures", authorizedBudgetMicrousd: 100,
  maximumCostMicrousd: { extraction: 1, "page-check": 1, headings: 1, figures: 1 },
  maxConcurrentCalls: 1, maxOutputTokens: 1000, maxRequestBytes: 1024 * 1024, maxResponseBytes: 1024 * 1024,
  callDeadlineMilliseconds: 100_000,
}
const model = (stage: keyof typeof stageSpecs) => ({
  provider: "meta", model: "muse-spark-1.3", reasoning: "high", promptName: stageSpecs[stage].promptName,
  promptVersion: stageSpecs[stage].promptVersion, maxOutputTokens: 1000,
})
const configuration = {
  extractionProvider: "meta", extractionVersion: "muse-spark-1.3", extractionModel: model("extraction"),
  pageCheck: model("page-check"), headings: model("headings"), figures: model("figures"),
  maxProviderAttempts: 1, deadlineMilliseconds: 120_000, spendingCapUsd: 1,
}
const diskFull = PlatformError.systemError({
  _tag: "Unknown", module: "FileSystem", method: "writeFile", description: "no space left on device",
})
const offline = HttpClient.make(() => Effect.die("A local I/O failure must stop processing before any provider call"))
const unreachable = () => Effect.die("A local I/O failure must stop processing before rendering")

const owner = UserId.make("stage-failures-owner")
const failedExtraction = <A, E, R>(
  stagePolicy: GuardPolicy, settings: object, pageCount: number,
  inspect: (failure: Failure, claim: DispatchClaim) => Effect.Effect<A, E, R>,
) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dataDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-stage-failures-" })
  return yield* Effect.gen(function* () {
    const documents = yield* DocumentStore
    yield* documents.admit({
      ownerId: owner, idempotencyKey: IdempotencyKey.make("disk-full"), originalFilename: "missing-description.pdf",
      bytes: yield* fs.readFile(path.resolve("tests/fixtures/missing-description.pdf")),
      pageCount, pipelineVersion: "1", configuration: yield* Schema.decodeUnknownEffect(RunConfiguration)(settings),
    })
    const claim = yield* documents.claimNext({ workerId: "stage-failures", leaseMilliseconds: 120_000 })
    if (claim === null) return yield* Effect.die("Expected processing claim")
    const artifacts = yield* makeArtifactStore(dataDirectory)
    const outputs = yield* makeOutputStore().pipe(Effect.provideService(ArtifactStore, artifacts))
    const guard = yield* makeProviderGuard(stagePolicy)
    const failingWrites = FileSystem.FileSystem.of({
      ...fs,
      writeFile: (file, data, options) => path.basename(file) === "source.pdf"
        ? Effect.fail(diskFull) : fs.writeFile(file, data, options),
    })
    const services = Layer.mergeAll(
      Layer.succeed(FileSystem.FileSystem, failingWrites), Layer.succeed(ArtifactStore, artifacts),
      Layer.succeed(OutputStore, outputs), Layer.succeed(ProviderGuard, guard),
      Layer.succeed(HttpClient.HttpClient, offline),
      Layer.succeed(PdfRenderer, PdfRenderer.of({ render: unreachable, crop: unreachable })),
    )
    const temporaryDirectory = path.join(dataDirectory, "processing")
    const options = { policy: stagePolicy, temporaryDirectory, metaCredential: Redacted.make("fixture") }
    const layer = NormalizationStages.layer(makeMetaAgentBoundary(stageSpecs), options).pipe(Layer.provide(services))
    const stages = yield* NormalizationStages.pipe(Effect.provide(layer))
    const input = { documentId: claim.document.id, runId: claim.run.id }
    const { failure } = yield* stages.execute(claim, "extraction", input).pipe(Effect.flip)
    const { db, query } = yield* StorageDatabase
    expect(yield* query("attempts", () => db.selectFrom("provider_attempts").selectAll().execute())).toEqual([])
    return yield* inspect(failure, claim)
  }).pipe(Effect.provide(makeDocumentStoreLayer({ dataDirectory, queueLimit: 5 })))
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe("local processing failures", () => {
  it.live("classifies a failed private file write as a retryable storage failure", () => failedExtraction(
    policy, configuration, 1, (failure, claim) => Effect.gen(function* () {
      expect(failure).toEqual({
        code: "storage-failed", message: "A private processing file could not be read or written", retryable: true,
        stage: "extraction", pageId: null, figureId: null,
      })
      const finishedAt = DateTime.formatIso(yield* DateTime.now)
      yield* (yield* DocumentStore).updateRun(claim, { _tag: "failed", finishedAt, failure })
      const retry = yield* (yield* makeRunRecovery(policy, 5)).requestRetry({
        ownerId: owner, documentId: claim.document.id, previousRunId: claim.run.id,
        idempotencyKey: IdempotencyKey.make("retry-after-disk-full"), acknowledgesUnknownCompletion: false,
      })
      expect(retry.runId).not.toBe(claim.run.id)
    }),
  ))
})

describe("extraction page allowance", () => {
  const reservations = { extraction: 300_000, "page-check": 300_000, headings: 500_000, figures: 500_000 }
  const shipped: GuardPolicy = { ...policy, maximumCostMicrousd: { ...reservations, guide: 500_000 } }
  const guided = { ...configuration, guide: model("guide"), spendingCapUsd: 30 }
  const limit = affordablePageLimit(shipped, Schema.decodeUnknownSync(RunConfiguration)(guided))

  it("allows 48 pages under the $30 cap", () => expect(limit).toBe(48))
  it.live("starts extracting at the affordable limit", () => failedExtraction(
    shipped, guided, limit, (failure) => Effect.sync(() => expect(failure.code).toBe("storage-failed")),
  ))
  it.live("refuses one page more before rendering", () => failedExtraction(
    shipped, guided, limit + 1, (failure) => Effect.sync(() => expect(failure).toMatchObject({
      code: "limit-exceeded", retryable: false,
      message: "This document exceeds its reserved processing allowance before figure descriptions",
    })),
  ))
})
