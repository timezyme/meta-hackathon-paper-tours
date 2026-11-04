import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Result, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { describe, expect } from "vitest"
import { ProviderAdapter, ProviderGuard, executionFailure } from "../../../src/processing/index.ts"
import { StorageDatabase } from "../../../src/storage/index.ts"
import { MetaEnvelope, MetaRequest } from "../../../src/paper/providers/meta/index.ts"
import { claim, registered, request, response, rows, runWith, settings, storeLayer, successfulBody, validators } from "./fixtures.ts"

describe("Meta response persistence", () => {
  it.effect("records dispatch before HTTP, the remote ID before body reading, and raw bytes before validation", () => Effect.gen(function* () {
    const options = yield* settings
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      const database = yield* StorageDatabase
      const saved = rows.pipe(Effect.provideService(StorageDatabase, database))
      let read = false
      let validated = false
      const client = HttpClient.make((req) => Effect.gen(function* () {
        expect((yield* saved)[0]).toMatchObject({ status: "dispatching", reserved_microusd: 1, response_json: null })
        const reply = response(req)
        Object.defineProperty(reply, "stream", { value: Stream.fromEffect(Effect.gen(function* () {
          expect((yield* saved)[0]).toMatchObject({ status: "submitted", remote_id: "request-1", response_json: null })
          read = true
          return new TextEncoder().encode(successfulBody)
        }).pipe(Effect.orDie)) })
        return reply
      }).pipe(Effect.orDie))
      const adapter = yield* runWith(registered(), client, { ...validators, "page-check": (value, receipt) => Effect.gen(function* () {
        expect((yield* saved)[0]).toMatchObject({ status: "completed", validation_state: "pending" })
        expect((yield* saved)[0]?.response_json).toContain("bodyBase64")
        validated = true
        yield* validators["page-check"](value, receipt)
      }).pipe(Effect.orDie) })
      yield* guard.execute(owned, yield* request()).pipe(Effect.provideService(ProviderAdapter, adapter))
      expect(read && validated).toBe(true)
    }).pipe(Effect.provide(storeLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("revalidates pending raw bytes after reopening storage and replays accepted output without HTTP", () => Effect.gen(function* () {
    const options = yield* settings
    let sends = 0
    const client = HttpClient.make((req) => Effect.sync(() => { sends += 1; return response(req) }))
    const owned = yield* Effect.gen(function* () {
      const current = yield* claim()
      const guard = yield* ProviderGuard
      const adapter = yield* runWith(registered(), client, { ...validators, "page-check": () => Effect.fail(executionFailure("provider-failed", "Temporary local validator failure")) })
      expect(Result.isFailure(yield* Effect.result(guard.execute(current, yield* request()).pipe(Effect.provideService(ProviderAdapter, adapter))))).toBe(true)
      expect((yield* rows)[0]?.validation_state).toBe("pending")
      return current
    }).pipe(Effect.provide(storeLayer(options)))
    for (let attempt = 0; attempt < 2; attempt += 1) {
      yield* Effect.gen(function* () {
        const guard = yield* ProviderGuard
        const adapter = yield* runWith(registered(), client)
        expect((yield* guard.execute(owned, yield* request()).pipe(Effect.provideService(ProviderAdapter, adapter))).delivery).toBe("reused")
        expect((yield* rows)[0]?.validation_state).toBe("accepted")
      }).pipe(Effect.provide(storeLayer(options)))
    }
    expect(sends).toBe(1)
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects corrupt saved bytes without another HTTP call", () => Effect.gen(function* () {
    const options = yield* settings
    let sends = 0
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      const database = yield* StorageDatabase
      const adapter = yield* runWith(registered(), HttpClient.make((req) => Effect.sync(() => { sends += 1; return response(req) })))
      const input = yield* request()
      yield* guard.execute(owned, input).pipe(Effect.provideService(ProviderAdapter, adapter))
      yield* database.query("corrupt-meta-envelope", () => database.db.updateTable("provider_attempts").set({ response_json: "{}" }).execute())
      expect(Result.isFailure(yield* Effect.result(guard.execute(owned, input).pipe(Effect.provideService(ProviderAdapter, adapter))))).toBe(true)
      expect(sends).toBe(1)
    }).pipe(Effect.provide(storeLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("does not accept a response when durable request-ID recording fails", () => Effect.gen(function* () {
    const options = yield* settings
    let sends = 0
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      const adapter = yield* runWith(registered(), HttpClient.make((req) => Effect.sync(() => { sends += 1; return response(req) })))
      const failing = ProviderAdapter.of({ ...adapter, invoke: (call) => adapter.invoke({ ...call, submitted: () => Effect.fail(executionFailure("provider-failed", "Could not record remote ID")) }) })
      expect(Result.isFailure(yield* Effect.result(guard.execute(owned, yield* request()).pipe(Effect.provideService(ProviderAdapter, failing))))).toBe(true)
      expect(sends).toBe(1)
      expect((yield* rows)[0]).toMatchObject({ status: "unknown", response_json: null, actual_microusd: null })
    }).pipe(Effect.provide(storeLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("records body IDs and measured usage even if the stage output is invalid", () => Effect.gen(function* () {
    const options = yield* settings
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      const body = JSON.stringify({ id: "body-id", choices: [], usage: { prompt_tokens: 11, completion_tokens: 12 } })
      const adapter = yield* runWith(registered(), HttpClient.make((req) => Effect.succeed(HttpClientResponse.fromWeb(req, new Response(body)))))
      expect(Result.isFailure(yield* Effect.result(guard.execute(owned, yield* request()).pipe(Effect.provideService(ProviderAdapter, adapter))))).toBe(true)
      const row = (yield* rows)[0]
      expect(row).toMatchObject({ status: "completed", remote_id: "body-id", validation_state: "rejected", actual_microusd: null })
      expect(row?.receipt_json).toContain('"inputTokens":11')
      expect(row?.receipt_json).toContain('"outputTokens":12')
      const saved = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MetaEnvelope))(row?.response_json)
      expect(saved.complete).toBe(true)
    }).pipe(Effect.provide(storeLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  for (const field of ["effort", "output limit", "schema", "extra option"] as const) {
    it.effect(`rejects an unauthorized ${field} before sending`, () => Effect.gen(function* () {
      const options = yield* settings
      let sends = 0
      yield* Effect.gen(function* () {
        const owned = yield* claim()
        const guard = yield* ProviderGuard
        const input = yield* request()
        const body = yield* Schema.decodeUnknownEffect(MetaRequest)(input.request)
        const changed = field === "effort" ? { ...body, reasoning_effort: "medium" } : field === "output limit" ? { ...body, max_completion_tokens: 999 } : field === "schema" ? { ...body, response_format: { ...body.response_format, json_schema: { ...body.response_format.json_schema, schema: { type: "string" } } } } : { ...body, temperature: 0 }
        const adapter = yield* runWith(registered(), HttpClient.make((req) => Effect.sync(() => { sends += 1; return response(req) })))
        expect(Result.isFailure(yield* Effect.result(guard.execute(owned, { ...input, request: changed }).pipe(Effect.provideService(ProviderAdapter, adapter))))).toBe(true)
        expect(sends).toBe(0)
      }).pipe(Effect.provide(storeLayer(options)))
    }).pipe(Effect.provide(NodeServices.layer)))
  }
})
