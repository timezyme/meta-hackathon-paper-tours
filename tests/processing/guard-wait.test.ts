import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { AttemptInput, ProviderAdapter, makeProviderGuard } from "../../src/processing/index.ts"
import { DocumentStore, StorageDatabase, makeDocumentStoreLayer } from "../../src/storage/index.ts"
import { admission, options, policy } from "../fixtures/speed.ts"

it.live("waits for an occupied provider slot without failing or reserving twice", () => Effect.gen(function* () {
  const settings = yield* options
  yield* Effect.gen(function* () {
    const store = yield* DocumentStore
    yield* store.admit(yield* admission())
    const claim = yield* store.claimNext({ workerId: "speed", leaseMilliseconds: 10000 })
    if (claim === null) return yield* Effect.die("Expected claim")
    const guard = yield* makeProviderGuard({ ...policy, maxConcurrentCalls: 1 })
    let active = 0
    let peak = 0
    const provider = ProviderAdapter.of({
      invoke: () => Effect.gen(function* () {
        active += 1; peak = Math.max(peak, active)
        yield* Effect.sleep("15 millis")
        active -= 1
        return { response: {}, usage: { _tag: "unavailable" as const, reason: "fixture" }, actualCostMicrousd: null }
      }),
      validate: () => Effect.void,
    })
    const results = yield* Effect.forEach(["page-1", "page-2"], (pageId) => Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(AttemptInput)({ stage: "page-check", pageIds: [pageId], figureId: null, inputHashes: [claim.document.sourceHash], request: { pageId }, supportsIdempotency: false, retry: { _tag: "none" } })
      return yield* guard.execute(claim, input)
    }), { concurrency: 2 }).pipe(Effect.provideService(ProviderAdapter, provider))
    expect(peak).toBe(1)
    expect(results.map((result) => result.receipt.state._tag)).toEqual(["completed", "completed"])
    const { db, query } = yield* StorageDatabase
    expect(yield* query("charges", () => db.selectFrom("provider_charges").selectAll().execute())).toHaveLength(2)
  }).pipe(Effect.provide(makeDocumentStoreLayer(settings)))
}).pipe(Effect.provide(NodeServices.layer)))
