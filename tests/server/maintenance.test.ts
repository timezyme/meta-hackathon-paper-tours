import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { SpanType } from "@mastra/core/observability"
import type { WorkflowRunState } from "@mastra/core/workflows"
import { DateTime, Deferred, Effect, Fiber, FileSystem, Path, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http"
import { TestClock } from "effect/testing"
import { makeDocumentMaintenance } from "../../src/server/maintenance.ts"
import { makeDocumentRetention, RetentionFailure } from "../../src/server/retention.ts"
import { Admission, DocumentStore, StorageDatabase, makeDocumentStoreLayer } from "../../src/storage/index.ts"
import { contractFixture } from "../fixtures/contracts.ts"
import { localTraceFixture } from "../fixtures/local-observability.ts"

const remote = { endpoint: "https://amuseme-cleanup.invalid", token: Redacted.make("private-cleanup-token") }
const job = (index: number) => `11111111-2222-4333-8444-${String(index).padStart(12, "0")}`
const snapshot = (runId: string): WorkflowRunState => ({ runId, status: "success", value: {}, context: {}, serializedStepGraph: [], activePaths: [], activeStepsPath: {}, suspendedPaths: {}, resumeLabels: {}, waitingPaths: {}, timestamp: 1 })
const response = (request: HttpClientRequest.HttpClientRequest, status: number, body: string | null = null, headers: Record<string, string> = {}) => HttpClientResponse.fromWeb(request, new Response(body, { status, headers }))
const settings = Effect.gen(function* () { const fs = yield* FileSystem.FileSystem; return { dataDirectory: yield* fs.makeTempDirectoryScoped(), queueLimit: 5, retentionMilliseconds: 10_000 } })
const document = Effect.fnUntraced(function* (key = "one") {
  const fs = yield* FileSystem.FileSystem
  const store = yield* DocumentStore
  yield* store.admit(yield* Schema.decodeUnknownEffect(Admission)({ ownerId: `owner-${key}`, idempotencyKey: `upload-${key}`, bytes: yield* fs.readFile(new URL("../fixtures/normal.pdf", import.meta.url).pathname), originalFilename: "normal.pdf", pageCount: 1, pipelineVersion: "1", configuration: contractFixture().run.configuration }))
  const claim = yield* store.claimNext({ workerId: "cleanup-fixture", leaseMilliseconds: 1000 })
  if (claim === null || claim.run.mastraRunId === null) return yield* Effect.die("Expected local run")
  yield* store.updateRun(claim, { _tag: "failed", finishedAt: DateTime.formatIso(yield* DateTime.now), failure: { code: "provider-failed", message: "Offline fixture", retryable: false, stage: null, pageId: null, figureId: null } })
  return { document: claim.document, runId: claim.run.mastraRunId }
})
const queue = Effect.fnUntraced(function* (documentId: string, ids: ReadonlyArray<string>) {
  const { db, query } = yield* StorageDatabase
  for (const jobId of ids) yield* query("fixture", () => db.insertInto("remote_cleanup").values({ job_id: jobId, document_id: documentId, created_at: 1 }).execute())
})
const pending = Effect.gen(function* () { const { db, query } = yield* StorageDatabase; return yield* query("fixture", () => db.selectFrom("remote_cleanup").selectAll().orderBy("job_id").execute()) })
const emptyPurge = () => Effect.succeed({ traceCount: 0, snapshotCount: 0 })

describe("periodic private document maintenance", () => {
  it.effect("expires files and real traces/snapshots while preserving active documents and the spending ledger", () => Effect.gen(function* () {
    const options = yield* settings
    const { storage, mastra, instance, traces, workflows } = yield* localTraceFixture
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const first = yield* document("expired")
      yield* TestClock.adjust(5001)
      const other = yield* document("active")
      for (const entry of [first, other]) {
        instance.startSpan({ type: SpanType.WORKFLOW_RUN, name: "normalize-document", metadata: { documentId: entry.document.id, resourceId: entry.document.ownerId, runId: entry.runId } }).end()
        yield* Effect.promise(() => workflows.persistWorkflowSnapshot({ workflowName: "normalize-document", runId: entry.runId, resourceId: entry.document.ownerId, snapshot: snapshot(entry.runId) }))
      }
      yield* queue(first.document.id, [job(1)])
      const { db, query } = yield* StorageDatabase
      const charge = { attempt_id: job(1), budget_id: "original-budget", reserved_microusd: 100_000, actual_microusd: 50_000 }
      yield* query("fixture", () => db.insertInto("provider_charges").values(charge).execute())
      yield* TestClock.adjust(5000)
      const maintenance = yield* makeDocumentMaintenance({ purge: makeDocumentRetention(storage, () => mastra.observability.flush()).purge, mineru: remote })
      expect(yield* maintenance.runOnce()).toMatchObject({ reconciliationFailed: false, documentsPurged: 1, localFailures: 0, remoteDeleted: 1, remotePending: 0 })
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      expect(yield* fs.exists(path.join(options.dataDirectory, "documents", first.document.id))).toBe(false)
      expect(yield* fs.exists(path.join(options.dataDirectory, "documents", other.document.id))).toBe(true)
      expect(yield* Effect.result(store.detail(first.document.ownerId, first.document.id))).toMatchObject({ _tag: "Failure", failure: { code: "not-found" } })
      expect((yield* store.detail(other.document.ownerId, other.document.id)).document.id).toBe(other.document.id)
      expect(yield* Effect.promise(() => workflows.getWorkflowRunById({ workflowName: "normalize-document", runId: first.runId }))).toBeNull()
      expect(yield* Effect.promise(() => workflows.getWorkflowRunById({ workflowName: "normalize-document", runId: other.runId }))).not.toBeNull()
      expect((yield* Effect.promise(() => traces.listTraces({ filters: { resourceId: first.document.ownerId } }))).spans).toEqual([])
      expect((yield* Effect.promise(() => traces.listTraces({ filters: { resourceId: other.document.ownerId } }))).spans).toHaveLength(1)
      expect(yield* query("fixture", () => db.selectFrom("provider_charges").selectAll().execute())).toEqual([charge])
      expect(yield* query("fixture", () => db.selectFrom("documents").select("id").where("lifecycle", "=", "expired").execute())).toHaveLength(1)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)), Effect.provideService(HttpClient.HttpClient, HttpClient.make((req) => Effect.gen(function* () {
      expect(req.method).toBe("DELETE")
      expect(req.headers.authorization).toBe("Bearer private-cleanup-token")
      expect(req.url).toBe(`${remote.endpoint}/jobs/${job(1)}`)
      expect(yield* Effect.serviceOption(FetchHttpClient.RequestInit)).toMatchObject({ _tag: "Some", value: { redirect: "error" } })
      return response(req, 204)
    }))))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("retains failed local and remote cleanup and completes both after reopening the database", () => Effect.gen(function* () {
    const options = yield* settings
    const { storage, mastra, instance, workflows } = yield* localTraceFixture
    const saved = yield* Effect.gen(function* () {
      const first = yield* document()
      instance.startSpan({ type: SpanType.WORKFLOW_RUN, name: "normalize-document", metadata: { documentId: first.document.id, resourceId: first.document.ownerId, runId: first.runId } }).end()
      yield* Effect.promise(() => workflows.persistWorkflowSnapshot({ workflowName: "normalize-document", runId: first.runId, resourceId: first.document.ownerId, snapshot: snapshot(first.runId) }))
      yield* queue(first.document.id, [job(1)])
      yield* (yield* DocumentStore).delete(first.document.ownerId, first.document.id)
      const maintenance = yield* makeDocumentMaintenance({ purge: () => Effect.fail(new RetentionFailure({ operation: "flush", message: "Local flush unavailable" })), mineru: remote })
      expect(yield* maintenance.runOnce()).toMatchObject({ localFailures: 1, remoteDeleted: 0, remotePending: 1 })
      return first
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)), Effect.provideService(HttpClient.HttpClient, HttpClient.make((req) => Effect.succeed(response(req, 503)))))
    yield* Effect.gen(function* () {
      expect(yield* pending).toHaveLength(1)
      const maintenance = yield* makeDocumentMaintenance({ purge: makeDocumentRetention(storage, () => mastra.observability.flush()).purge, mineru: remote })
      expect(yield* maintenance.runOnce()).toMatchObject({ documentsPurged: 1, remoteDeleted: 1, remotePending: 0 })
      expect(yield* Effect.promise(() => workflows.getWorkflowRunById({ workflowName: "normalize-document", runId: saved.runId }))).toBeNull()
      expect(yield* maintenance.runOnce()).toMatchObject({ documentsPurged: 1, remoteAttempted: 0 })
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)), Effect.provideService(HttpClient.HttpClient, HttpClient.make((req) => Effect.succeed(response(req, 404)))))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("advances both batches past repeated older failures without dropping their durable records", () => Effect.gen(function* () {
    const options = yield* settings
    yield* Effect.gen(function* () {
      const ids: Array<string> = []
      const store = yield* DocumentStore
      for (let index = 1; index <= 11; index += 1) { const item = yield* document(String(index)); ids.push(item.document.id); yield* store.delete(item.document.ownerId, item.document.id) }
      yield* queue(ids[0] ?? "missing", Array.from({ length: 11 }, (_, index) => job(index + 1)))
      const latest = ids.toSorted().at(-1)
      const visited: Array<string> = []
      const maintenance = yield* makeDocumentMaintenance({ purge: (target) => Effect.suspend(() => {
        visited.push(target.documentId)
        return target.documentId === latest ? emptyPurge() : Effect.fail(new RetentionFailure({ operation: "traces", message: "Offline failure" }))
      }), mineru: remote })
      expect(yield* maintenance.runOnce()).toMatchObject({ documentsVisited: 10, localFailures: 10, remoteAttempted: 10, remoteDeleted: 0, remotePending: 11 })
      expect(yield* maintenance.runOnce()).toMatchObject({ documentsVisited: 1, documentsPurged: 1, remoteAttempted: 1, remoteDeleted: 1, remotePending: 10 })
      expect(new Set(visited).size).toBe(11)
      expect(yield* maintenance.runOnce()).toMatchObject({ documentsVisited: 10, localFailures: 10, remoteAttempted: 10, remoteDeleted: 0 })
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)), Effect.provideService(HttpClient.HttpClient, HttpClient.make((req) => Effect.succeed(response(req, req.url.endsWith(job(11)) ? 204 : 409)))))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("clears only 204/404 and retains rejection, redirects, invalid UUIDs and unbounded responses", () => Effect.gen(function* () {
    const options = yield* settings
    let sends = 0
    yield* Effect.gen(function* () {
      const item = yield* document()
      yield* queue(item.document.id, [...Array.from({ length: 8 }, (_, index) => job(index + 1)), "../invalid-job"])
      const maintenance = yield* makeDocumentMaintenance({ purge: emptyPurge, mineru: remote })
      expect(yield* maintenance.runOnce()).toMatchObject({ remoteAttempted: 9, remoteDeleted: 2, remotePending: 7 })
      expect((yield* pending).map((row) => row.job_id)).toEqual(["../invalid-job", ...Array.from({ length: 6 }, (_, index) => job(index + 3))])
      expect(sends).toBe(8)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)), Effect.provideService(HttpClient.HttpClient, HttpClient.make((req) => Effect.sync(() => {
      sends += 1
      const index = Number(req.url.slice(-12))
      if (index === 7) return response(req, 404, "oversized", { "content-length": "65537" })
      if (index === 8) return response(req, 404, "x".repeat(65537))
      return response(req, [204, 404, 409, 410, 503, 302][index - 1] ?? 500)
    }))))
  }).pipe(Effect.provide(NodeServices.layer)))

  for (const mode of ["deadline", "cancellation"] as const) {
    it.effect(`preserves cleanup on ${mode} and awaits HTTP interruption`, () => Effect.gen(function* () {
      const options = yield* settings
      const started = yield* Deferred.make<void>()
      let signal: AbortSignal | undefined
      yield* Effect.gen(function* () {
        const item = yield* document()
        yield* queue(item.document.id, [job(1)])
        const maintenance = yield* makeDocumentMaintenance({ purge: emptyPurge, mineru: remote })
        const fiber = yield* maintenance.runOnce().pipe(Effect.forkChild)
        yield* Deferred.await(started)
        if (mode === "deadline") { yield* TestClock.adjust("10 seconds"); expect(yield* Fiber.join(fiber)).toMatchObject({ remoteDeleted: 0, remotePending: 1 }) }
        else yield* Fiber.interrupt(fiber)
        expect(signal?.aborted).toBe(true)
        expect(yield* pending).toHaveLength(1)
      }).pipe(Effect.provide(makeDocumentStoreLayer(options)), Effect.provideService(HttpClient.HttpClient, HttpClient.make((_req, _url, abort) => Effect.gen(function* () { signal = abort; yield* Deferred.succeed(started, undefined); return yield* Effect.never }))))
    }).pipe(Effect.provide(NodeServices.layer)))
  }

  it.effect("continues local cleanup without remote credentials and refuses unsafe configuration", () => Effect.gen(function* () {
    const options = yield* settings
    let local = 0
    yield* Effect.gen(function* () {
      const item = yield* document()
      yield* queue(item.document.id, [job(1)])
      yield* (yield* DocumentStore).delete(item.document.ownerId, item.document.id)
      const purge = () => Effect.sync(() => { local += 1; return { traceCount: 0, snapshotCount: 0 } })
      const maintenance = yield* makeDocumentMaintenance({ purge, mineru: null })
      expect(yield* maintenance.runOnce()).toMatchObject({ documentsPurged: 1, remoteDisabled: true, remoteAttempted: 0, remotePending: 1 })
      expect(local).toBe(1)
      for (const endpoint of ["http://insecure.invalid", "https://user:secret@private.invalid", "https://foreign-service.invalid", "https://amuseme-cleanup.invalid.attacker.example", "https://amuseme-cleanup.invalid@foreign.invalid", "https://safe.invalid?token=private"]) {
        const result = yield* Effect.result(makeDocumentMaintenance({ purge, mineru: { ...remote, endpoint } }))
        expect(result).toMatchObject({ _tag: "Failure", failure: { operation: "configuration" } })
        expect(JSON.stringify(result)).not.toContain("private-cleanup-token")
      }
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)), Effect.provideService(HttpClient.HttpClient, HttpClient.make(() => Effect.die("No remote request is allowed"))))
  }).pipe(Effect.provide(NodeServices.layer)))
})
