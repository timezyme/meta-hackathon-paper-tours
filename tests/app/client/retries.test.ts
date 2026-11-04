import { describe, expect, it } from "@effect/vitest"
import { afterEach, vi } from "vitest"
import { Effect, Result, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { IdempotencyKey, RunId, RunState, UserId } from "../../../src/domain/index.ts"
import { retryDocument } from "../../../src/app/client/documents.ts"
import { prepareRetryAttempt, readRetryAttempt } from "../../../src/app/client/retries.ts"
import { retryEligibility } from "../../../src/app/documents.ts"
import { appReaderFixture } from "../reader-fixture.ts"

const identity = { documentId: appReaderFixture.canonical.scope.documentId, ownerId: Schema.decodeUnknownSync(UserId)("reader-owner"), previousRunId: appReaderFixture.canonical.scope.runId }
const key = Schema.decodeUnknownSync(IdempotencyKey)("retry-key-0123456789")
const anotherRun = Schema.decodeUnknownSync(RunId)("another-run")
const body = { previousRunId: identity.previousRunId, acknowledgePossibleRepeatedWork: true }
const browserOrigin = (client: HttpClient.HttpClient) => HttpClient.mapRequest(client, HttpClientRequest.prependUrl("http://reader.example.test"))
const run = (state: unknown) => ({ state: Schema.decodeUnknownSync(RunState)(state) })
afterEach(() => vi.unstubAllGlobals())

describe("explicit document retry", () => {
  it.effect("sends the exact confirmation and key once and accepts only the new document run", () => Effect.gen(function* () {
    const requests: Array<HttpClientRequest.HttpClientRequest> = []
    const client = HttpClient.make((request) => { requests.push(request); return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ documentId: identity.documentId, runId: "retry-run" }, { status: 202 }))) })
    const accepted = yield* retryDocument(identity.documentId, body, key).pipe(Effect.provideService(HttpClient.HttpClient, browserOrigin(client)))
    expect(accepted.runId).toBe("retry-run")
    expect(requests).toHaveLength(1)
    const request = requests[0]
    expect(request?.method).toBe("POST")
    expect(request?.url).toBe(`http://reader.example.test/api/documents/${identity.documentId}/retry`)
    expect(request?.headers["idempotency-key"]).toBe(key)
    expect(request?.body._tag === "Uint8Array" && new TextDecoder().decode(request.body.body)).toBe(JSON.stringify(body))
  }))
  for (const response of [{ documentId: "other-document", runId: "retry-run" }, { documentId: identity.documentId, runId: identity.previousRunId }]) it.effect("rejects mismatched accepted identity without a second send", () => Effect.gen(function* () {
    let calls = 0
    const client = HttpClient.make((request) => { calls += 1; return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(response, { status: 202 }))) })
    const result = yield* retryDocument(identity.documentId, body, key).pipe(Effect.provideService(HttpClient.HttpClient, browserOrigin(client)), Effect.result)
    expect(Result.isFailure(result) && result.failure.kind).toBe("invalid-response")
    expect(calls).toBe(1)
  }))
  for (const status of [409, 503]) it.effect(`keeps a ${status} refusal explicit with no automatic mutation retry`, () => Effect.gen(function* () {
    let calls = 0
    const client = HttpClient.make((request) => { calls += 1; return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ code: "conflict", message: "Check the current run." }, { status }))) })
    const result = yield* retryDocument(identity.documentId, body, key).pipe(Effect.provideService(HttpClient.HttpClient, browserOrigin(client)), Effect.result)
    expect(Result.isFailure(result) && result.failure.status).toBe(status)
    expect(calls).toBe(1)
  }))
  it.effect("persists the first exact submission for repeated explicit attempts", () => Effect.gen(function* () {
    const values = new Map<string, string>()
    vi.stubGlobal("sessionStorage", { getItem: (name: string) => values.get(name) ?? null, setItem: (name: string, value: string) => values.set(name, value) })
    const first = yield* prepareRetryAttempt(identity, true)
    expect(yield* prepareRetryAttempt(identity, false)).toEqual(first)
    expect(yield* readRetryAttempt(identity)).toEqual(first)
    expect(values.size).toBe(1)
    expect(yield* readRetryAttempt({ ...identity, previousRunId: anotherRun })).toBeNull()
  }))
  it.effect("rejects stored identifiers belonging to another document", () => Effect.gen(function* () {
    vi.stubGlobal("sessionStorage", { getItem: () => JSON.stringify({ ownerId: identity.ownerId, documentId: "other-document", key, request: body }) })
    const result = yield* readRetryAttempt(identity).pipe(Effect.result)
    expect(Result.isFailure(result) && result.failure.kind).toBe("rejected")
  }))
  it("offers retry only for the projected eligible terminal failure", () => {
    const failure = { code: "provider-failed", message: "Saved failure", retryable: true, stage: "page-check", pageId: null, figureId: null }
    expect(retryEligibility(run({ _tag: "queued" }))).toBe("unavailable")
    for (const _tag of ["failed", "interrupted"]) {
      expect(retryEligibility(run({ _tag, finishedAt: "2026-10-27T12:00:00.000Z", failure }))).toBe("retryable")
      expect(retryEligibility(run({ _tag, finishedAt: "2026-10-27T12:00:00.000Z", failure: { ...failure, retryable: false } }))).toBe("unavailable")
      expect(retryEligibility(run({ _tag, finishedAt: "2026-10-27T12:00:00.000Z", failure: { ...failure, code: "provider-unknown-completion" } }))).toBe("unknown-completion")
    }
  })
})
