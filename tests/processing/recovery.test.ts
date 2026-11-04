import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, FileSystem, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { decodeMetaOutput } from "../../src/paper/providers/meta/index.ts"
import { AcceptedRun, UserId } from "../../src/domain/index.ts"
import { AttemptInput, ProviderAdapter, ProviderFailure, ProviderGuard, RetryRequest, RunRecovery, executionFailure, makeProviderGuardLayer, makeRunRecovery, makeRunRecoveryLayer, type GuardPolicy } from "../../src/processing/index.ts"
import { Admission, DocumentStore, StorageDatabase, makeDocumentStoreLayer, type DispatchClaim, type StorageOptions } from "../../src/storage/index.ts"

const policy: GuardPolicy = { mode: "fixture", enabled: true, metaCredentialConfigured: false, mineruCredentialConfigured: false, mineruEndpoint: null, budgetId: "recovery-budget", authorizedBudgetMicrousd: 1_000_000, maximumCostMicrousd: { extraction: 100_000, "page-check": 100_000, headings: 100_000, figures: 100_000 }, maxConcurrentCalls: 1, maxOutputTokens: 1000, maxRequestBytes: 10_000, maxResponseBytes: 10_000, callDeadlineMilliseconds: 1000 }
const model = { provider: "fixture", model: "offline", reasoning: "high", promptName: "check", promptVersion: "1", maxOutputTokens: 1000 }
const options = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return { dataDirectory: yield* fs.makeTempDirectoryScoped(), queueLimit: 5 } satisfies StorageOptions
})
const layer = (settings: StorageOptions) => Layer.merge(makeProviderGuardLayer(policy), makeRunRecoveryLayer(policy, settings.queueLimit)).pipe(Layer.provideMerge(makeDocumentStoreLayer(settings)))
const input = (page = "page-1", stage: AttemptInput["stage"] = "page-check") => Schema.decodeUnknownEffect(AttemptInput)({ stage, pageIds: [page], figureId: null, inputHashes: ["a".repeat(64)], request: { page, text: "Retained text" }, supportsIdempotency: false, retry: { _tag: "none" } })
const admitted = Effect.fnUntraced(function* (extra: { readonly cap?: number; readonly attempts?: number; readonly mineru?: boolean; readonly lease?: number } = {}) {
  const store = yield* DocumentStore
  yield* store.admit(yield* Schema.decodeUnknownEffect(Admission)({ ownerId: "recovery-reader", idempotencyKey: "upload", originalFilename: "source.pdf", bytes: new TextEncoder().encode("%PDF-1.7 offline"), pageCount: 2, pipelineVersion: "1", configuration: { extractionProvider: extra.mineru ? "mineru" : "fixture", extractionVersion: "4.0.12", pageCheck: model, headings: model, figures: model, maxProviderAttempts: extra.attempts ?? 3, deadlineMilliseconds: 100_000, spendingCapUsd: extra.cap ?? 1 } }))
  return yield* next(extra.lease)
})
const next = Effect.fnUntraced(function* (lease = 10_000) {
  const store = yield* DocumentStore
  const claimed = yield* store.claimNext({ workerId: "recovery-worker", leaseMilliseconds: lease })
  if (claimed === null) return yield* Effect.die("Expected work")
  return claimed
})
const terminal = (code: "provider-failed" | "invalid-provider-response" = "provider-failed") => Effect.gen(function* () {
  return { _tag: "failed" as const, finishedAt: DateTime.formatIso(yield* DateTime.now), failure: { code, message: "Offline failure", retryable: code === "provider-failed", stage: null, pageId: null, figureId: null } }
})
const stop = Effect.fnUntraced(function* (claim: DispatchClaim, code: "provider-failed" | "invalid-provider-response" = "provider-failed") {
  yield* (yield* DocumentStore).updateRun(claim, yield* terminal(code))
  yield* TestClock.adjust(1001)
})
const retryRequest = (claim: DispatchClaim, acknowledge = true, key = "retry-one") => Schema.decodeUnknownEffect(RetryRequest)({ ownerId: claim.document.ownerId, documentId: claim.document.id, previousRunId: claim.run.id, idempotencyKey: key, acknowledgesUnknownCompletion: acknowledge })
const attempts = Effect.gen(function* () { const { db, query } = yield* StorageDatabase; return yield* query("test", () => db.selectFrom("provider_attempts").selectAll().execute()) })
const response = { response: { text: "Saved response" }, usage: { _tag: "unavailable" as const, reason: "Offline fixture" }, actualCostMicrousd: null }
const unknown = () => Effect.fail(new ProviderFailure({ certainty: "unknown", message: "Lost provider response" }))
const adapter = (invoke: ProviderAdapter["Service"]["invoke"] = () => Effect.succeed(response), validate: ProviderAdapter["Service"]["validate"] = () => Effect.void) => Layer.succeed(ProviderAdapter, { invoke, validate })

describe("durable recovery and retry authorization", () => {
  it.effect("bounds repeated local failures even when no provider attempt was prepared", () => Effect.gen(function* () {
    const settings = yield* options
    yield* Effect.gen(function* () {
      let current = yield* admitted({ attempts: 2 })
      const original = current
      const recovery = yield* RunRecovery
      const store = yield* DocumentStore
      const failLocal = (claim: DispatchClaim) => terminal().pipe(Effect.flatMap((state) => store.updateRun(claim, { ...state, failure: { ...state.failure, code: "storage-failed" } })))
      let firstRetry: typeof AcceptedRun.Type | undefined
      for (let index = 0; index < 2; index += 1) {
        yield* failLocal(current)
        const accepted = yield* recovery.requestRetry(yield* retryRequest(current, false, `local-retry-${index}`))
        if (index === 0) firstRetry = accepted
        current = yield* next()
      }
      yield* failLocal(current)
      expect(yield* Effect.result(recovery.requestRetry(yield* retryRequest(current, false, "local-retry-2")))).toMatchObject({ _tag: "Failure", failure: { code: "limit-exceeded" } })
      expect(yield* recovery.requestRetry(yield* retryRequest(original, false, "local-retry-0"))).toEqual(firstRetry)
      expect(yield* attempts).toEqual([])
      const { db, query } = yield* StorageDatabase
      expect(yield* query("test", () => db.selectFrom("runs").select("id").execute())).toHaveLength(3)
      expect(yield* query("test", () => db.selectFrom("retry_requests").select("id").execute())).toHaveLength(2)
    }).pipe(Effect.provide(layer(settings)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("atomically deduplicates acknowledged retry requests and consumes one exact grant", () => Effect.gen(function* () {
    const settings = yield* options
    let calls = 0
    yield* Effect.gen(function* () {
      const first = yield* admitted()
      const guard = yield* ProviderGuard
      const recovery = yield* RunRecovery
      const request = yield* input()
      yield* Effect.result(guard.execute(first, request))
      yield* stop(first)
      expect(yield* Effect.result(recovery.requestRetry(yield* retryRequest(first, false)))).toMatchObject({ _tag: "Failure", failure: { code: "provider-unknown-completion" } })
      const retry = yield* retryRequest(first)
      const accepted = yield* Effect.all(Array.from({ length: 6 }, () => recovery.requestRetry(retry)), { concurrency: "unbounded" })
      expect(new Set(accepted.map((item) => item.runId)).size).toBe(1)
      expect(yield* Effect.result(recovery.requestRetry(yield* retryRequest(first, true, "different-key")))).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
      const second = yield* next()
      expect(second.run.configuration).toEqual(first.run.configuration)
      expect(second.run.mastraRunId).not.toBe(first.run.mastraRunId)
      expect((yield* guard.retryInput(second, request)).retry._tag).toBe("authorized")
      const changed = { ...request, request: { changed: true } }
      expect(yield* Effect.result(guard.execute(second, changed))).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
      expect((yield* guard.execute(second, request)).delivery).toBe("performed")
      expect((yield* guard.execute(second, request)).delivery).toBe("reused")
      const { db, query } = yield* StorageDatabase
      const grants = yield* query("test", () => db.selectFrom("retry_authorizations").selectAll().execute())
      expect(grants).toHaveLength(1)
      expect(grants[0]?.consumed_attempt_id).toBe((yield* attempts)[1]?.id)
      const charges = yield* query("test", () => db.selectFrom("provider_charges").selectAll().execute())
      expect(charges).toHaveLength(2)
      expect(charges.every((charge) => charge.budget_id === policy.budgetId && charge.actual_microusd === null)).toBe(true)
      expect(calls).toBe(2)
    }).pipe(Effect.provide(Layer.merge(layer(settings), adapter(() => Effect.suspend(() => ++calls === 1 ? unknown() : Effect.succeed(response))))))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("reopens page receipts and adopts only the undispatched prepared page with a fresh claim", () => Effect.gen(function* () {
    const settings = yield* options
    let calls = 0
    const provider = adapter(() => Effect.sync(() => { calls += 1; return response }))
    const before = yield* Effect.gen(function* () {
      const first = yield* admitted({ lease: 100 })
      const guard = yield* ProviderGuard
      yield* guard.execute(first, yield* input("page-1"))
      const prepared = yield* guard.prepare(first, yield* input("page-2"))
      if (prepared._tag !== "prepared") return yield* Effect.die("Expected prepared page")
      return { first, prepared }
    }).pipe(Effect.provide(Layer.merge(layer(settings), provider)))
    yield* TestClock.adjust(1001)
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const guard = yield* ProviderGuard
      yield* guard.reconcile()
      expect(yield* store.recoverExpiredClaims()).toBe(0)
      const current = yield* next()
      expect(current.recovered).toBe(true)
      expect(current.run).toEqual(before.first.run)
      expect(current.claimToken).not.toBe(before.first.claimToken)
      expect(yield* Effect.result(store.updateRun(before.first, yield* terminal()))).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
      expect(yield* Effect.result(guard.dispatch(before.prepared.ticket))).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
      expect((yield* guard.execute(current, yield* input("page-1"))).delivery).toBe("reused")
      const completed = yield* guard.execute(current, yield* input("page-2"))
      expect(completed.receipt.id).toBe(before.prepared.ticket.receipt.id)
      expect(completed.delivery).toBe("performed")
      expect(yield* attempts).toHaveLength(2)
      expect(calls).toBe(2)
    }).pipe(Effect.provide(Layer.merge(layer(settings), provider)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("interrupts expired unknown model work and never automatically claims it", () => Effect.gen(function* () {
    const settings = yield* options
    yield* Effect.gen(function* () {
      const first = yield* admitted({ lease: 100 })
      yield* Effect.result((yield* ProviderGuard).execute(first, yield* input()))
      yield* TestClock.adjust(1001)
      const store = yield* DocumentStore
      expect(yield* store.recoverExpiredClaims()).toBe(1)
      expect(yield* store.claimNext({ workerId: "replacement", leaseMilliseconds: 1000 })).toBeNull()
      expect((yield* store.status(first.document.ownerId, first.document.id)).state).toMatchObject({ _tag: "interrupted", failure: { code: "provider-unknown-completion" } })
      expect((yield* attempts)[0]?.actual_microusd).toBeNull()
    }).pipe(Effect.provide(Layer.merge(layer(settings), adapter(unknown))))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("fences a late old-worker callback immediately after MinerU claim recovery", () => Effect.gen(function* () {
    const settings = yield* options
    let late: Parameters<ProviderAdapter["Service"]["invoke"]>[0]["submitted"] | undefined
    let retrieved = 0
    yield* Effect.gen(function* () {
      const first = yield* admitted({ mineru: true, lease: 100 })
      const guard = yield* ProviderGuard
      const request = yield* input("page-1", "extraction")
      yield* Effect.result(guard.execute(first, request))
      const original = (yield* attempts)[0]
      yield* TestClock.adjust(1001)
      const current = yield* next()
      expect(current.recovered).toBe(true)
      if (late === undefined || original === undefined) return yield* Effect.die("Expected saved submission")
      expect(yield* Effect.result(late(original.id))).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
      expect((yield* guard.execute(current, request)).receipt.id).toBe(original.id)
      expect(retrieved).toBe(1)
      expect(yield* attempts).toHaveLength(1)
    }).pipe(Effect.provide(Layer.merge(layer(settings), Layer.succeed(ProviderAdapter, {
      invoke: (call) => Effect.gen(function* () { late = call.submitted; yield* call.submitted(call.attemptId); return yield* unknown() }),
      retrieve: () => Effect.sync(() => { retrieved += 1; return response }), validate: () => Effect.void,
    }))))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("limits provider attempts across distinct acknowledged retry runs", () => Effect.gen(function* () {
    const settings = yield* options
    yield* Effect.gen(function* () {
      const first = yield* admitted({ attempts: 2 })
      const guard = yield* ProviderGuard
      const recovery = yield* RunRecovery
      yield* Effect.result(guard.execute(first, yield* input()))
      yield* stop(first)
      yield* recovery.requestRetry(yield* retryRequest(first))
      const second = yield* next()
      yield* Effect.result(guard.execute(second, yield* input()))
      yield* stop(second)
      expect(yield* Effect.result(recovery.requestRetry(yield* retryRequest(second, true, "retry-two")))).toMatchObject({ _tag: "Failure", failure: { code: "limit-exceeded" } })
      expect(yield* attempts).toHaveLength(2)
    }).pipe(Effect.provide(Layer.merge(layer(settings), adapter(unknown))))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("adopts an authorized retry prepared before a host crash without consuming a second grant", () => Effect.gen(function* () {
    const settings = yield* options
    let calls = 0
    const provider = adapter(() => Effect.suspend(() => ++calls === 1 ? unknown() : Effect.succeed(response)))
    const originalId = yield* Effect.gen(function* () {
      const first = yield* admitted()
      const guard = yield* ProviderGuard
      yield* Effect.result(guard.execute(first, yield* input()))
      yield* stop(first)
      yield* (yield* RunRecovery).requestRetry(yield* retryRequest(first))
      const second = yield* next(100)
      const prepared = yield* guard.prepare(second, yield* input())
      if (prepared._tag !== "prepared") return yield* Effect.die("Expected authorized prepared retry")
      return prepared.ticket.receipt.id
    }).pipe(Effect.provide(Layer.merge(layer(settings), provider)))
    yield* TestClock.adjust(1001)
    yield* Effect.gen(function* () {
      const current = yield* next()
      expect(current.recovered).toBe(true)
      const completed = yield* (yield* ProviderGuard).execute(current, yield* input())
      expect(completed.receipt.id).toBe(originalId)
      expect(yield* attempts).toHaveLength(2)
      expect(calls).toBe(2)
    }).pipe(Effect.provide(Layer.merge(layer(settings), provider)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("can authorize a later retry run when a prior grant never reached attempt preparation", () => Effect.gen(function* () {
    const settings = yield* options
    yield* Effect.gen(function* () {
      const first = yield* admitted()
      const guard = yield* ProviderGuard
      const recovery = yield* RunRecovery
      yield* Effect.result(guard.execute(first, yield* input()))
      yield* stop(first)
      yield* recovery.requestRetry(yield* retryRequest(first))
      const second = yield* next()
      yield* stop(second)
      yield* recovery.requestRetry(yield* retryRequest(second, true, "retry-two"))
      const third = yield* next()
      expect((yield* guard.prepare(third, yield* input()))._tag).toBe("prepared")
      expect(yield* attempts).toHaveLength(2)
      expect(yield* Effect.result(guard.prepare(second, yield* input()))).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
    }).pipe(Effect.provide(Layer.merge(layer(settings), adapter(unknown))))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("includes reported earlier-run charges when checking a transient retry budget", () => Effect.gen(function* () {
    const settings = yield* options
    yield* Effect.gen(function* () {
      const first = yield* admitted({ cap: 0.15 })
      yield* Effect.result((yield* ProviderGuard).execute(first, yield* input()))
      yield* stop(first)
      expect((yield* attempts)[0]?.actual_microusd).toBe(70_000)
      expect(yield* Effect.result((yield* RunRecovery).requestRetry(yield* retryRequest(first, false)))).toMatchObject({ _tag: "Failure", failure: { code: "limit-exceeded" } })
    }).pipe(Effect.provide(Layer.merge(layer(settings), adapter(() => Effect.succeed({ ...response, actualCostMicrousd: 70_000, response: { format: "amuseme-meta-wire-v1", status: 503, complete: true, bodyBase64: "e30=", requestId: null } }), () => Effect.fail(executionFailure("invalid-provider-response", "Unavailable response"))))))
  }).pipe(Effect.provide(NodeServices.layer)))

  for (const kind of ["attempts", "budget", "policy"] as const) {
    it.effect(`retains the original ${kind} allowance across the retry chain`, () => Effect.gen(function* () {
      const settings = yield* options
      yield* Effect.gen(function* () {
        const first = yield* admitted({ attempts: kind === "attempts" ? 1 : 3, cap: kind === "budget" ? 0.15 : 1 })
        yield* Effect.result((yield* ProviderGuard).execute(first, yield* input()))
        yield* stop(first)
        const recovery = kind === "policy" ? yield* makeRunRecovery({ ...policy, budgetId: "different-budget" }, 5) : yield* RunRecovery
        expect(yield* Effect.result(recovery.requestRetry(yield* retryRequest(first)))).toMatchObject({ _tag: "Failure", failure: { code: kind === "policy" ? "conflict" : "limit-exceeded" } })
        expect(yield* attempts).toHaveLength(1)
        const { db, query } = yield* StorageDatabase
        expect(yield* query("test", () => db.selectFrom("retry_requests").selectAll().execute())).toHaveLength(0)
      }).pipe(Effect.provide(Layer.merge(layer(settings), adapter(unknown))))
    }).pipe(Effect.provide(NodeServices.layer)))
  }

  for (const status of [200, 429, 503]) {
    it.effect(`allows only explicit transient retry after a complete HTTP ${status} response`, () => Effect.gen(function* () {
      const settings = yield* options
      yield* Effect.gen(function* () {
        const first = yield* admitted()
        yield* Effect.result((yield* ProviderGuard).execute(first, yield* input()))
        expect((yield* attempts)[0]?.validation_state).toBe(status === 200 ? "rejected" : "pending")
        yield* stop(first, status === 200 ? "invalid-provider-response" : "provider-failed")
        const outcome = yield* Effect.result((yield* RunRecovery).requestRetry(yield* retryRequest(first, false)))
        expect(outcome._tag).toBe(status === 200 ? "Failure" : "Success")
        if (status === 200) expect(outcome).toMatchObject({ failure: { code: "invalid-provider-response" } })
      }).pipe(Effect.provide(Layer.merge(layer(settings), adapter(() => Effect.succeed({ ...response, response: { format: "amuseme-meta-wire-v1", status, complete: true, bodyBase64: "e30=", requestId: null } }), (value) => decodeMetaOutput(value).pipe(Effect.asVoid)))))
    }).pipe(Effect.provide(NodeServices.layer)))
  }

  it.effect("reuses accepted receipts after local packaging failure without another provider charge", () => Effect.gen(function* () {
    const settings = yield* options
    let calls = 0
    yield* Effect.gen(function* () {
      const first = yield* admitted()
      const guard = yield* ProviderGuard
      const saved = yield* guard.execute(first, yield* input())
      yield* stop(first)
      const recovery = yield* RunRecovery
      const request = yield* retryRequest(first, false)
      expect(yield* Effect.result(recovery.requestRetry({ ...request, ownerId: UserId.make("someone-else") }))).toMatchObject({ _tag: "Failure" })
      yield* recovery.requestRetry(request)
      const current = yield* next()
      expect((yield* guard.execute(current, yield* input())).receipt).toEqual(saved.receipt)
      expect(calls).toBe(1)
      expect(yield* attempts).toHaveLength(1)
      const { db, query } = yield* StorageDatabase
      expect(yield* query("test", () => db.selectFrom("retry_authorizations").selectAll().execute())).toHaveLength(0)
    }).pipe(Effect.provide(Layer.merge(layer(settings), adapter(() => Effect.sync(() => { calls += 1; return response })))))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("leaves historical policy unknown while allowing existing accepted response replay", () => Effect.gen(function* () {
    const settings = yield* options
    yield* Effect.gen(function* () {
      const first = yield* admitted()
      const guard = yield* ProviderGuard
      yield* guard.execute(first, yield* input())
      const { db, query } = yield* StorageDatabase
      yield* query("test", () => db.deleteFrom("document_policies").execute())
      expect((yield* guard.execute(first, yield* input())).delivery).toBe("reused")
      expect(yield* Effect.result(guard.execute(first, yield* input("page-2")))).toMatchObject({ _tag: "Failure", failure: { code: "processing-unavailable" } })
      expect(yield* query("test", () => db.selectFrom("document_policies").selectAll().execute())).toEqual([])
    }).pipe(Effect.provide(Layer.merge(layer(settings), adapter())))
  }).pipe(Effect.provide(NodeServices.layer)))

  for (const operation of ["delete", "expire"] as const) {
    it.effect(`captures MinerU attempt UUIDs before ${operation}, including absent remote IDs`, () => Effect.gen(function* () {
      const settings = { ...(yield* options), retentionMilliseconds: 2000 }
      yield* Effect.gen(function* () {
        const first = yield* admitted({ mineru: true })
        yield* (yield* ProviderGuard).prepare(first, yield* input("page-1", "extraction"))
        const original = (yield* attempts)[0]
        expect(original?.remote_id).toBeNull()
        const store = yield* DocumentStore
        if (operation === "delete") { yield* stop(first); yield* store.delete(first.document.ownerId, first.document.id) }
        else { yield* TestClock.adjust(2001); yield* store.reconcile() }
        expect(yield* attempts).toHaveLength(0)
        const { db, query } = yield* StorageDatabase
        const cleanup = yield* query("test", () => db.selectFrom("remote_cleanup").selectAll().execute())
        expect(cleanup).toHaveLength(1)
        expect(cleanup[0]).toMatchObject({ job_id: original?.id, document_id: first.document.id })
        expect(yield* query("test", () => db.selectFrom("provider_charges").selectAll().execute())).toHaveLength(1)
      }).pipe(Effect.provide(layer(settings)))
    }).pipe(Effect.provide(NodeServices.layer)))
  }
})
