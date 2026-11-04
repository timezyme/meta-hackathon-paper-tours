import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Effect, Result, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { HttpClient } from "effect/http"
import { describe, expect } from "vitest"
import { ProviderAdapter, ProviderGuard } from "../../../src/processing/index.ts"
import { MetaEnvelope, decodeMetaOutput } from "../../../src/paper/providers/meta/index.ts"
import { metaEndpoint } from "../../../src/paper/providers/meta/transport.ts"
import { claim, registered, request, response, rows, runWith, settings, storeLayer, successfulBody } from "./fixtures.ts"

describe("guarded Meta adapter", () => {
  for (const envelope of [
    { complete: false, bodyBase64: Base64.encode("incomplete") },
    { complete: true, bodyBase64: "not base64" },
  ]) it.effect("does not classify an incomplete or corrupt transient-error envelope as retryable", () => Effect.gen(function* () {
    const result = yield* decodeMetaOutput({ format: "amuseme-meta-wire-v1", status: 503, requestId: null, ...envelope }).pipe(Effect.result)
    expect(Result.isFailure(result) && result.failure.code).toBe("invalid-provider-response")
  }))

  it.effect("sends the exact guarded request through registered agents and replays without HTTP", () => Effect.gen(function* () {
    const options = yield* settings
    const boundary = registered()
    const captured: Array<unknown> = []
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      const adapter = yield* runWith(boundary, HttpClient.make((req, url) => Effect.sync(() => {
        expect(url.href).toBe(metaEndpoint)
        expect(req.method).toBe("POST")
        expect(req.headers.authorization).toBe("Bearer offline-secret")
        expect(req.body._tag).toBe("Uint8Array")
        if (req.body._tag === "Uint8Array") captured.push(JSON.parse(new TextDecoder().decode(req.body.body)))
        return response(req)
      })))
      for (const stage of ["page-check", "headings", "figures"] as const) {
        const input = yield* request(stage)
        const result = yield* guard.execute(owned, input).pipe(Effect.provideService(ProviderAdapter, adapter))
        expect(result.delivery).toBe("performed")
        expect(captured.at(-1)).toEqual(input.request)
        expect(yield* decodeMetaOutput(result.response)).toEqual({ text: "α = 2 ± 1" })
        const reused = yield* guard.execute(owned, input).pipe(Effect.provideService(ProviderAdapter, adapter))
        expect(reused.delivery).toBe("reused")
      }
      expect(captured).toHaveLength(3)
      for (const row of yield* rows) expect(row).toMatchObject({ status: "completed", validation_state: "accepted", remote_id: "request-1", actual_microusd: null })
    }).pipe(Effect.provide(storeLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  for (const [label, body, status] of [["non-JSON", "<html>provider error</html>", 200], ["rate limited", "rate limited", 429], ["bad gateway", "failure", 502], ["retryable failure", "failure", 503], ["gateway timeout", "failure", 504], ["unauthorized", "failure", 401], ["invalid output", successfulBody.replace("α = 2 ± 1", "").replace('\\"text\\"', '\\"wrong\\"'), 200]] as const) {
    it.effect(`saves ${label} bytes before rejection with one HTTP send`, () => Effect.gen(function* () {
      const options = yield* settings
      const boundary = registered()
      let sends = 0
      yield* Effect.gen(function* () {
        const owned = yield* claim()
        const guard = yield* ProviderGuard
        const adapter = yield* runWith(boundary, HttpClient.make((req) => Effect.sync(() => { sends += 1; return response(req, body, status) })))
        const input = yield* request()
        const result = yield* Effect.result(guard.execute(owned, input).pipe(Effect.provideService(ProviderAdapter, adapter)))
        expect(Result.isFailure(result)).toBe(true)
        const transient = [429, 502, 503, 504].includes(status)
        expect(Result.isFailure(result) && result.failure.code).toBe(transient ? "provider-failed" : "invalid-provider-response")
        expect(Result.isFailure(yield* guard.execute(owned, input).pipe(Effect.provideService(ProviderAdapter, adapter), Effect.result))).toBe(true)
        expect(sends).toBe(1)
        const row = (yield* rows)[0]
        expect(row).toMatchObject({ status: "completed", validation_state: transient ? "pending" : "rejected", actual_microusd: null })
        const saved = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(MetaEnvelope))(row?.response_json)
        expect(saved.bodyBase64).toBe(Base64.encode(body))
      }).pipe(Effect.provide(storeLayer(options)))
    }).pipe(Effect.provide(NodeServices.layer)))
  }
})
