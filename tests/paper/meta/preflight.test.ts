import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientResponse } from "effect/http"
import { MetaRequest } from "../../../src/paper/providers/meta/contracts.ts"
import { countEndpoint, measureMetaInput } from "../../../src/paper/providers/meta/transport.ts"
import { request } from "./fixtures.ts"

const credential = Redacted.make("token-count-fixture")
describe("non-generating context preflight", () => {
  it.effect("counts complete text, image and output-schema context without submitting generation", () => Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(MetaRequest)((yield* request()).request)
    let calls = 0
    const client = HttpClient.make((outbound) => Effect.sync(() => {
      calls += 1
      expect(outbound.method).toBe("POST")
      expect(outbound.url).toBe(countEndpoint)
      expect(outbound.body._tag).toBe("Uint8Array")
      if (outbound.body._tag === "Uint8Array") {
        const body = JSON.parse(new TextDecoder().decode(outbound.body.body))
        expect(body).toEqual({ model: input.model, instructions: input.messages[0].content, input: [{ role: "user", content: input.messages[1].content.map((part) => part.type === "text" ? { type: "input_text", text: part.text } : { type: "input_image", image_url: part.image_url.url }) }], reasoning: { effort: input.reasoning_effort }, text: { format: { type: "json_schema", ...input.response_format.json_schema } } })
      }
      return HttpClientResponse.fromWeb(outbound, Response.json({ object: "response.input_tokens", input_tokens: 10000 }))
    }))
    const result = yield* measureMetaInput(input, credential).pipe(Effect.provideService(HttpClient.HttpClient, client))
    expect(result).toMatchObject({ inputTokens: 10000, model: "muse-spark-1.3", framingReserveTokens: 65536 })
    expect(result.requestHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(calls).toBe(1)
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("fails closed on oversized, invalid and rejected counts without retry", () => Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(MetaRequest)((yield* request()).request)
    for (const [status, body, code] of [[500, "{}", "provider-failed"], [429, "{}", "provider-failed"], [401, "{}", "processing-unavailable"], [400, "{}", "invalid-provider-response"], [200, '{"object":"response.input_tokens","input_tokens":524289}', "limit-exceeded"], [200, '{"input_tokens":0}', "invalid-provider-response"], [200, "x".repeat(4097), "invalid-provider-response"]] as const) {
      let calls = 0
      const client = HttpClient.make((outbound) => Effect.sync(() => { calls += 1; return HttpClientResponse.fromWeb(outbound, new Response(body, { status })) }))
      const result = yield* measureMetaInput(input, credential).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.code).toBe(code)
      expect(calls).toBe(1)
    }
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("times out counting as retryable provider failure and cancels without generating", () => Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(MetaRequest)((yield* request()).request)
    const entered = yield* Deferred.make<void>()
    let stopped = false
    let calls = 0
    const client = HttpClient.make((outbound) => Effect.gen(function* () {
      expect(outbound.url).toBe(countEndpoint)
      calls += 1
      yield* Deferred.succeed(entered, undefined)
      return yield* Effect.never
    }).pipe(Effect.ensuring(Effect.sync(() => { stopped = true }))))
    const fiber = yield* Effect.forkChild(measureMetaInput(input, credential).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result))
    yield* Deferred.await(entered)
    yield* TestClock.adjust("60 seconds")
    expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "Failure", failure: { code: "provider-failed" } })
    expect(calls).toBe(1)
    expect(stopped).toBe(true)
  }).pipe(Effect.provide(NodeServices.layer)))
})
