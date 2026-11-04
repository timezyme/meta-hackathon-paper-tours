import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Clock, DateTime, Deferred, Effect, Fiber, FileSystem, Layer, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { Admission, DocumentStore, StorageDatabase, makeDocumentStoreLayer, type DispatchClaim, type StorageOptions } from "../../src/storage/index.ts"
import { AttemptInput, ProviderAdapter, ProviderFailure, ProviderGuard, RunDispatcher, RunStarter, executionFailure, makeProviderGuard, makeProviderGuardLayer, makeRunRecovery, makeRunDispatcherLayer, processingAvailability, type GuardPolicy } from "../../src/processing/index.ts"
import { IdempotencyKey, RunConfiguration, StageReceipt, type RunState } from "../../src/domain/index.ts"

export const policy: GuardPolicy = {
  mode: "fixture", enabled: true, metaCredentialConfigured: false, mineruCredentialConfigured: false, mineruEndpoint: null,
  budgetId: "fixture-allowance", authorizedBudgetMicrousd: 1_000_000, maximumCostMicrousd: { extraction: 200_000, "page-check": 200_000, headings: 200_000, figures: 200_000 },
  maxConcurrentCalls: 1, maxOutputTokens: 1_000, maxRequestBytes: 10_000, maxResponseBytes: 10_000, callDeadlineMilliseconds: 1_000,
}
export const options = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return { dataDirectory: yield* fs.makeTempDirectoryScoped(), queueLimit: 5 } satisfies StorageOptions
})
const model = { provider: "fixture", model: "deterministic", reasoning: "high", promptName: "check", promptVersion: "1", maxOutputTokens: 1000 }
export const admission = (owner = "reader-one", cap = 1, attempts = 3) => Schema.decodeUnknownEffect(Admission)({
  ownerId: owner, idempotencyKey: `upload-${owner}`, originalFilename: "normal.pdf", bytes: new TextEncoder().encode("%PDF-1.7 fixture"), pageCount: 1, pipelineVersion: "1",
  configuration: { extractionProvider: "fixture", extractionVersion: "1", pageCheck: model, headings: model, figures: model, maxProviderAttempts: attempts, deadlineMilliseconds: 100_000, spendingCapUsd: cap },
})
const input = (stage: "extraction" | "page-check" | "headings" | "figures" | "guide" = "page-check") => Schema.decodeUnknownEffect(AttemptInput)({
  stage, pageIds: ["page-1"], figureId: null, inputHashes: ["a".repeat(64)], request: { text: "source", parameters: { temperature: 0 } }, supportsIdempotency: true, retry: { _tag: "none" },
})
const figure = (block: number) => Schema.decodeUnknownEffect(AttemptInput)({
  stage: "figures", pageIds: ["page-1"], figureId: `figure-page-1-block-${block}`, inputHashes: ["b".repeat(64)], request: { figure: block },
  supportsIdempotency: true, retry: { _tag: "none" }, headroomMicrousd: 300_000,
})
const fixtureLayer = (settings: StorageOptions, limits: GuardPolicy = policy) => makeProviderGuardLayer(limits).pipe(Layer.provideMerge(makeDocumentStoreLayer(settings)))
const dispatcherLayer = (settings: StorageOptions, worker = "dispatcher-one", lease = 300) => makeRunDispatcherLayer(policy, worker, lease).pipe(Layer.provideMerge(fixtureLayer(settings)))
const claim = (cap = 1, attempts = 3, leaseMilliseconds = 100_000) => Effect.gen(function* () {
  const store = yield* DocumentStore
  yield* store.admit(yield* admission("reader-one", cap, attempts))
  const claimed = yield* store.claimNext({ workerId: "worker-one", leaseMilliseconds })
  if (claimed === null) return yield* Effect.die("Expected a durable claim")
  return claimed
})
const rows = Effect.gen(function* () {
  const database = yield* StorageDatabase
  return yield* database.query("test-attempts", () => database.db.selectFrom("provider_attempts").selectAll().execute())
})
const success = (call: Parameters<ProviderAdapter["Service"]["invoke"]>[0]) => call.submitted("remote-one").pipe(Effect.as({ response: { blocks: ["retained"] }, usage: { _tag: "unavailable" as const, reason: "Fixture has no measured usage" }, actualCostMicrousd: null }))
const adapter = (invoke: ProviderAdapter["Service"]["invoke"] = success, validate: ProviderAdapter["Service"]["validate"] = () => Effect.void) => Layer.succeed(ProviderAdapter, { invoke, validate })
const failedState = Effect.gen(function* () {
  return { _tag: "failed", finishedAt: DateTime.formatIso(yield* DateTime.now), failure: { code: "provider-failed", message: "Deterministic fixture terminal outcome", retryable: false, stage: null, pageId: null, figureId: null } } satisfies RunState
})

describe("durable provider guards", () => {
  for (const [name, configureGuide, configureReservation, budget] of [["missing model", false, true, 1_000_000], ["missing reservation", true, false, 1_000_000], ["exhausted shared allowance", true, true, 199_999]] as const) {
    it.effect(`refuses guide dispatch with ${name} before saving a charge or sending`, () => Effect.gen(function* () {
      const settings = yield* options
      const limits = { ...policy, authorizedBudgetMicrousd: budget, maximumCostMicrousd: { ...policy.maximumCostMicrousd, ...(configureReservation ? { guide: 200_000 } : {}) } }
      yield* Effect.gen(function* () {
        const store = yield* DocumentStore
        const original = yield* admission()
        yield* store.admit({ ...original, configuration: { ...original.configuration, ...(configureGuide ? { guide: original.configuration.headings } : {}) } })
        const owned = yield* store.claimNext({ workerId: "guide-guard", leaseMilliseconds: 100_000 })
        if (owned === null) return yield* Effect.die("Expected guide claim")
        const guard = yield* ProviderGuard
        expect(yield* guard.execute(owned, yield* input("guide")).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: configureGuide && configureReservation ? "limit-exceeded" : "processing-unavailable" } })
        expect(yield* rows).toEqual([])
        const database = yield* StorageDatabase
        expect(yield* database.query("guide-charge-refused", () => database.db.selectFrom("provider_charges").selectAll().execute())).toEqual([])
      }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings, limits), adapter(() => Effect.die("Refused guide must not dispatch")))))
    }).pipe(Effect.provide(NodeServices.layer)))
  }

  it.effect("persists receipt, intent, limits and reservation before dispatch and prevents duplicate calls", () => Effect.gen(function* () {
    const settings = yield* options
    let calls = 0
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      const prepared = yield* guard.prepare(owned, yield* input())
      expect(prepared._tag).toBe("prepared")
      expect((yield* rows)[0]).toMatchObject({ status: "prepared", reserved_microusd: 200_000, actual_microusd: null, dispatch_started_at: null })
      if (prepared._tag !== "prepared") return yield* Effect.die("Expected prepared receipt")
      const result = yield* guard.dispatch(prepared.ticket)
      expect(result.receipt.state._tag).toBe("completed")
      expect(result.delivery).toBe("performed")
      const duplicate = yield* Effect.result(guard.dispatch(prepared.ticket))
      expect(Result.isFailure(duplicate)).toBe(true)
      const replayed = yield* guard.execute(owned, yield* input())
      expect(replayed.delivery).toBe("reused")
      expect(calls).toBe(1)
      expect((yield* rows)[0]).toMatchObject({ status: "completed", remote_id: "remote-one", actual_microusd: null })
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), adapter((call) => Effect.gen(function* () {
      calls += 1
      expect(call.intent.maxOutputTokens).toBe(1000)
      expect(call.intent.clientIdempotencyKey).toBe(call.attemptId)
      expect(call.intent.deadlineAt).toBeGreaterThan(yield* Clock.currentTimeMillis)
      return yield* success(call)
    })))))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("concurrent deliveries make at most one provider call and one durable reservation", () => Effect.gen(function* () {
    const settings = yield* options
    let calls = 0
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      const request = yield* input()
      const results = yield* Effect.all(Array.from({ length: 8 }, () => Effect.result(guard.execute(owned, request))), { concurrency: "unbounded" })
      expect(calls).toBe(1)
      expect(results.filter((result) => Result.isSuccess(result) && result.success.delivery === "performed")).toHaveLength(1)
      expect(yield* rows).toHaveLength(1)
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), adapter((call) => Effect.sync(() => { calls += 1 }).pipe(Effect.andThen(success(call)))))))
  }).pipe(Effect.provide(NodeServices.layer)))

  // A 1 USD run cap with 300,000 kept free for later stages fits three 200,000 figure reservations, not four.
  for (const [limit, maxConcurrentCalls, prepared, message] of [
    ["spending cap", 6, 3, "The run spending allowance is exhausted, including outstanding charges"],
  ] as const) {
    it.effect(`concurrent figure calls never reserve past the ${limit}`, () => Effect.gen(function* () {
      const settings = yield* options
      yield* Effect.gen(function* () {
        const owned = yield* claim()
        const guard = yield* ProviderGuard
        const inputs = yield* Effect.forEach([1, 2, 3, 4, 5, 6], figure)
        const results = yield* Effect.all(inputs.map((request) => Effect.result(guard.prepare(owned, request))), { concurrency: "unbounded" })
        expect(results.filter(Result.isSuccess)).toHaveLength(prepared)
        expect(results.filter(Result.isFailure).map((result) => result.failure)).toEqual(Array.from({ length: 6 - prepared }, () => expect.objectContaining({ code: "limit-exceeded", message })))
        const database = yield* StorageDatabase
        const charges = yield* database.query("concurrent-figure-charges", () => database.db.selectFrom("provider_charges").selectAll().execute())
        expect(charges.reduce((sum, charge) => sum + charge.reserved_microusd, 0)).toBe(prepared * 200_000)
      }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings, { ...policy, maxConcurrentCalls }), adapter())))
    }).pipe(Effect.provide(NodeServices.layer)))
  }

  it.effect("reopens prepared work safely and replays completed bytes without another call after restart", () => Effect.gen(function* () {
    const settings = yield* options
    let calls = 0
    const owned = yield* Effect.gen(function* () {
      const acceptedClaim = yield* claim()
      const guard = yield* ProviderGuard
      yield* guard.prepare(acceptedClaim, yield* input())
      return acceptedClaim
    }).pipe(Effect.provide(fixtureLayer(settings)))
    for (const expected of ["performed", "reused"]) {
      yield* Effect.gen(function* () {
        const guard = yield* ProviderGuard
        const response = yield* guard.execute(owned, yield* input())
        expect(response.delivery).toBe(expected)
        expect(response.response).toEqual({ blocks: ["retained"] })
      }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), adapter((call) => Effect.sync(() => { calls += 1 }).pipe(Effect.andThen(success(call)))))))
    }
    expect(calls).toBe(1)
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("keeps an accepted remote operation unknown when its ID was not saved and never automatically retries", () => Effect.gen(function* () {
    const settings = yield* options
    let calls = 0
    let owned: DispatchClaim | undefined
    yield* Effect.gen(function* () {
      owned = yield* claim()
      const guard = yield* ProviderGuard
      expect(Result.isFailure(yield* Effect.result(guard.execute(owned, yield* input())))).toBe(true)
      expect((yield* rows)[0]).toMatchObject({ status: "unknown", remote_id: null, actual_microusd: null, reserved_microusd: 200_000 })
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), adapter(() => Effect.sync(() => { calls += 1 }).pipe(Effect.andThen(Effect.fail(new ProviderFailure({ certainty: "unknown", message: "Remote accepted before connection loss" }))))))))
    if (owned === undefined) return yield* Effect.die("Expected claim")
    const originalClaim = owned
    yield* Effect.gen(function* () {
      const guard = yield* ProviderGuard
      expect(Result.isFailure(yield* Effect.result(guard.execute(originalClaim, yield* input())))).toBe(true)
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), adapter(() => Effect.sync(() => { calls += 1 }).pipe(Effect.andThen(Effect.die("Must not resubmit")))))))
    expect(calls).toBe(1)
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("persists the remote ID immediately and retains unknown charges when canceled after submission", () => Effect.gen(function* () {
    const settings = yield* options
    const submitted = yield* Deferred.make<void>()
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      const fiber = yield* guard.execute(owned, yield* input()).pipe(Effect.forkChild)
      yield* Deferred.await(submitted)
      expect((yield* rows)[0]).toMatchObject({ status: "submitted", remote_id: "remote-persisted" })
      yield* Fiber.interrupt(fiber)
      expect((yield* rows)[0]).toMatchObject({ status: "unknown", remote_id: "remote-persisted", actual_microusd: null })
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), adapter((call) => call.submitted("remote-persisted").pipe(Effect.andThen(Deferred.succeed(submitted, undefined)), Effect.andThen(Effect.never))))))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("counts completed OCR reservations without known costs against later model calls", () => Effect.gen(function* () {
    const settings = yield* options
    yield* Effect.gen(function* () {
      const owned = yield* claim(0.3)
      const guard = yield* ProviderGuard
      yield* guard.execute(owned, yield* input("extraction"))
      const next = yield* Effect.result(guard.execute(owned, yield* input("page-check")))
      expect(Result.isFailure(next) && next.failure.code).toBe("limit-exceeded")
      expect(yield* rows).toHaveLength(1)
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), adapter())))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("releases only reported actual charges and refuses a cap overrun without inventing zero usage", () => Effect.gen(function* () {
    const settings = yield* options
    yield* Effect.gen(function* () {
      const owned = yield* claim(0.3)
      const guard = yield* ProviderGuard
      yield* guard.execute(owned, yield* input("extraction"))
      yield* guard.execute(owned, yield* input("page-check"))
      expect((yield* rows).map((row) => row.actual_microusd)).toEqual([50_000, 50_000])
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), adapter((call) => success(call).pipe(Effect.map((result) => ({ ...result, actualCostMicrousd: 50_000 })))))))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("charges a completed Meta call its reported tokens at the configured rates and keeps the reservation without both counts", () => Effect.gen(function* () {
    const settings = yield* options
    const limits: GuardPolicy = { ...policy, metaRates: { inputMicrousdPerMillionTokens: 1_250_000, outputMicrousdPerMillionTokens: 4_250_000 } }
    const meta = { ...model, provider: "meta", model: "muse-spark-1.3" }
    const usages = [{ _tag: "reported", inputTokens: 2000, outputTokens: 100, costUsd: null }, { _tag: "reported", inputTokens: 2000, outputTokens: null, costUsd: null }] as const
    let calls = 0
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const original = yield* admission()
      yield* store.admit({ ...original, configuration: yield* Schema.decodeUnknownEffect(RunConfiguration)({ ...original.configuration, pageCheck: meta, headings: meta }) })
      const owned = yield* store.claimNext({ workerId: "metered", leaseMilliseconds: 100_000 })
      if (owned === null) return yield* Effect.die("Expected metered claim")
      const guard = yield* ProviderGuard
      yield* guard.execute(owned, yield* input("page-check"))
      yield* guard.execute(owned, yield* input("headings"))
      const database = yield* StorageDatabase
      const charges = yield* database.query("metered-charges", () => database.db.selectFrom("provider_charges").select(["reserved_microusd", "actual_microusd"]).execute())
      expect(charges).toEqual([{ reserved_microusd: 200_000, actual_microusd: 2_925 }, { reserved_microusd: 200_000, actual_microusd: null }])
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings, limits), adapter((call) => success(call).pipe(Effect.map((result) => ({ ...result, usage: usages[calls++]! })))))))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects caller-forged retry authorization even with acknowledgement", () => Effect.gen(function* () {
    const settings = yield* options
    let calls = 0
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      const request = yield* input()
      yield* Effect.result(guard.execute(owned, request))
      const previous = (yield* rows)[0]
      if (previous === undefined) return yield* Effect.die("Missing attempt")
      const retry = yield* Schema.decodeUnknownEffect(AttemptInput)({ ...request, retry: { _tag: "authorized", previousAttemptId: previous.id, authorizationId: "explicit-action-one", acknowledgesUnknownCompletion: false } })
      yield* TestClock.adjust("1001 millis")
      expect(Result.isFailure(yield* Effect.result(guard.execute(owned, retry)))).toBe(true)
      const acknowledged = { ...retry, retry: { _tag: "authorized" as const, previousAttemptId: retry.retry._tag === "authorized" ? retry.retry.previousAttemptId : previous.id, authorizationId: "explicit-action-one", acknowledgesUnknownCompletion: true } }
      const valid = yield* Schema.decodeUnknownEffect(AttemptInput)(acknowledged)
      expect(yield* Effect.result(guard.execute(owned, valid))).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
      expect(calls).toBe(1)
      expect((yield* rows).reduce((sum, row) => sum + row.reserved_microusd, 0)).toBe(200_000)
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), adapter((call) => Effect.gen(function* () {
      calls += 1
      if (calls === 1) return yield* new ProviderFailure({ certainty: "unknown", message: "Unknown submission" })
      return yield* success(call)
    })))))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("saves rejected raw responses and refuses semantic-invalid or corrupted replay", () => Effect.gen(function* () {
    const settings = yield* options
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      expect(Result.isFailure(yield* Effect.result(guard.execute(owned, yield* input())))).toBe(true)
      const saved = (yield* rows)[0]
      expect(saved?.status).toBe("completed")
      expect(saved?.response_json).toContain("retained")
      expect(saved?.receipt_json).toContain("Missing source page")
      expect(Result.isFailure(yield* Effect.result(guard.execute(owned, yield* input())))).toBe(true)
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), adapter(success, () => Effect.fail(executionFailure("invalid-provider-response", "Missing source page"))))))
    const other = yield* options
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      yield* guard.execute(owned, yield* input())
      const database = yield* StorageDatabase
      yield* database.query("corrupt-response", () => database.db.updateTable("provider_attempts").set({ response_json: "{}" }).execute())
      expect(Result.isFailure(yield* Effect.result(guard.execute(owned, yield* input())))).toBe(true)
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(other), adapter())))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("does not authorize another provider call after semantic rejection", () => Effect.gen(function* () {
    const settings = yield* options
    let validations = 0
    let calls = 0
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      const request = yield* input()
      expect(Result.isFailure(yield* Effect.result(guard.execute(owned, request)))).toBe(true)
      const first = (yield* rows)[0]
      if (first === undefined) return yield* Effect.die("Expected rejected attempt")
      const retry = yield* Schema.decodeUnknownEffect(AttemptInput)({ ...request, retry: { _tag: "authorized", previousAttemptId: first.id, authorizationId: "retry-semantic-rejection", acknowledgesUnknownCompletion: false } })
      expect(yield* Effect.result(guard.execute(owned, retry))).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
      expect(yield* Effect.result(guard.execute(owned, request))).toMatchObject({ _tag: "Failure", failure: { code: "invalid-provider-response" } })
      expect(calls).toBe(1)
      expect((yield* rows).map((row) => row.validation_state)).toEqual(["rejected"])
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), adapter(
      (call) => Effect.sync(() => { calls += 1 }).pipe(Effect.andThen(success(call))),
      () => Effect.sync(() => { validations += 1 }).pipe(Effect.andThen(Effect.suspend(() => validations === 1 ? Effect.fail(executionFailure("invalid-provider-response", "Invalid first result")) : Effect.void))),
    ))))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("enforces response, request, token and deadline limits before accepting output", () => Effect.gen(function* () {
    const settings = yield* options
    const submitted = yield* Deferred.make<void>()
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      const tooLarge = { ...(yield* input()), request: "x".repeat(10_001) }
      expect(Result.isFailure(yield* Effect.result(guard.prepare(owned, tooLarge)))).toBe(true)
      const fiber = yield* guard.execute(owned, yield* input()).pipe(Effect.result, Effect.forkChild)
      yield* Deferred.await(submitted)
      yield* TestClock.adjust("1001 millis")
      const result = yield* Fiber.join(fiber)
      expect(Result.isFailure(result) && result.failure.code).toBe("provider-unknown-completion")
      expect((yield* rows)[0]?.status).toBe("unknown")
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), adapter(() => Deferred.succeed(submitted, undefined).pipe(Effect.andThen(Effect.never))))))
    for (const response of [{ response: "x".repeat(10_001), tokens: null }, { response: "small", tokens: 1001 }]) {
      const fixture = yield* options
      yield* Effect.gen(function* () {
        const owned = yield* claim()
        const guard = yield* ProviderGuard
        const result = yield* Effect.result(guard.execute(owned, yield* input()))
        expect(Result.isFailure(result) && result.failure.code).toBe("limit-exceeded")
        expect((yield* rows)[0]?.receipt_json).toContain("rejected")
      }).pipe(Effect.provide(Layer.merge(fixtureLayer(fixture), adapter(() => Effect.succeed({ response: response.response, usage: { _tag: "reported", inputTokens: 1, outputTokens: response.tokens, costUsd: null }, actualCostMicrousd: null })))))
    }
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("fails live configuration closed without preparing an attempt or calling a provider", () => Effect.gen(function* () {
    const live = { ...policy, mode: "live" as const }
    expect(processingAvailability(live).available).toBe(false)
    expect(processingAvailability({ ...live, metaCredentialConfigured: true, mineruCredentialConfigured: true, mineruEndpoint: "https://amuseme.example.test/jobs" }).available).toBe(true)
    for (const changed of [live, { ...policy, enabled: false }, { ...live, metaCredentialConfigured: true, mineruCredentialConfigured: true, mineruEndpoint: "http://unsafe.example.test", authorizedBudgetMicrousd: null }]) {
      const settings = yield* options
      yield* Effect.gen(function* () {
        const owned = yield* claim()
        const guard = yield* ProviderGuard
        expect(Result.isFailure(yield* Effect.result(guard.prepare(owned, yield* input())))).toBe(true)
        expect(yield* rows).toHaveLength(0)
      }).pipe(Effect.provide(fixtureLayer(settings, changed)))
    }
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects stale non-Meta preparation, direct dispatch and retry without changing saved charges", () => Effect.gen(function* () {
    const settings = yield* options
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const requested = yield* admission()
      yield* store.admit({ ...requested, configuration: { ...requested.configuration, extractionProvider: "mineru", extractionVersion: "4.0.12" } })
      const owned = yield* store.claimNext({ workerId: "legacy-worker", leaseMilliseconds: 100000 })
      if (owned === null) return yield* Effect.die("Expected legacy claim")
      const fixtureGuard = yield* ProviderGuard
      const request = yield* input("extraction")
      const prepared = yield* fixtureGuard.prepare(owned, request)
      if (prepared._tag !== "prepared") return yield* Effect.die("Expected saved prepared ticket")
      const before = yield* rows
      const live = { ...policy, mode: "live" as const, metaCredentialConfigured: true }
      const guard = yield* makeProviderGuard(live)
      expect(yield* guard.prepare(owned, request).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: "processing-unavailable" } })
      expect(yield* guard.dispatch(prepared.ticket).pipe(Effect.provide(adapter(() => Effect.die("Must not call legacy provider"))), Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: "processing-unavailable" } })
      expect(yield* rows).toEqual(before)
      const database = yield* StorageDatabase
      const charges = yield* database.query("old-charges", () => database.db.selectFrom("provider_charges").selectAll().execute())
      expect(charges).toHaveLength(1)
      expect(charges[0]?.actual_microusd).toBeNull()
      yield* store.updateRun(owned, yield* failedState)
      const recovery = yield* makeRunRecovery(live, 5)
      expect(yield* recovery.requestRetry({ ownerId: owned.document.ownerId, documentId: owned.document.id, previousRunId: owned.run.id, idempotencyKey: IdempotencyKey.make("legacy-denied-retry"), acknowledgesUnknownCompletion: false }).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: "processing-unavailable" } })
      expect(yield* database.query("no-new-retry", () => database.db.selectFrom("retry_requests").selectAll().execute())).toEqual([])
      expect(yield* database.query("same-charges", () => database.db.selectFrom("provider_charges").selectAll().execute())).toEqual(charges)
    }).pipe(Effect.provide(fixtureLayer(settings)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("keeps spending reservations after document deletion and rejects later work against the same allowance", () => Effect.gen(function* () {
    const settings = yield* options
    const limits = { ...policy, authorizedBudgetMicrousd: 300_000 }
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      const store = yield* DocumentStore
      yield* guard.execute(owned, yield* input())
      yield* store.updateRun(owned, yield* failedState)
      yield* store.delete(owned.run.ownerId, owned.document.id)
      expect(yield* rows).toHaveLength(0)
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings, limits), adapter())))
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      yield* store.admit(yield* admission("reader-two"))
      const owned = yield* store.claimNext({ workerId: "after-restart", leaseMilliseconds: 100_000 })
      if (owned === null) return yield* Effect.die("Expected second queued document")
      const guard = yield* ProviderGuard
      const result = yield* Effect.result(guard.execute(owned, yield* input()))
      expect(Result.isFailure(result) && result.failure.code).toBe("limit-exceeded")
      const database = yield* StorageDatabase
      const charges = yield* database.query("charges", () => database.db.selectFrom("provider_charges").selectAll().execute())
      expect(charges).toHaveLength(1)
      expect(charges[0]).toMatchObject({ reserved_microusd: 200_000, actual_microusd: null })
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings, limits), adapter())))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("revalidates saved raw output after interruption without repeating a provider call", () => Effect.gen(function* () {
    const settings = yield* options
    const validating = yield* Deferred.make<void>()
    let calls = 0
    const owned = yield* Effect.gen(function* () {
      const firstClaim = yield* claim()
      const guard = yield* ProviderGuard
      const fiber = yield* guard.execute(firstClaim, yield* input()).pipe(Effect.forkChild)
      yield* Deferred.await(validating)
      expect((yield* rows)[0]).toMatchObject({ status: "completed", validation_state: "pending" })
      yield* Fiber.interrupt(fiber)
      return firstClaim
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), adapter((call) => Effect.sync(() => { calls += 1 }).pipe(Effect.andThen(success(call))), () => Deferred.succeed(validating, undefined).pipe(Effect.andThen(Effect.never))))))
    yield* Effect.gen(function* () {
      const guard = yield* ProviderGuard
      const result = yield* guard.execute(owned, yield* input())
      expect(result.delivery).toBe("reused")
      expect(result.receipt.state._tag === "completed" && result.receipt.state.validation._tag).toBe("accepted")
      expect((yield* rows)[0]?.validation_state).toBe("accepted")
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), adapter((call) => Effect.sync(() => { calls += 1 }).pipe(Effect.andThen(success(call)))))))
    expect(calls).toBe(1)
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("reconciles crash histories without resending dispatched work or refunding uncertain charges", () => Effect.gen(function* () {
    for (const status of ["prepared", "dispatching", "submitted"] as const) {
      const settings = yield* options
      yield* Effect.gen(function* () {
        const owned = yield* claim()
        const guard = yield* ProviderGuard
        yield* guard.prepare(owned, yield* input())
        const database = yield* StorageDatabase
        if (status !== "prepared") yield* database.query("crash-window", () => database.db.updateTable("provider_attempts").set({ status, dispatch_started_at: 0, remote_id: status === "submitted" ? "saved-remote" : null }).execute())
      }).pipe(Effect.provide(fixtureLayer(settings)))
      yield* TestClock.adjust("1001 millis")
      yield* Effect.gen(function* () {
        const guard = yield* ProviderGuard
        expect(yield* guard.reconcile()).toBe(status === "prepared" ? 0 : 1)
        const saved = (yield* rows)[0]
        expect(saved?.status).toBe(status === "prepared" ? "prepared" : "unknown")
        expect(saved?.actual_microusd).toBeNull()
        expect(saved?.remote_id).toBe(status === "submitted" ? "saved-remote" : null)
        expect(yield* guard.reconcile()).toBe(0)
      }).pipe(Effect.provide(fixtureLayer(settings)))
    }
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("isolates complete fingerprints and ownership and rejects forged retry grants", () => Effect.gen(function* () {
    const settings = yield* options
    yield* Effect.gen(function* () {
      const owned = yield* claim(1, 1)
      const guard = yield* ProviderGuard
      const request = yield* input()
      const first = yield* guard.execute(owned, request)
      const changed = yield* guard.prepare(owned, { ...request, pageIds: [], request: { changed: "context" } })
      expect(changed._tag === "prepared" && changed.ticket.receipt.requestFingerprint).not.toBe(first.receipt.requestFingerprint)
      expect(Result.isFailure(yield* Effect.result(guard.prepare({ ...owned, claimToken: "forged" }, request)))).toBe(true)
      const retry = yield* Schema.decodeUnknownEffect(AttemptInput)({ ...request, retry: { _tag: "authorized", authorizationId: "fresh-one", previousAttemptId: first.receipt.id, acknowledgesUnknownCompletion: false } })
      const exhausted = yield* Effect.result(guard.prepare(owned, retry))
      expect(Result.isFailure(exhausted) && exhausted.failure.code).toBe("conflict")
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), adapter())))
  }).pipe(Effect.provide(NodeServices.layer)))
})

describe("guard transaction and replay regressions", () => {
  it.effect("checks lease time after waiting for the real transaction in prepare and dispatch", () => Effect.gen(function* () {
    for (const operation of ["prepare", "dispatch"] as const) {
      const settings = yield* options
      let calls = 0
      yield* Effect.gen(function* () {
        const owned = yield* claim(1, 3, 100)
        const database = yield* StorageDatabase
        const guard = yield* ProviderGuard
        const request = yield* input()
        const prepared = operation === "dispatch" ? yield* guard.prepare(owned, request) : null
        const locked = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const waiting = yield* Deferred.make<void>()
        const blocker = yield* database.transaction(() => Deferred.succeed(locked, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(Effect.forkChild)
        yield* Deferred.await(locked)
        const observed = StorageDatabase.of({ ...database, transaction: (work) => Deferred.succeed(waiting, undefined).pipe(Effect.andThen(database.transaction(work))) })
        const queued = yield* makeProviderGuard(policy).pipe(Effect.provideService(StorageDatabase, observed))
        const work = Effect.gen(function* () {
          if (prepared?._tag === "prepared") return yield* queued.dispatch(prepared.ticket)
          return yield* queued.prepare(owned, request)
        })
        const fiber = yield* work.pipe(Effect.result, Effect.forkChild)
        yield* Deferred.await(waiting)
        yield* TestClock.adjust(101)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(blocker)
        expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
        expect(calls).toBe(0)
        const saved = yield* rows
        expect(saved).toHaveLength(operation === "dispatch" ? 1 : 0)
        if (operation === "dispatch") expect(saved[0]).toMatchObject({ status: "prepared", dispatch_started_at: null })
      }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), adapter((call) => Effect.sync(() => { calls += 1 }).pipe(Effect.andThen(success(call)))))))
    }
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("uses the acquired transaction time when reconciling attempts queued before their deadline", () => Effect.gen(function* () {
    const settings = yield* options
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const database = yield* StorageDatabase
      const guard = yield* ProviderGuard
      yield* guard.prepare(owned, yield* input())
      yield* database.query("crash-window", () => database.db.updateTable("provider_attempts").set({ status: "dispatching", dispatch_started_at: 0 }).execute())
      const locked = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const waiting = yield* Deferred.make<void>()
      const blocker = yield* database.transaction(() => Deferred.succeed(locked, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(Effect.forkChild)
      yield* Deferred.await(locked)
      const observed = StorageDatabase.of({ ...database, transaction: (work) => Deferred.succeed(waiting, undefined).pipe(Effect.andThen(database.transaction(work))) })
      const queued = yield* makeProviderGuard(policy).pipe(Effect.provideService(StorageDatabase, observed))
      const fiber = yield* queued.reconcile().pipe(Effect.forkChild)
      yield* Deferred.await(waiting)
      yield* TestClock.adjust(1001)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(blocker)
      expect(yield* Fiber.join(fiber)).toBe(1)
      expect((yield* rows)[0]).toMatchObject({ status: "unknown", actual_microusd: null })
    }).pipe(Effect.provide(fixtureLayer(settings)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("does not accept validation queued behind a transaction after the claim expires", () => Effect.gen(function* () {
    const settings = yield* options
    const validating = yield* Deferred.make<void>()
    const finishValidation = yield* Deferred.make<void>()
    yield* Effect.gen(function* () {
      const owned = yield* claim(1, 3, 100)
      const database = yield* StorageDatabase
      const locked = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const waiting = yield* Deferred.make<void>()
      let observe = false
      const observed = StorageDatabase.of({ ...database, transaction: (work) => (observe ? Deferred.succeed(waiting, undefined) : Effect.void).pipe(Effect.andThen(database.transaction(work))) })
      const guard = yield* makeProviderGuard(policy).pipe(Effect.provideService(StorageDatabase, observed))
      const fiber = yield* guard.execute(owned, yield* input()).pipe(Effect.result, Effect.forkChild)
      yield* Deferred.await(validating)
      const blocker = yield* database.transaction(() => Deferred.succeed(locked, undefined).pipe(Effect.andThen(Deferred.await(release)))).pipe(Effect.forkChild)
      yield* Deferred.await(locked)
      observe = true
      yield* Deferred.succeed(finishValidation, undefined)
      yield* Deferred.await(waiting)
      yield* TestClock.adjust(101)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(blocker)
      expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
      expect((yield* rows)[0]).toMatchObject({ status: "completed", validation_state: "pending" })
    }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), adapter(success, () => Deferred.succeed(validating, undefined).pipe(Effect.andThen(Deferred.await(finishValidation)))))))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects schema-valid forged receipt metadata before accepted or pending replay across restart", () => Effect.gen(function* () {
    const changes = [
      (receipt: StageReceipt) => ({ ...receipt, scope: { ...receipt.scope, sourceHash: "b".repeat(64) } }),
      (receipt: StageReceipt) => ({ ...receipt, pageIds: ["page-2"] }),
      (receipt: StageReceipt) => ({ ...receipt, figureId: "figure-other" }),
      (receipt: StageReceipt) => ({ ...receipt, stage: "headings" }),
      (receipt: StageReceipt) => ({ ...receipt, pipelineVersion: "another-pipeline" }),
      (receipt: StageReceipt) => ({ ...receipt, configuration: { _tag: "model", ...model, promptVersion: "another-prompt" } }),
      (receipt: StageReceipt) => ({ ...receipt, inputHashes: ["c".repeat(64)] }),
      (receipt: StageReceipt) => ({ ...receipt, ownerId: "different-owner" }),
      (receipt: StageReceipt) => ({ ...receipt, scope: { ...receipt.scope, runId: "different-original-run" } }),
      (receipt: StageReceipt) => ({ ...receipt, requestFingerprint: "d".repeat(64) }),
    ]
    for (const state of ["accepted", "pending"] as const) {
      for (const change of changes) {
        const settings = yield* options
        let providerCalls = 0
        let validationCalls = 0
        const provider = adapter((call) => Effect.sync(() => { providerCalls += 1 }).pipe(Effect.andThen(success(call))), () => Effect.sync(() => { validationCalls += 1 }))
        const owned = yield* Effect.gen(function* () {
          const originalClaim = yield* claim()
          const guard = yield* ProviderGuard
          const completed = yield* guard.execute(originalClaim, yield* input())
          const altered = yield* Schema.decodeUnknownEffect(StageReceipt)(change(completed.receipt))
          const saved = state === "pending" && altered.state._tag === "completed"
            ? { ...altered, state: { ...altered.state, validation: { _tag: "rejected", failure: { code: "invalid-provider-response", message: "The saved response has not passed stage validation", retryable: false, stage: null, pageId: null, figureId: null } } } }
            : altered
          const database = yield* StorageDatabase
          yield* database.query("persisted-receipt-fault", () => database.db.updateTable("provider_attempts").set({ receipt_json: JSON.stringify(saved), validation_state: state }).where("id", "=", completed.receipt.id).execute())
          return originalClaim
        }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), provider)))
        yield* Effect.gen(function* () {
          const guard = yield* ProviderGuard
          expect(yield* Effect.result(guard.execute(owned, yield* input()))).toMatchObject({ _tag: "Failure", failure: { code: "invalid-provider-response" } })
        }).pipe(Effect.provide(Layer.merge(fixtureLayer(settings), provider)))
        expect(providerCalls).toBe(1)
        expect(validationCalls).toBe(1)
      }
    }
  }).pipe(Effect.provide(NodeServices.layer)), { timeout: 20000 })
})

describe("durable run dispatcher", () => {
  it.effect("claims accepted work after restart with the same persisted Mastra association and prevents duplicate starters", () => Effect.gen(function* () {
    const settings = yield* options
    const accepted = yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const submitted = yield* store.admit(yield* admission())
      return yield* store.status((yield* admission()).ownerId, submitted.documentId)
    }).pipe(Effect.provide(makeDocumentStoreLayer(settings)))
    const calls: Array<string | null> = []
    const start = Layer.succeed(RunStarter, { startOrReconnect: (owned: DispatchClaim) => Effect.sync(() => { calls.push(owned.run.mastraRunId) }).pipe(Effect.andThen(failedState)) })
    yield* Effect.gen(function* () {
      const dispatcher = yield* RunDispatcher
      const results = yield* Effect.all([dispatcher.dispatchOne(), dispatcher.dispatchOne()], { concurrency: "unbounded" })
      expect(results.filter((result) => result !== null)).toHaveLength(1)
      expect(calls).toEqual([accepted.mastraRunId])
      const store = yield* DocumentStore
      expect((yield* store.status(accepted.ownerId, accepted.documentId)).state._tag).toBe("failed")
    }).pipe(Effect.provide(Layer.merge(dispatcherLayer(settings), start)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("renews a running claim, interrupts on cancellation and never starts it again automatically", () => Effect.gen(function* () {
    const settings = yield* options
    const started = yield* Deferred.make<DispatchClaim>()
    let calls = 0
    const start = Layer.succeed(RunStarter, { startOrReconnect: (owned: DispatchClaim) => Effect.sync(() => { calls += 1 }).pipe(Effect.andThen(Deferred.succeed(started, owned)), Effect.andThen(Effect.never)) })
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      yield* store.admit(yield* admission())
      const dispatcher = yield* RunDispatcher
      const fiber = yield* dispatcher.dispatchOne().pipe(Effect.forkChild)
      const owned = yield* Deferred.await(started)
      yield* TestClock.adjust("150 millis")
      const database = yield* StorageDatabase
      const saved = yield* database.query("lease", () => database.db.selectFrom("runs").selectAll().where("id", "=", owned.run.id).executeTakeFirst())
      expect(saved?.lease_expires_at).toBeGreaterThan(owned.leaseExpiresAt)
      yield* Fiber.interrupt(fiber)
      expect((yield* store.status(owned.run.ownerId, owned.document.id)).state._tag).toBe("interrupted")
      expect(yield* dispatcher.dispatchOne()).toBeNull()
      expect(calls).toBe(1)
    }).pipe(Effect.provide(Layer.merge(dispatcherLayer(settings), start)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("reclaims safe stale work on restart with the same Mastra run and a fresh fenced claim", () => Effect.gen(function* () {
    const settings = yield* options
    const owned = yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      yield* store.admit(yield* admission())
      return yield* store.claimNext({ workerId: "crashed-worker", leaseMilliseconds: 100 })
    }).pipe(Effect.provide(makeDocumentStoreLayer(settings)))
    if (owned === null) return yield* Effect.die("Expected running claim")
    yield* TestClock.adjust("101 millis")
    yield* Effect.gen(function* () {
      const dispatcher = yield* RunDispatcher
      yield* dispatcher.recover()
      const store = yield* DocumentStore
      const saved = yield* store.status(owned.run.ownerId, owned.document.id)
      expect(saved.state._tag).toBe("running")
      expect(saved.mastraRunId).toBe(owned.run.mastraRunId)
      expect((yield* dispatcher.dispatchOne())?.run.id).toBe(owned.run.id)
    }).pipe(Effect.provide(Layer.merge(dispatcherLayer(settings), Layer.succeed(RunStarter, { startOrReconnect: (current) => Effect.gen(function* () {
      expect(current.recovered).toBe(true)
      expect(current.claimToken).not.toBe(owned.claimToken)
      expect(current.run.mastraRunId).toBe(owned.run.mastraRunId)
      return yield* failedState
    }) }))))
  }).pipe(Effect.provide(NodeServices.layer)))
})
