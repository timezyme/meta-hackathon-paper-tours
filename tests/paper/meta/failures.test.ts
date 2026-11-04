import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Result, Schema } from "effect"
import { HttpClient, HttpClientError } from "effect/http"
import { TestClock } from "effect/testing"
import { describe, expect } from "vitest"
import { ProviderAdapter, ProviderGuard } from "../../../src/processing/index.ts"
import { MetaEnvelope } from "../../../src/paper/providers/meta/index.ts"
import { claim, policy, registered, request, response, rows, runWith, settings, storeLayer, successfulBody, validators } from "./fixtures.ts"

describe("Meta transport failure boundaries", () => {
  it.live("finishes HTTP cleanup before guard interruption completes", () => Effect.gen(function* () {
    const options = yield* settings
    const started = yield* Deferred.make<void>()
    const finalized = yield* Deferred.make<void>()
    const events: Array<string> = []
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      const adapter = yield* runWith(registered(), HttpClient.make(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sleep("50 millis").pipe(Effect.andThen(Effect.sync(() => events.push("http-finalized"))), Effect.andThen(Deferred.succeed(finalized, undefined)))))))
      const fiber = yield* guard.execute(owned, yield* request()).pipe(Effect.provideService(ProviderAdapter, adapter), Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      events.push("guard-interrupted")
      yield* Deferred.await(finalized).pipe(Effect.timeout("5 seconds"))
      expect(events).toEqual(["http-finalized", "guard-interrupted"])
      expect((yield* rows)[0]?.status).toBe("unknown")
    }).pipe(Effect.provide(storeLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("retains a bounded incomplete prefix and never calls semantic validation", () => Effect.gen(function* () {
    const options = yield* settings
    let validated = false
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      const adapter = yield* runWith(registered(), HttpClient.make((req) => Effect.succeed(response(req, "x".repeat(20_000)))), {
        ...validators, "page-check": () => Effect.sync(() => { validated = true }),
      })
      expect(Result.isFailure(yield* Effect.result(guard.execute(owned, yield* request()).pipe(Effect.provideService(ProviderAdapter, adapter))))).toBe(true)
      const row = (yield* rows)[0]
      const raw = row?.response_json ?? ""
      expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(800)
      expect((yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MetaEnvelope))(raw)).complete).toBe(false)
      expect(validated).toBe(false)
      expect(row?.validation_state).toBe("rejected")
    }).pipe(Effect.provide(storeLayer(options, { ...policy, maxResponseBytes: 800 })))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("sends once on connection loss and keeps the durable attempt unknown", () => Effect.gen(function* () {
    const options = yield* settings
    let sends = 0
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      const adapter = yield* runWith(registered(), HttpClient.make((req) => Effect.suspend(() => {
        sends += 1
        return Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request: req, description: "Offline connection loss" }) }))
      })))
      const input = yield* request()
      expect(Result.isFailure(yield* Effect.result(guard.execute(owned, input).pipe(Effect.provideService(ProviderAdapter, adapter))))).toBe(true)
      expect(Result.isFailure(yield* Effect.result(guard.execute(owned, input).pipe(Effect.provideService(ProviderAdapter, adapter))))).toBe(true)
      expect(sends).toBe(1)
      expect((yield* rows)[0]).toMatchObject({ status: "unknown", response_json: null, actual_microusd: null, reserved_microusd: 1 })
    }).pipe(Effect.provide(storeLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  for (const mode of ["abort", "deadline"] as const) {
    it.effect(`propagates ${mode} to HTTP without resubmission`, () => Effect.gen(function* () {
      const options = yield* settings
      const started = yield* Deferred.make<void>()
      let signal: AbortSignal | undefined
      let sends = 0
      yield* Effect.gen(function* () {
        const owned = yield* claim()
        const guard = yield* ProviderGuard
        const adapter = yield* runWith(registered(), HttpClient.make((_req, _url, abortSignal) => {
          signal = abortSignal
          sends += 1
          return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
        }))
        const operation = guard.execute(owned, yield* request()).pipe(Effect.provideService(ProviderAdapter, adapter))
        const fiber = yield* Effect.result(operation).pipe(Effect.forkChild)
        yield* Deferred.await(started)
        if (mode === "abort") yield* Fiber.interrupt(fiber)
        else {
          yield* TestClock.adjust("1001 millis")
          expect(Result.isFailure(yield* Fiber.join(fiber))).toBe(true)
        }
        expect(signal?.aborted).toBe(true)
        expect(sends).toBe(1)
        expect((yield* rows)[0]).toMatchObject({ status: "unknown", actual_microusd: null, response_json: null })
      }).pipe(Effect.provide(storeLayer(options)))
    }).pipe(Effect.provide(NodeServices.layer)))
  }

  const invalid = [
    ["refusal", successfulBody.replace('"content":', '"refusal":"cannot comply","content":')],
    ["truncation", successfulBody.replace('"stop"', '"length"')],
    ["wrong model", successfulBody.replace("muse-spark-1.3", "unexpected-model")],
    ["tool call", successfulBody.replace('"content":', '"tool_calls":[{}],"content":')],
    ["invalid assistant JSON", successfulBody.replace('"content":"{', '"content":"invalid {')],
  ] as const
  for (const [label, body] of invalid) {
    it.effect(`saves and rejects ${label}`, () => Effect.gen(function* () {
      const options = yield* settings
      yield* Effect.gen(function* () {
        const owned = yield* claim()
        const guard = yield* ProviderGuard
        let sends = 0
        const adapter = yield* runWith(registered(), HttpClient.make((req) => Effect.sync(() => { sends += 1; return response(req, body) })))
        const result = yield* Effect.result(guard.execute(owned, yield* request()).pipe(Effect.provideService(ProviderAdapter, adapter)))
        expect(Result.isFailure(result)).toBe(true)
        expect(sends).toBe(1)
        expect((yield* rows)[0]).toMatchObject({ status: "completed", validation_state: "rejected" })
      }).pipe(Effect.provide(storeLayer(options)))
    }).pipe(Effect.provide(NodeServices.layer)))
  }
})
