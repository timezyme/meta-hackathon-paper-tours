import { describe, expect, it } from "@effect/vitest"
import { afterEach, vi } from "vitest"
import { Effect, Fiber, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { CanonicalDocument } from "../../../src/domain/index.ts"
import { copyNormalizedText, readOutputs, readNormalizedText, saveRating } from "../../../src/app/client/outputs.ts"
import { appReaderFixture } from "../reader-fixture.ts"

const browserOrigin = (client: HttpClient.HttpClient) => HttpClient.mapRequest(client, HttpClientRequest.prependUrl("http://reader.example.test"))
afterEach(() => vi.unstubAllGlobals())

describe("output HTTP boundary", () => {
  const fixture = appReaderFixture
  const identity = { documentId: fixture.canonical.scope.documentId, revisionId: fixture.canonical.scope.revisionId }
  it.effect("decodes matching saved output and preserves unknown rating", () => Effect.gen(function* () {
    const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(request.url.endsWith("/document") ? fixture.canonical : request.url.endsWith("/report") ? fixture.report : { value: null }))))
    const result = yield* readOutputs(identity).pipe(Effect.provideService(HttpClient.HttpClient, browserOrigin(client)))
    expect(result.canonical).toEqual(fixture.canonical)
    expect(result.report).toEqual(fixture.report)
    expect(result.rating).toBeNull()
  }))
  it.effect("rejects a different revision even when each response satisfies its schema", () => Effect.gen(function* () {
    const canonical = yield* Schema.decodeUnknownEffect(CanonicalDocument)({ ...fixture.canonical, scope: { ...fixture.canonical.scope, revisionId: "other-revision" } })
    const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(request.url.endsWith("/document") ? canonical : request.url.endsWith("/report") ? fixture.report : { value: null }))))
    const result = yield* readOutputs(identity).pipe(Effect.provideService(HttpClient.HttpClient, browserOrigin(client)), Effect.result)
    expect(Result.isFailure(result) && result.failure.kind).toBe("invalid-response")
  }))
  it.effect("reads complete normalized text without changing UTF-8 characters or newlines", () => Effect.gen(function* () {
    const text = "François α\r\nPage two\nFinal note.\n"
    const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } }))))
    expect(yield* readNormalizedText(identity).pipe(Effect.provideService(HttpClient.HttpClient, browserOrigin(client)))).toBe(text)
  }))
  it.effect("copies complete text once without changing UTF-8 characters or newlines", () => Effect.gen(function* () {
    const text = "François α\r\nPage two\nFinal note.\n"
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    let reads = 0
    const client = HttpClient.make((request) => { reads += 1; return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } }))) })
    yield* copyNormalizedText(identity).pipe(Effect.provideService(HttpClient.HttpClient, browserOrigin(client)))
    expect(writeText).toHaveBeenCalledExactlyOnceWith(text)
    expect(reads).toBe(1)
  }))
  it.effect("bounds a pending clipboard write without automatically repeating either operation", () => Effect.gen(function* () {
    const pending = new ReadableStream<void>().getReader()
    const writeText = vi.fn(() => pending.read().then(() => {}))
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    let reads = 0
    const client = HttpClient.make((request) => { reads += 1; return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("Complete saved text", { headers: { "content-type": "text/plain" } }))) })
    const fiber = yield* copyNormalizedText(identity).pipe(Effect.provideService(HttpClient.HttpClient, browserOrigin(client)), Effect.result, Effect.forkChild)
    yield* TestClock.adjust("10 seconds")
    expect(fiber.pollUnsafe()).toBeDefined()
    const result = yield* Fiber.join(fiber)
    expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "rejected", message: "Copying took too long. Download the text file instead." } })
    yield* Effect.promise(() => pending.cancel())
    yield* Effect.yieldNow
    expect(yield* Fiber.join(fiber)).toEqual(result)
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(reads).toBe(1)
  }))
  it.effect("does not retry a rejected rating mutation", () => Effect.gen(function* () {
    const methods: Array<string> = []
    const client = HttpClient.make((request) => { methods.push(request.method); return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ code: "expired", message: "Expired" }, { status: 410 }))) })
    const result = yield* saveRating(identity, "up").pipe(Effect.provideService(HttpClient.HttpClient, browserOrigin(client)), Effect.result)
    expect(Result.isFailure(result) && result.failure.message).toContain("expired")
    expect(methods).toEqual(["PUT"])
  }))
})
