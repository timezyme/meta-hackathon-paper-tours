import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Clock, Crypto, Deferred, Effect, Fiber, FileSystem, Layer, Path, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientResponse, type HttpClientRequest } from "effect/http"
import { TestClock } from "effect/testing"
import { StageReceipt } from "../../../src/domain/index.ts"
import { AttemptInput, AttemptIntent, executionFailure, makeProviderGuardLayer, ProviderAdapter, ProviderGuard, type GuardPolicy, type ProviderCall } from "../../../src/processing/index.ts"
import { Admission, DocumentStore, makeDocumentStoreLayer, StorageDatabase } from "../../../src/storage/index.ts"
import { makeMineruBoundary, MineruArchiveReader, MineruEnvelope, type MineruBoundaryOptions } from "../../../src/paper/providers/mineru/index.ts"

const endpoint = "https://amuseme-offline.invalid"
const jobId = "11111111-2222-4333-8444-555555555555"
const timestamp = "2026-10-27T00:00:00.000Z"
const source = new TextEncoder().encode("%PDF-1.7 offline transport fixture")
const policy: GuardPolicy = { mode: "fixture", enabled: true, metaCredentialConfigured: false, mineruCredentialConfigured: false, mineruEndpoint: null, budgetId: "mineru-offline", authorizedBudgetMicrousd: 10, maximumCostMicrousd: { extraction: 1, "page-check": 1, headings: 1, figures: 1 }, maxConcurrentCalls: 1, maxOutputTokens: 1000, maxRequestBytes: 4096, maxResponseBytes: 4096, callDeadlineMilliseconds: 1_500_000 }
const model = { provider: "fixture", model: "offline", reasoning: "high", promptName: "offline", promptVersion: "1", maxOutputTokens: 1000 }
const response = (request: HttpClientRequest.HttpClientRequest, body: string | Uint8Array, status = 200, media = "application/json", headers: Record<string, string> = {}) => HttpClientResponse.fromWeb(request, new Response(typeof body === "string" ? body : new Uint8Array(body), { status, headers: { "content-type": media, ...headers } }))
const disconnected = (request: HttpClientRequest.HttpClientRequest) => new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, description: "Offline connection loss" }) })
const recovered = (receipt: StageReceipt) => ({ ...receipt, state: { _tag: "unknown-completion" as const, observedAt: timestamp, providerRequestId: receipt.id, reason: "Lost acknowledgement" } })
const setup = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const digest = Array.from(yield* crypto.digest("SHA-256", source), (value) => value.toString(16).padStart(2, "0")).join("")
  const receipt = yield* Schema.decodeUnknownEffect(StageReceipt)({ id: jobId, ownerId: "mineru-owner", scope: { documentId: "mineru-document", runId: "mineru-run", sourceHash: digest }, stage: "extraction", pageIds: [], figureId: null, requestFingerprint: "a".repeat(64), inputHashes: [digest], pipelineVersion: "1", schemaVersion: "1", configuration: { _tag: "extraction", provider: "mineru", version: "4.0.12" }, preparedAt: timestamp, state: { _tag: "prepared" } })
  const intent = yield* Schema.decodeUnknownEffect(AttemptIntent)({ request: { provider: "mineru", version: "4.0.12", source: { path: "source.pdf", byteCount: source.byteLength, hash: digest } }, clientIdempotencyKey: jobId, maximumCostMicrousd: 1, maxOutputTokens: null, maxResponseBytes: 4096, deadlineAt: (yield* Clock.currentTimeMillis) + 2_000_000, retry: { _tag: "none" } })
  const archive = yield* fs.readFile(path.resolve("tests/paper/mineru/fixtures/seaborn-download.zip"))
  const temporary = yield* fs.makeTempDirectoryScoped({ directory: path.resolve("data"), prefix: "mineru-transport-tests-" })
  const reader = yield* MineruArchiveReader.pipe(Effect.provide(MineruArchiveReader.layer({ pythonBin: path.resolve("data/python/.venv/bin/python"), tempDirectory: temporary })))
  const events: Array<string> = []
  const saved = new Map<string, Uint8Array>()
  const options: MineruBoundaryOptions = {
    endpoint, token: Redacted.make("offline-secret"),
    readSource: (value) => Effect.sync(() => { expect(value).toEqual(receipt); events.push("read-source"); return source }),
    saveArchive: (value, artifact, bytes) => Effect.sync(() => { expect(value.id).toBe(receipt.id); events.push("save-archive"); saved.set(artifact.hash, bytes) }),
    readArchive: (value, artifact) => Effect.gen(function* () { expect(value.id).toBe(receipt.id); events.push("read-archive"); const bytes = saved.get(artifact.hash); return bytes === undefined ? yield* executionFailure("provider-failed", "Missing private artifact") : bytes }),
  }
  const call: ProviderCall = { attemptId: receipt.id, receipt, intent, submitted: (id) => Effect.sync(() => { expect(id).toBe(jobId); events.push("submitted") }) }
  const make = (client: HttpClient.HttpClient, overrides: Partial<MineruBoundaryOptions> = {}) => makeMineruBoundary({ ...options, ...overrides }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.provideService(MineruArchiveReader, reader))
  return { receipt, call, archive, events, saved, make, digest }
})

describe("MinerU HTTP transport", () => {
  it.effect("persists the UUID before POST, polls 202, saves exact ZIP bytes before returning a small JSON receipt", () => Effect.gen(function* () {
    const f = yield* setup()
    const pending = yield* Deferred.make<void>()
    let polls = 0
    const boundary = yield* f.make(HttpClient.make((req, url) => Effect.gen(function* () {
      expect(url.href).toBe(`${endpoint}/jobs/${jobId}`)
      expect(req.headers.authorization).toBe("Bearer offline-secret")
      expect(yield* Effect.serviceOption(FetchHttpClient.RequestInit)).toMatchObject({ _tag: "Some", value: { redirect: "error" } })
      f.events.push(req.method)
      if (req.method === "POST") {
        expect(f.events).toEqual(["read-source", "submitted", "POST"])
        expect(req.body._tag).toBe("Uint8Array")
        if (req.body._tag === "Uint8Array") expect(req.body.body).toEqual(source)
        return response(req, JSON.stringify({ callId: jobId }))
      }
      polls += 1
      if (polls === 1) { yield* Deferred.succeed(pending, undefined); return response(req, "", 202) }
      return response(req, f.archive, 200, "application/zip")
    })))
    const fiber = yield* boundary.adapter.invoke(f.call).pipe(Effect.forkChild)
    yield* Deferred.await(pending)
    yield* TestClock.adjust("2 seconds")
    const result = yield* Fiber.join(fiber)
    expect(f.events).toEqual(["read-source", "submitted", "POST", "GET", "GET", "save-archive"])
    expect(new TextEncoder().encode(JSON.stringify(result.response)).byteLength).toBeLessThan(1000)
    const envelope = yield* Schema.decodeUnknownEffect(MineruEnvelope)(result.response)
    expect(envelope).toMatchObject({ status: "archive", jobId, ownerId: f.receipt.ownerId, scope: f.receipt.scope, artifact: { byteCount: 330659, hash: "0e0509599ee9dd8fc52bb85f2c395546c8d2ba83273d58a16296e53a8d2fc8fc" } })
    expect(result.actualCostMicrousd).toBeNull()
    yield* boundary.adapter.validate(result.response, f.receipt)
    expect(f.events.at(-1)).toBe("read-archive")
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("recovers a lost POST response using the same UUID and zero further POSTs, including a new boundary", () => Effect.gen(function* () {
    const f = yield* setup()
    const methods: Array<string> = []
    const client = HttpClient.make((req) => Effect.suspend(() => {
      methods.push(req.method)
      return req.method === "POST" ? Effect.fail(disconnected(req)) : Effect.succeed(response(req, f.archive, 200, "application/zip"))
    }))
    const boundary = yield* f.make(client)
    expect(yield* Effect.result(boundary.adapter.invoke(f.call))).toMatchObject({ _tag: "Failure", failure: { certainty: "unknown" } })
    expect(f.events).toEqual(["read-source", "submitted"])
    yield* boundary.adapter.invoke(f.call)
    yield* boundary.retrieve(recovered(f.receipt))
    const restarted = yield* f.make(client)
    yield* restarted.adapter.invoke({ ...f.call, receipt: recovered(f.receipt) })
    expect(methods).toEqual(["POST", "GET", "GET", "GET"])
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  for (const mode of ["success", "lost-response"] as const) {
    it.effect(`persists ${mode} through the actual provider guard without large SQLite responses or duplicate dispatch`, () => Effect.gen(function* () {
      const f = yield* setup()
      const fs = yield* FileSystem.FileSystem
      const settings = { dataDirectory: yield* fs.makeTempDirectoryScoped(), queueLimit: 1 }
      yield* Effect.gen(function* () {
        const store = yield* DocumentStore
        yield* store.admit(yield* Schema.decodeUnknownEffect(Admission)({ ownerId: "guarded-owner", idempotencyKey: "guarded-upload", originalFilename: "source.pdf", bytes: source, pageCount: 1, pipelineVersion: "1", configuration: { extractionProvider: "mineru", extractionVersion: "4.0.12", pageCheck: model, headings: model, figures: model, maxProviderAttempts: 1, deadlineMilliseconds: 5_000_000, spendingCapUsd: 1 } }))
        const claimed = yield* store.claimNext({ workerId: "mineru-test", leaseMilliseconds: 2_000_000 })
        if (claimed === null) return yield* Effect.die("Expected durable claim")
        const db = yield* StorageDatabase
        const rows = () => db.query("mineru-test-attempts", () => db.db.selectFrom("provider_attempts").selectAll().execute())
        const methods: Array<string> = []
        const boundary = yield* f.make(HttpClient.make((req) => Effect.gen(function* () {
          methods.push(req.method)
          const row = (yield* rows().pipe(Effect.orDie))[0]
          expect(row?.remote_id).toBe(row?.id)
          if (req.method === "POST") {
            expect(row?.status).toBe("submitted")
            if (mode === "lost-response") return yield* disconnected(req)
            return response(req, JSON.stringify({ callId: row?.id }))
          }
          return response(req, f.archive, 200, "application/zip")
        })), { readSource: () => Effect.succeed(source), saveArchive: (_receipt, artifact, bytes) => Effect.sync(() => { f.saved.set(artifact.hash, bytes) }), readArchive: (_receipt, artifact) => Effect.gen(function* () { const bytes = f.saved.get(artifact.hash); return bytes ?? (yield* executionFailure("provider-failed", "Missing archive")) }) })
        const guard = yield* ProviderGuard
        const input = yield* Schema.decodeUnknownEffect(AttemptInput)({ stage: "extraction", pageIds: [], figureId: null, inputHashes: [f.digest], request: f.call.intent.request, supportsIdempotency: false, retry: { _tag: "none" } })
        const outcome = yield* Effect.result(guard.execute(claimed, input).pipe(Effect.provideService(ProviderAdapter, boundary.adapter)))
        const row = (yield* rows())[0]
        expect(row).toMatchObject({ status: mode === "success" ? "completed" : "unknown", actual_microusd: null, reserved_microusd: 1 })
        const replay = yield* Effect.result(guard.execute(claimed, input).pipe(Effect.provideService(ProviderAdapter, boundary.adapter)))
        if (mode === "success") {
          expect(outcome).toMatchObject({ _tag: "Success", success: { delivery: "performed" } })
          expect(replay).toMatchObject({ _tag: "Success", success: { delivery: "reused" } })
          expect(row?.response_json?.length).toBeLessThan(1000)
          expect(row?.validation_state).toBe("accepted")
        } else {
          expect(outcome).toMatchObject({ _tag: "Failure" }); expect(replay).toMatchObject({ _tag: "Failure" })
          expect(row?.response_json).toBeNull()
          yield* TestClock.adjust(2_000_001)
          yield* guard.reconcile()
          yield* store.recoverExpiredClaims()
          const resumed = yield* store.claimNext({ workerId: "restarted-worker", leaseMilliseconds: 2_000_000 })
          if (resumed === null) return yield* Effect.die("Expected safe MinerU recovery")
          expect(resumed.recovered).toBe(true)
          expect(resumed.run.id).toBe(claimed.run.id)
          const recoveredResult = yield* guard.execute(resumed, input).pipe(Effect.provideService(ProviderAdapter, boundary.adapter))
          expect(recoveredResult.receipt.id).toBe(row?.id)
          expect((yield* rows())[0]?.status).toBe("completed")
          expect(yield* rows()).toHaveLength(1)
          expect(yield* db.query("charges", () => db.db.selectFrom("provider_charges").selectAll().execute())).toHaveLength(1)
        }
        expect(methods).toEqual(["POST", "GET"])
      }).pipe(Effect.provide(makeProviderGuardLayer(policy).pipe(Layer.provideMerge(makeDocumentStoreLayer(settings)))))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
  }

  it.effect("concurrent duplicate invokes send one POST", () => Effect.gen(function* () {
    const f = yield* setup()
    const methods: Array<string> = []
    const boundary = yield* f.make(HttpClient.make((req) => Effect.sync(() => { methods.push(req.method); return req.method === "POST" ? response(req, JSON.stringify({ callId: jobId })) : response(req, f.archive, 200, "application/zip") })))
    yield* Effect.all([boundary.adapter.invoke(f.call), boundary.adapter.invoke(f.call)], { concurrency: "unbounded" })
    expect(methods.filter((method) => method === "POST")).toHaveLength(1)
    expect(f.events.filter((event) => event === "submitted")).toHaveLength(1)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("applies the request deadline to a stalled response body and cancels its stream", () => Effect.gen(function* () {
    const f = yield* setup()
    const started = yield* Deferred.make<void>()
    let canceled = false
    const boundary = yield* f.make(HttpClient.make((req) => Deferred.succeed(started, undefined).pipe(Effect.as(HttpClientResponse.fromWeb(req, new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true } }), { headers: { "content-type": "application/zip" } }))))))
    const fiber = yield* Effect.result(boundary.retrieve(recovered(f.receipt))).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* TestClock.adjust("60 seconds")
    expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "Failure", failure: { certainty: "unknown" } })
    expect(canceled).toBe(true)
    expect(f.saved.size).toBe(0)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("rejects invalid source descriptors and actual bytes before recording submission", () => Effect.gen(function* () {
    const f = yield* setup()
    let sends = 0
    const client = HttpClient.make((req) => Effect.sync(() => { sends += 1; return response(req, "") }))
    for (const request of [
      { provider: "mineru", version: "4.0.12", source: { path: "source.pdf", byteCount: source.byteLength + 1, hash: f.digest } },
      { provider: "mineru", version: "4.0.12", source: { path: "source.pdf", byteCount: source.byteLength, hash: "f".repeat(64) } },
      { provider: "mineru", version: "4.0.12", source: { path: "source.pdf", byteCount: 50 * 1024 * 1024 + 1, hash: f.digest } },
    ]) {
      const boundary = yield* f.make(client)
      expect(yield* Effect.result(boundary.adapter.invoke({ ...f.call, intent: { ...f.call.intent, request } }))).toMatchObject({ _tag: "Failure", failure: { certainty: "not-submitted" } })
    }
    const wrongBytes = new Uint8Array(source); wrongBytes[10] = 0
    const wrong = yield* f.make(client, { readSource: () => Effect.succeed(wrongBytes) })
    expect(yield* Effect.result(wrong.adapter.invoke(f.call))).toMatchObject({ _tag: "Failure", failure: { certainty: "not-submitted" } })
    const failedSave = yield* f.make(client)
    expect(yield* Effect.result(failedSave.adapter.invoke({ ...f.call, submitted: () => Effect.fail(executionFailure("provider-failed", "Cannot persist submission")) }))).toMatchObject({ _tag: "Failure" })
    expect(sends).toBe(0)
    expect(f.events).not.toContain("submitted")
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("requires an explicit endpoint and a saved matching job state for GET recovery", () => Effect.gen(function* () {
    const f = yield* setup()
    let sends = 0
    const client = HttpClient.make((req) => Effect.sync(() => { sends += 1; return response(req, "") }))
    for (const invalid of ["", "http://offline.invalid", "https://user:secret@offline.invalid", "https://foreign-service.invalid", "https://amuseme-offline.invalid.attacker.example", "https://amuseme-offline.invalid@foreign.invalid", "https://offline.invalid?token=x"]) expect(yield* Effect.result(f.make(client, { endpoint: invalid }))).toMatchObject({ _tag: "Failure", failure: { certainty: "not-submitted" } })
    const boundary = yield* f.make(client)
    for (const receipt of [f.receipt, { ...recovered(f.receipt), state: { ...recovered(f.receipt).state, providerRequestId: "different" } }]) expect(yield* Effect.result(boundary.retrieve(receipt))).toMatchObject({ _tag: "Failure", failure: { certainty: "not-submitted" } })
    expect(sends).toBe(0)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("treats a remote tombstone as permanent and never submits during retrieval", () => Effect.gen(function* () {
    const f = yield* setup()
    const methods: Array<string> = []
    for (const status of [404, 410, 503]) {
      const boundary = yield* f.make(HttpClient.make((req) => Effect.sync(() => { methods.push(req.method); return response(req, "", status) })))
      const result = yield* Effect.result(boundary.retrieve(recovered(f.receipt)))
      if (status === 410) {
        expect(result).toMatchObject({ _tag: "Success", success: { response: { status: "failed", reason: "remote-expired" } } })
        if (result._tag === "Success") expect(yield* Effect.result(boundary.adapter.validate(result.success.response, f.receipt))).toMatchObject({ _tag: "Failure", failure: { code: "invalid-provider-response" } })
      } else expect(result).toMatchObject({ _tag: "Failure", failure: { certainty: "unknown" } })
    }
    expect(methods).toEqual(["GET", "GET", "GET"])
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  for (const mode of ["abort", "request-timeout", "poll-timeout"] as const) {
    it.effect(`bounds ${mode} and never repeats submission`, () => Effect.gen(function* () {
      const f = yield* setup()
      const started = yield* Deferred.make<void>()
      let signal: AbortSignal | undefined
      const methods: Array<string> = []
      const boundary = yield* f.make(HttpClient.make((req, _url, abort) => Effect.gen(function* () {
        methods.push(req.method); signal = abort
        if (mode === "poll-timeout") {
          yield* Deferred.succeed(started, undefined)
          return req.method === "POST" ? response(req, JSON.stringify({ callId: jobId })) : response(req, "", 202)
        }
        yield* Deferred.succeed(started, undefined)
        return yield* Effect.never
      })))
      const fiber = yield* Effect.result(boundary.adapter.invoke(f.call)).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      if (mode === "abort") yield* Fiber.interrupt(fiber)
      else {
        yield* TestClock.adjust(mode === "request-timeout" ? "60 seconds" : "1500 seconds")
        expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "Failure", failure: { certainty: "unknown" } })
      }
      if (mode !== "poll-timeout") expect(signal?.aborted).toBe(true)
      expect(methods.filter((method) => method === "POST")).toHaveLength(1)
      expect(f.events).toContain("submitted")
      expect(f.events).not.toContain("save-archive")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
  }

  it.effect("rejects redirect, truncated, oversized and interrupted results without saving partial bytes", () => Effect.gen(function* () {
    const f = yield* setup()
    const cases = [
      (req: HttpClientRequest.HttpClientRequest) => response(req, "", 302),
      (req: HttpClientRequest.HttpClientRequest) => response(req, f.archive, 200, "application/zip", { "content-length": String(f.archive.byteLength + 1) }),
      (req: HttpClientRequest.HttpClientRequest) => response(req, "", 200, "application/zip", { "content-length": String(50 * 1024 * 1024 + 1) }),
      (req: HttpClientRequest.HttpClientRequest) => response(req, new Uint8Array(50 * 1024 * 1024 + 1), 200, "application/zip"),
      (req: HttpClientRequest.HttpClientRequest) => HttpClientResponse.fromWeb(req, new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("Offline interrupted response")) } }), { headers: { "content-type": "application/zip" } })),
    ]
    for (const reply of cases) {
      let sends = 0
      const boundary = yield* f.make(HttpClient.make((req) => Effect.sync(() => { sends += 1; return reply(req) })))
      expect(yield* Effect.result(boundary.retrieve(recovered(f.receipt)))).toMatchObject({ _tag: "Failure" })
      expect(sends).toBe(1)
    }
    expect(f.saved.size).toBe(0)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("validates saved owner, scope, job identity and exact bytes before decoding", () => Effect.gen(function* () {
    const f = yield* setup()
    const boundary = yield* f.make(HttpClient.make((req) => Effect.succeed(response(req, f.archive, 200, "application/zip"))))
    const result = yield* boundary.retrieve(recovered(f.receipt))
    const envelope = yield* Schema.decodeUnknownEffect(MineruEnvelope)(result.response)
    for (const invalid of [{ ...envelope, ownerId: "another-owner" }, { ...envelope, scope: { ...envelope.scope, runId: "another-run" } }, { ...envelope, jobId: "66666666-2222-4333-8444-555555555555" }]) expect(yield* Effect.result(boundary.adapter.validate(invalid, f.receipt))).toMatchObject({ _tag: "Failure", failure: { code: "invalid-provider-response" } })
    if (envelope.status !== "archive") return yield* Effect.die("Expected saved ZIP")
    f.saved.set(envelope.artifact.hash, new Uint8Array(f.archive.byteLength))
    expect(yield* Effect.result(boundary.adapter.validate(result.response, f.receipt))).toMatchObject({ _tag: "Failure", failure: { code: "invalid-provider-response" } })
    const invalid = yield* f.make(HttpClient.make((req) => Effect.succeed(response(req, "invalid ZIP", 200, "application/zip"))))
    const saved = yield* invalid.retrieve(recovered(f.receipt))
    expect(f.saved.size).toBe(2)
    expect(yield* Effect.result(invalid.adapter.validate(saved.response, f.receipt))).toMatchObject({ _tag: "Failure", failure: { code: "invalid-provider-response" } })
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("saves definite remote failure as JSON and refuses it during validation", () => Effect.gen(function* () {
    const f = yield* setup()
    for (const status of [200, 403]) {
      const boundary = yield* f.make(HttpClient.make((req) => Effect.succeed(response(req, status === 200 ? JSON.stringify({ status: "failed" }) : "Forbidden", status))))
      const result = status === 200 ? yield* boundary.retrieve(recovered(f.receipt)) : yield* boundary.adapter.invoke(f.call)
      expect(result.response).toMatchObject({ status: "failed", reason: status === 200 ? "remote-failed" : "request-rejected" })
      expect(yield* Effect.result(boundary.adapter.validate(result.response, f.receipt))).toMatchObject({ _tag: "Failure", failure: { code: "invalid-provider-response" } })
    }
    expect(f.saved.size).toBe(0)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
