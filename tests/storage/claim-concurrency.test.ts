import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { sql } from "kysely"
import { IdempotencyKey } from "../../src/domain/index.ts"
import { DocumentStore, StorageDatabase, makeDocumentStoreLayer } from "../../src/storage/index.ts"
import { admission, options } from "../fixtures/speed.ts"

it.effect("migrates the global index and claims at most two owners, including recovery", () => Effect.gen(function* () {
  const settings = yield* options
  const admitted = yield* Effect.gen(function* () {
    const store = yield* DocumentStore
    const accepted = yield* Effect.forEach(["owner-a", "owner-b", "owner-c"], (owner) => admission(owner).pipe(Effect.flatMap(store.admit)))
    const { db, query } = yield* StorageDatabase
    yield* query("old-index", () => sql`CREATE UNIQUE INDEX IF NOT EXISTS one_running_run_globally ON runs((1)) WHERE state='running'`.execute(db))
    return accepted
  }).pipe(Effect.provide(makeDocumentStoreLayer(settings)))
  yield* Effect.gen(function* () {
    const store = yield* DocumentStore
    const claims = yield* Effect.forEach([1, 2, 3], (worker) => store.claimNext({ workerId: `worker-${worker}`, leaseMilliseconds: 100 }), { concurrency: 3 })
    const running = claims.filter((claim) => claim !== null)
    expect(running).toHaveLength(2)
    expect(new Set(running.map((claim) => claim.document.ownerId)).size).toBe(2)
    expect(running.every((claim) => admitted.some((entry) => entry.runId === claim.run.id))).toBe(true)
    const duplicate = { ...(yield* admission(running[0]!.document.ownerId)), idempotencyKey: yield* Schema.decodeUnknownEffect(IdempotencyKey)("another-upload") }
    expect((yield* store.admit(duplicate).pipe(Effect.result))._tag).toBe("Failure")
    yield* TestClock.adjust("101 millis")
    const recovered = yield* Effect.forEach([1, 2, 3], (worker) => store.claimNext({ workerId: `recovery-${worker}`, leaseMilliseconds: 100 }), { concurrency: 3 })
    expect(recovered.filter((claim) => claim !== null).map((claim) => claim.run.id).toSorted()).toEqual(running.map((claim) => claim.run.id).toSorted())
    expect(recovered.filter((claim) => claim !== null).every((claim) => claim.recovered)).toBe(true)
    const { db, query } = yield* StorageDatabase
    expect(yield* query("documents", () => db.selectFrom("documents").select("id").execute())).toHaveLength(3)
    expect((yield* query("indexes", () => sql<{ name: string }>`PRAGMA index_list(runs)`.execute(db))).rows.some((row) => row.name === "one_running_run_globally")).toBe(false)
  }).pipe(Effect.provide(makeDocumentStoreLayer(settings)))
}).pipe(Effect.provide(NodeServices.layer)))
