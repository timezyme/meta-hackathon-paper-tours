import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Document, Run, StageReceipt } from "../../src/domain/index.ts"
import { AttemptInput, GuardPolicy } from "../../src/processing/contracts.ts"
import { requestFingerprint } from "../../src/processing/fingerprint.ts"

const { ownerId, pipelineVersion, schemaVersion } = Run.fields
const { maxResponseBytes, callDeadlineMilliseconds } = GuardPolicy.fields
const Fixture = Schema.Struct({
  run: Schema.Struct({ ownerId, pipelineVersion, schemaVersion }),
  document: Schema.Struct({ id: Document.fields.id, sourceHash: Document.fields.sourceHash }),
  unit: AttemptInput,
  configuration: StageReceipt.fields.configuration,
  policy: Schema.Struct({ maxResponseBytes, callDeadlineMilliseconds }),
})
const sha = (character: string) => character.repeat(64)
const model = (promptName: string, promptVersion: string, reasoning = "high") =>
  ({ provider: "meta", model: "muse-spark-1.3", reasoning, promptName, promptVersion, maxOutputTokens: 16384 })
const stageModel = (promptName: string, promptVersion: string, reasoning?: string) =>
  ({ _tag: "model", ...model(promptName, promptVersion, reasoning) })
const run = { ownerId: "reader-1", pipelineVersion: "amuseme-meta-3", schemaVersion: "1" }
const document = { id: "document-1", sourceHash: sha("a") }
const policy = { maxResponseBytes: 2 * 1024 * 1024, callDeadlineMilliseconds: 1_500_000 }
const unit = (fields: object, request: Schema.Json, supportsIdempotency = false) =>
  ({ ...fields, request, supportsIdempotency, retry: { _tag: "none" } })

// Each digest was computed by both the guard (guard.ts:34) and validator repair (validator-repair.ts:57) at 76f7d43.
const fixtures = [
  {
    name: "page check", expected: "c43cf304789baf0b5b8639c987b88a43fcece2ee85ea3c9a3242dc1a9ec405e6",
    run, document, policy, configuration: stageModel("page-check", "amuseme-4"),
    unit: unit(
      { stage: "page-check", pageIds: ["page-2"], figureId: null, inputHashes: [sha("b"), sha("c")] },
      { text: "Retained François α", nested: { z: 1, a: [true, null, 2.5] } },
    ),
  },
  {
    name: "figure crop", expected: "d42086bc01ee54a62b4cda32e182edb4d6239088c636ac2053bf4deacc8ab568",
    run, document, policy, configuration: stageModel("figures", "amuseme-2"),
    unit: unit(
      { stage: "figures", task: "figure-crop", pageIds: ["page-1"], figureId: "figure-page-1-block-3",
        inputHashes: [sha("d"), sha("e")] },
      { messages: [{ role: "system", content: "Check the crop" }], round: 1 }, true,
    ),
  },
  {
    name: "extraction", expected: "dcc99a6aabbe29e99760ab95a5de2bd422bb30f230b50c60060e45e9acf76ad7",
    run, document, policy,
    configuration: {
      _tag: "extraction", provider: "meta", version: "muse-spark-1.3", model: model("page-extraction", "amuseme-3"),
    },
    unit: unit(
      { stage: "extraction", pageIds: ["page-3"], figureId: null, inputHashes: [sha("f")] },
      { image: "data:image/png;base64,AAAA", pageNumber: 3 },
    ),
  },
  {
    name: "unsorted headings", expected: "c956eb047d27e198c241d3eabe1a1b346ca020cd735bb81a7574c6e61fb37d96",
    run: { ...run, ownerId: "reader-2" }, document: { id: "document-2", sourceHash: sha("0") },
    policy: { maxResponseBytes: 10_000, callDeadlineMilliseconds: 1000 },
    configuration: stageModel("headings", "amuseme-2", "medium"),
    unit: unit(
      { stage: "headings", pageIds: ["page-2", "page-1"], figureId: null, inputHashes: [sha("1")] }, { candidates: [] },
    ),
  },
]

describe("request fingerprints", () => {
  for (const { name, expected, ...raw } of fixtures) {
    it.effect(`keeps the ${name} fingerprint`, () => Effect.gen(function* () {
      const fixture = yield* Schema.decodeUnknownEffect(Fixture)(raw)
      const { request, supportsIdempotency } = fixture.unit
      expect(yield* requestFingerprint({ ...fixture, request, supportsIdempotency })).toBe(expected)
    }).pipe(Effect.provide(NodeServices.layer)))
  }
})
