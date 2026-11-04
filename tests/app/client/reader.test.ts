import { describe, expect, it } from "@effect/vitest"
import { afterEach, vi } from "vitest"
import { Effect, Fiber, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { CanonicalDocument } from "../../../src/domain/index.ts"
import { copyNormalizedText, readOutputs, readNormalizedText, readPublishedDocument, saveRating } from "../../../src/app/client/outputs.ts"
import { readDocument } from "../../../src/app/client/documents.ts"
import { documentFailureDetails } from "../../../src/app/client/http.ts"
import { appReaderFixture } from "../reader-fixture.ts"
import { guidedCanonical, guidedReport } from "../guide-fixture.ts"

const browserOrigin = (client: HttpClient.HttpClient) => HttpClient.mapRequest(client, HttpClientRequest.prependUrl("http://reader.example.test"))
afterEach(() => vi.unstubAllGlobals())

describe("output HTTP boundary", () => {
  const fixture = appReaderFixture
  const identity = { documentId: fixture.canonical.scope.documentId, revisionId: fixture.canonical.scope.revisionId }
  it.effect("loads the featured publication and its receipt without fetching a rating or normalized text", () => Effect.gen(function* () {
    const routes: Array<string> = []
    const client = HttpClient.make((request) => {
      const route = new URL(request.url).pathname
      routes.push(route)
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(route.endsWith("/report") ? guidedReport : guidedCanonical)))
    })
    const publication = yield* readPublishedDocument(identity).pipe(Effect.provideService(HttpClient.HttpClient, browserOrigin(client)))
    expect(publication.canonical.guide).toEqual(guidedCanonical.guide)
    const path = `/api/documents/${identity.documentId}/outputs/${identity.revisionId}`
    expect(routes.toSorted()).toEqual([`${path}/document`, `${path}/report`])
  }))
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
  it.effect("accepts saved guide evidence only with its matching completed accepted receipt", () => Effect.gen(function* () {
    const guideIdentity = guidedCanonical.scope
    for (const variant of ["valid", "invented-quote", "missing-receipt", "wrong-source", "unaccepted-receipt"] as const) {
      const guide = guidedCanonical.guide!
      const canonical = variant === "invented-quote" ? { ...guidedCanonical, guide: { ...guide, overview: { ...guide.overview, sources: [{ ...guide.overview.sources[0], quote: "This sentence is not in the document." }] } } } : guidedCanonical
      const report = variant === "missing-receipt" ? { ...guidedReport, receipts: [] } : variant === "wrong-source" || variant === "unaccepted-receipt" ? { ...guidedReport, receipts: guidedReport.receipts.map((item) => item.receipt.stage !== "guide" ? item : { ...item, receipt: variant === "wrong-source" ? { ...item.receipt, scope: { ...item.receipt.scope, sourceHash: "b".repeat(64) } } : { ...item.receipt, state: { _tag: "prepared" } } }) } : guidedReport
      const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(request.url.endsWith("/document") ? canonical : request.url.endsWith("/report") ? report : { value: null }))))
      const result = yield* readOutputs(guideIdentity).pipe(Effect.provideService(HttpClient.HttpClient, browserOrigin(client)), Effect.result)
      if (variant === "valid") expect(result).toMatchObject({ _tag: "Success", success: { canonical: guidedCanonical } })
      else expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "invalid-response" } })
    }
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
  it.effect("preserves expiry at both the document and output read boundaries without retrying", () => Effect.gen(function* () {
    for (const status of [404, 410]) {
      const requests: Array<string> = []
      const client = HttpClient.make((request) => { requests.push(request.url); return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ code: status === 410 ? "expired" : "not-found", message: "Document unavailable" }, { status }))) })
      const document = yield* readDocument(identity.documentId).pipe(Effect.provideService(HttpClient.HttpClient, browserOrigin(client)), Effect.result)
      const output = yield* readOutputs(identity).pipe(Effect.provideService(HttpClient.HttpClient, browserOrigin(client)), Effect.result)
      expect(document).toMatchObject({ _tag: "Failure", failure: { kind: "rejected", status } })
      expect(output).toMatchObject({ _tag: "Failure", failure: { kind: "rejected", status } })
      if (Result.isFailure(document)) expect(documentFailureDetails(document.failure)).toEqual({ kind: "rejected", message: "Document unavailable", status })
      expect(requests.filter((url) => url.endsWith(`/api/documents/${identity.documentId}`))).toHaveLength(1)
      expect(new Set(requests).size).toBe(requests.length)
    }
  }))
  it.effect("keeps connection failures temporary at both read boundaries", () => Effect.gen(function* () {
    const client = HttpClient.make((request) => Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, description: "Offline" }) })))
    for (const program of [readDocument(identity.documentId).pipe(Effect.asVoid), readOutputs(identity).pipe(Effect.asVoid)]) {
      const result = yield* program.pipe(Effect.provideService(HttpClient.HttpClient, browserOrigin(client)), Effect.result)
      expect(result).toMatchObject({ _tag: "Failure", failure: { kind: "transport" } })
      if (Result.isFailure(result)) expect(documentFailureDetails(result.failure)).not.toHaveProperty("status")
    }
  }))
  it.effect("does not retry a rejected rating mutation", () => Effect.gen(function* () {
    const methods: Array<string> = []
    const client = HttpClient.make((request) => { methods.push(request.method); return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ code: "expired", message: "Expired" }, { status: 410 }))) })
    const result = yield* saveRating(identity, "up").pipe(Effect.provideService(HttpClient.HttpClient, browserOrigin(client)), Effect.result)
    expect(Result.isFailure(result) && result.failure.message).toContain("expired")
    expect(methods).toEqual(["PUT"])
  }))
})
