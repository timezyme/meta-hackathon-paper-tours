import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Deferred, Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { RunConfiguration } from "../../src/domain/index.ts"
import { stageSpecs } from "../../src/paper/correction/index.ts"
import { PdfRenderer } from "../../src/paper/pdf/index.ts"
import { makeMetaAgentBoundary, MetaRequest } from "../../src/paper/providers/meta/index.ts"
import { countEndpoint } from "../../src/paper/providers/meta/transport.ts"
import { makeProviderGuard, ProviderGuard } from "../../src/processing/index.ts"
import { Extracted } from "../../src/processing/checkpoints.ts"
import { ExtractedData, NormalizationStages } from "../../src/processing/pipeline.ts"
import { ArtifactStore, DocumentStore, OutputStore, StorageDatabase, makeArtifactStore, makeDocumentStoreLayer, makeOutputStore } from "../../src/storage/index.ts"
import { admission, options, policy } from "../fixtures/speed.ts"

const model = (stage: keyof typeof stageSpecs) => ({ provider: "meta", model: "muse-spark-1.3", reasoning: "high", promptName: stageSpecs[stage].promptName, promptVersion: stageSpecs[stage].promptVersion, maxOutputTokens: 1000 })
const contextSchema = Schema.Union([Schema.Struct({ pageNumber: Schema.Number }), Schema.Struct({ figureCropReview: Schema.Struct({ page: Schema.Struct({ pageNumber: Schema.Number }) }) })])

it.live("overlaps extraction without changing serial receipts, retries, crop decisions or reservations", () => Effect.gen(function* () {
  const settings = yield* options
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const seed = path.join(settings.dataDirectory, "seed")
  yield* Effect.gen(function* () {
    const store = yield* DocumentStore
    const original = yield* admission()
    const configuration = yield* Schema.decodeUnknownEffect(RunConfiguration)({ ...original.configuration, spendingCapUsd: 0.000009, extractionProvider: "meta", extractionVersion: "muse-spark-1.3", extractionModel: model("extraction"), pageCheck: model("page-check"), headings: model("headings"), figures: model("figures") })
    yield* store.admit({ ...original, pageCount: 3, configuration })
  }).pipe(Effect.provide(makeDocumentStoreLayer({ ...settings, dataDirectory: seed })))
  const outcomes = yield* Effect.forEach([1, 4], (maxConcurrentCalls) => Effect.gen(function* () {
    const dataDirectory = path.join(settings.dataDirectory, String(maxConcurrentCalls))
    yield* fs.copy(seed, dataDirectory)
    return yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const claim = yield* store.claimNext({ workerId: "speed", leaseMilliseconds: 10000 })
      if (claim === null) return yield* Effect.die("Expected claim")
      const artifacts = yield* makeArtifactStore(dataDirectory)
      const outputs = yield* makeOutputStore().pipe(Effect.provideService(ArtifactStore, artifacts))
      const limits = { ...policy, maxConcurrentCalls }
      const guard = yield* makeProviderGuard(limits)
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
      const image = yield* artifacts.put(claim.document.ownerId, claim.document.id, bytes)
      const firstCropReviewed = yield* Deferred.make<void>()
      const renderer = PdfRenderer.of({
        render: ({ outputDirectory }) => Effect.forEach([1, 2, 3], (pageNumber) => Effect.gen(function* () {
          const name = `page-${pageNumber}.png`
          yield* fs.writeFile(path.join(outputDirectory, name), bytes).pipe(Effect.orDie)
          return { pageNumber, width: 100, height: 100, dpi: 72, widthPoints: 100, heightPoints: 100, physicalRotation: 0 as const, image: { ...image, path: name, mediaType: "image/png" as const } }
        })),
        crop: ({ outputPath, box }) => (box.x > 0 ? Deferred.await(firstCropReviewed) : Effect.void).pipe(
          Effect.andThen(fs.writeFile(outputPath, bytes)), Effect.orDie, Effect.as({ ...image, width: box.width, height: box.height })),
      })
      let active = 0
      let peak = 0
      let counts = 0
      const overlapping = yield* Deferred.make<void>()
      const othersFinished = yield* Deferred.make<void>()
      const finished: Array<number> = []
      const http = HttpClient.make((request, url) => Effect.gen(function* () {
        if (url.href === countEndpoint) {
          counts += 1
          return HttpClientResponse.fromWeb(request, Response.json({ object: "response.input_tokens", input_tokens: 10 }))
        }
        if (request.body._tag !== "Uint8Array") return yield* Effect.die("Expected request body")
        const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MetaRequest))(new TextDecoder().decode(request.body.body))
        const text = body.messages[1].content.find((part) => part.type === "text")
        if (text?.type !== "text") return yield* Effect.die("Expected page context")
        const context = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(contextSchema))(text.text)
        const pageNumber = "pageNumber" in context ? context.pageNumber : context.figureCropReview.page.pageNumber
        const name = body.response_format.json_schema.name
        if ("figureCropReview" in context) yield* Deferred.succeed(firstCropReviewed, undefined)
        const initial = name === "page-extraction"
        if (initial) {
          active += 1; peak = Math.max(peak, active)
          if (active === 3) yield* Deferred.succeed(overlapping, undefined)
          if (maxConcurrentCalls > 1) yield* Deferred.await(overlapping)
          if (maxConcurrentCalls > 1 && pageNumber === 1) yield* Deferred.await(othersFinished)
          active -= 1; finished.push(pageNumber)
          if (finished.length === 2) yield* Deferred.succeed(othersFinished, undefined)
        }
        const figures = pageNumber === 3 ? [] : Array.from({ length: pageNumber === 1 ? 2 : 1 }, (_, blockIndex) => ({ blockIndex, captionBlockIndices: [], box: { x: blockIndex * 40, y: 0, width: 30, height: 30 } }))
        const result = "figureCropReview" in context ? { verdict: "confirmed", box: null } : {
          pageNumber, coverage: pageNumber === 1 && initial ? "incomplete" : "complete", blank: false, figures,
          blocks: figures.length === 0 ? [{ kind: "paragraph", content: `Page ${pageNumber}`, format: "text", furniture: null }]
            : figures.map(({ blockIndex }) => ({ kind: "figure", content: `Figure ${pageNumber}.${blockIndex}`, format: "text", furniture: null })),
        }
        return HttpClientResponse.fromWeb(request, Response.json({ id: `fake-${name}-${pageNumber}`, model: "muse-spark-1.3", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(result) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }))
      }).pipe(Effect.orDie))
      const meta = makeMetaAgentBoundary(stageSpecs)
      const metered = { ...meta, makeAdapter: (config: Parameters<typeof meta.makeAdapter>[0]) => meta.makeAdapter(config).pipe(Effect.map((adapter) => ({ ...adapter,
        invoke: (call: Parameters<typeof adapter.invoke>[0]) => adapter.invoke(call).pipe(Effect.map((response) => ({ ...response, actualCostMicrousd: call.receipt.stage === "extraction" && call.receipt.pageIds[0] === "page-2" ? 0 : null }))),
      }))) }
      const stages = yield* NormalizationStages.pipe(Effect.provide(NormalizationStages.layer(metered, { policy: limits, temporaryDirectory: path.join(dataDirectory, "processing"), metaCredential: Redacted.make("fake") }).pipe(Layer.provide(Layer.mergeAll(
        Layer.succeed(ArtifactStore, artifacts), Layer.succeed(OutputStore, outputs), Layer.succeed(ProviderGuard, guard), Layer.succeed(PdfRenderer, renderer), Layer.succeed(HttpClient.HttpClient, http),
      )))))
      const input = { documentId: claim.document.id, runId: claim.run.id }
      const checkpoint = yield* stages.execute(claim, "extraction", input).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Extracted)))
      const saved = yield* artifacts.read(claim.document.ownerId, claim.document.id, checkpoint.extraction)
      const data = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ExtractedData))(new TextDecoder().decode(saved))
      const { db, query } = yield* StorageDatabase
      const attempts = yield* query("attempts", () => db.selectFrom("provider_attempts").selectAll().execute())
      const ids = new Map(attempts.map((row) => [row.id, row.fingerprint]))
      const stable = (value: unknown) => JSON.stringify(value, (key, field: unknown) => ["preparedAt", "finishedAt", "durationMilliseconds", "deadlineAt"].includes(key) ? undefined : typeof field === "string" ? ids.get(field) ?? field : field)
      expect(peak).toBe(maxConcurrentCalls === 1 ? 1 : 3)
      expect(finished.at(-1)).toBe(maxConcurrentCalls === 1 ? 3 : 1)
      expect(data.cropReviews?.map((review) => review.outcome)).toEqual(["confirmed", "not-reviewed", "confirmed"])
      expect(data.reviews?.map((review) => review.outcome)).toEqual(["corrected"])
      expect(data.receipts.map((receipt) => receipt.pageIds)).toEqual([["page-1"], ["page-2"], ["page-3"]])
      expect(attempts).toHaveLength(6)
      expect(attempts.every((row) => row.reserved_microusd === 1)).toBe(true)
      expect(attempts.reduce((sum, row) => sum + (row.actual_microusd ?? row.reserved_microusd), 0)).toBe(5)
      expect(yield* stages.execute(claim, "extraction", input)).toEqual(checkpoint)
      return { data: stable(data), counts, attempts: attempts.map((row) => stable({ fingerprint: row.fingerprint, intent: JSON.parse(row.intent_json), reserved: row.reserved_microusd, actual: row.actual_microusd })).toSorted() }
    }).pipe(Effect.provide(makeDocumentStoreLayer({ ...settings, dataDirectory })))
  }))
  expect(outcomes[1]).toEqual(outcomes[0])
}).pipe(Effect.provide(NodeServices.layer)))
