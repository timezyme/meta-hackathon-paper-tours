import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { SpanType } from "@mastra/core/observability"
import { RequestContext } from "@mastra/core/request-context"
import { Mastra } from "@mastra/core/mastra"
import { LibSQLStore } from "@mastra/libsql"
import { Deferred, Effect, FileSystem, Path, Redacted, Scope } from "effect"
import { HttpClient } from "effect/http"
import { vi } from "vitest"
import { localTraceFixture } from "../fixtures/local-observability.ts"
import { makeAmuseMe } from "../../src/mastra/amuseme.ts"
import { startServer } from "../../src/server/lifecycle.ts"
import { makeDocumentRetention } from "../../src/server/retention.ts"
import { makeMetaAgentBoundary } from "../../src/paper/providers/meta/index.ts"
import { ProviderAdapter, ProviderGuard } from "../../src/processing/index.ts"
import { claim, request, response, settings, specs, storeLayer, validators } from "../paper/meta/fixtures.ts"

describe("local trace privacy", () => {
  it.live("correlates real guarded agent traces to their document and purges them without attempt records", () => Effect.gen(function* () {
    const options = yield* settings
    yield* Effect.gen(function* () {
      const { mastra, storage, traces } = yield* localTraceFixture
      const boundary = makeMetaAgentBoundary(specs)
      for (const [id, agent] of Object.entries(boundary.agents)) mastra.addAgent(agent, id)
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      const adapter = yield* boundary.makeAdapter({ credential: Redacted.make("offline-secret"), validators }).pipe(Effect.provideService(HttpClient.HttpClient, HttpClient.make((req) => Effect.succeed(response(req)))))
      const result = yield* guard.execute(owned, yield* request()).pipe(Effect.provideService(ProviderAdapter, adapter))
      yield* Effect.promise(() => mastra.observability.flush())
      const listed = yield* Effect.promise(() => traces.listTraces({ filters: { resourceId: owned.document.ownerId, metadata: { documentId: owned.document.id } } }))
      expect(listed.spans).toHaveLength(1)
      expect(listed.spans[0]?.metadata?.providerAttemptId).toBe(result.receipt.id)
      const saved = yield* Effect.promise(() => traces.getTrace({ traceId: listed.spans[0]!.traceId }))
      expect(JSON.stringify(saved)).not.toContain("α = 2")
      expect(JSON.stringify(saved)).not.toContain("offline-secret")
      expect(JSON.stringify(saved)).not.toContain("Repair extraction damage")
      expect(yield* makeDocumentRetention(storage, () => mastra.observability.flush()).purge({ documentId: owned.document.id, ownerId: owned.document.ownerId, mastraRunIds: [] })).toEqual({ traceCount: 1, snapshotCount: 0 })
    }).pipe(Effect.provide(storeLayer(options)))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("the real server initialization persists traces to the configured LibSQL store", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-server-trace-" })
    const mastra = new Mastra({ ...makeAmuseMe(0), logger: false })
    yield* startServer(mastra, { port: 0, origin: "http://127.0.0.1:4180", secret: Redacted.make("test-only-trace-secret-with-thirty-two-characters"), dataDirectory: path.join(directory, "data"), appDirectory: path.resolve(".mastra/output/app"), pythonBin: path.resolve("data/python/.venv/bin/python"), queueLimit: 1, admissionConfiguration: { _tag: "disabled", reason: "Trace test" }, processing: null })
    const instance = mastra.observability.getDefaultInstance()
    const storage = mastra.getStorage()
    if (instance === undefined || storage === undefined) return yield* Effect.die("Expected configured local storage")
    const span = instance.startSpan({ type: SpanType.WORKFLOW_RUN, name: "normalize-document", metadata: { runId: "server-run", resourceId: "server-owner" } })
    span.end()
    yield* Effect.promise(() => mastra.observability.flush())
    const traces = yield* Effect.promise(() => storage.getStore("observability"))
    expect(yield* Effect.promise(() => traces?.getTrace({ traceId: span.traceId }) ?? Promise.resolve(null))).not.toBeNull()
    expect([...mastra.observability.listInstances().keys()]).toEqual(["default"])
    expect(instance.getConfig().exporters).toHaveLength(1)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("production startup persists its executed workflow and redacted spans after reopening LibSQL", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-startup-persistence-" })
    const dataDirectory = path.join(directory, "data")
    const workflowRunId = "startup-persistence-run"
    yield* Effect.gen(function* () {
      const mastra = new Mastra({ ...makeAmuseMe(0), logger: false })
      const registration = yield* Effect.acquireRelease(Effect.sync(() => vi.spyOn(mastra, "addWorkflow")), (spy) => Effect.sync(() => spy.mockRestore()))
      const agentRegistration = yield* Effect.acquireRelease(Effect.sync(() => vi.spyOn(mastra, "addAgent")), (spy) => Effect.sync(() => spy.mockRestore()))
      yield* startServer(mastra, { port: 0, origin: "http://127.0.0.1:4180", secret: Redacted.make("test-only-persistence-secret-with-thirty-two-characters"), dataDirectory, appDirectory: path.resolve(".mastra/output/app"), pythonBin: path.resolve("data/python/.venv/bin/python"), queueLimit: 1, admissionConfiguration: { _tag: "disabled", reason: "Persistence test" }, processing: null })
      const workflow = registration.mock.calls.find(([, key]) => key === "normalize-document")?.[0]
      if (workflow === undefined) return yield* Effect.die("Expected the production runtime workflow")
      expect(mastra.getWorkflow("normalize-document")).toBe(workflow)
      expect(agentRegistration.mock.calls.map(([, id]) => id)).toEqual(["extraction", "page-check", "headings", "figures"])
      for (const [agent, id] of agentRegistration.mock.calls) {
        if (id === undefined) return yield* Effect.die("Expected a registered runtime agent id")
        expect(mastra.getAgent(id)).toBe(agent)
      }
      const run = yield* Effect.promise(() => workflow.createRun({ runId: workflowRunId, resourceId: "persistence-owner", disableScorers: true }))
      const result = yield* Effect.promise(() => run.start({ inputData: { documentId: "PRIVATE_INPUT_SENTINEL", runId: "document-run" }, tracingOptions: { hideInput: false, hideOutput: false, metadata: { documentId: "persistence-document", resourceId: "persistence-owner", arbitrary: "PRIVATE_METADATA_SENTINEL" } } }))
      expect(result.status).toBe("failed")
    }).pipe(Effect.scoped)
    const url = yield* path.toFileUrl(path.join(dataDirectory, "mastra.sqlite"))
    const reopened = yield* Effect.acquireRelease(Effect.sync(() => new LibSQLStore({ id: "reopened-startup-store", url: url.href, maxRetries: 1 })), (storage) => Effect.promise(() => storage.close()))
    yield* Effect.promise(() => reopened.init())
    const workflows = yield* Effect.promise(() => reopened.getStore("workflows"))
    const traces = yield* Effect.promise(() => reopened.getStore("observability"))
    if (workflows === undefined || traces === undefined) return yield* Effect.die("Expected reopened durable stores")
    const saved = yield* Effect.promise(() => workflows.getWorkflowRunById({ workflowName: "normalize-document", runId: workflowRunId }))
    expect(saved).toMatchObject({ runId: workflowRunId, workflowName: "normalize-document", resourceId: "persistence-owner" })
    const snapshot = yield* Effect.promise(() => workflows.loadWorkflowSnapshot({ workflowName: "normalize-document", runId: workflowRunId }))
    expect(snapshot).toMatchObject({ runId: workflowRunId, status: "failed" })
    const listed = yield* Effect.promise(() => traces.listTraces({ filters: { metadata: { documentId: "persistence-document" } } }))
    expect(listed.spans).toHaveLength(1)
    const traceId = listed.spans[0]?.traceId
    if (traceId === undefined) return yield* Effect.die("Expected persisted workflow trace")
    const trace = yield* Effect.promise(() => traces.getTrace({ traceId }))
    const serialized = JSON.stringify(trace)
    expect(serialized).toContain("normalize-document")
    expect(serialized).toContain("extract-document")
    expect(serialized).not.toContain("PRIVATE_INPUT_SENTINEL")
    expect(serialized).not.toContain("PRIVATE_METADATA_SENTINEL")
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  for (const failure of ["rejects", "does not settle"] as const) it.live(`shutdown closes storage when trace flushing ${failure}`, () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const outerScope = yield* Effect.scope
    const pending = yield* Deferred.make<void>()
    const runEffect = Effect.runPromiseWith(yield* Effect.context<never>())
    yield* Effect.addFinalizer(() => Deferred.succeed(pending, undefined))
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-flush-failure-" })
    const mastra = new Mastra({ ...makeAmuseMe(0), logger: false })
    const shutdown = yield* Effect.acquireRelease(Effect.sync(() => vi.spyOn(mastra, "shutdown")), (spy) => Effect.sync(() => spy.mockRestore()))
    const closeStorage = yield* Effect.gen(function* () {
      yield* startServer(mastra, { port: 0, origin: "http://127.0.0.1:4180", secret: Redacted.make("test-only-flush-secret-with-thirty-two-characters"), dataDirectory: path.join(directory, "data"), appDirectory: path.resolve(".mastra/output/app"), pythonBin: path.resolve("data/python/.venv/bin/python"), queueLimit: 1, admissionConfiguration: { _tag: "disabled", reason: "Flush failure test" }, processing: null })
      const storage = mastra.getStorage()
      if (storage === undefined) return yield* Effect.die("Expected configured storage")
      const close = vi.spyOn(storage, "close")
      const flush = vi.spyOn(mastra.observability, "flush").mockImplementation(() => failure === "rejects" ? Promise.reject(new Error("Injected flush failure")) : runEffect(Deferred.await(pending)))
      yield* Scope.addFinalizer(outerScope, Effect.sync(() => { close.mockRestore(); flush.mockRestore() }))
      return close
    }).pipe(Effect.scoped)
    expect(shutdown).toHaveBeenCalledOnce()
    expect(closeStorage).toHaveBeenCalled()
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("persists timing and identifiers while removing every payload channel", () => Effect.gen(function* () {
    const { mastra, instance, traces } = yield* localTraceFixture
    const secret = "PRIVATE-CONTENT-SENTINEL"
    const requestContext = new RequestContext()
    requestContext.set("credential", secret)
    const root = instance.startSpan({ type: SpanType.WORKFLOW_RUN, name: secret, entityId: "normalize-document", entityName: secret, input: { page: secret }, metadata: { runId: "run-one", documentId: "doc-one", resourceId: "owner-one", password: secret, arbitrary: secret }, requestContext, tags: [secret] })
    const step = root.createChildSpan({ type: SpanType.WORKFLOW_STEP, name: secret, entityId: "check-pages", input: { prompt: secret }, attributes: { entryDescription: secret, entryMetadata: { reasoning: secret } }, metadata: { documentId: "doc-one", documentRunId: "document-run-one", providerAttemptId: "attempt-one", resourceId: "owner-one" } })
    step.update({ input: { body: secret }, output: { reasoning: secret }, metadata: { authorization: secret } })
    step.error({ error: new Error(secret), endSpan: true })
    root.end({ output: { modelResponse: secret } })
    yield* Effect.promise(() => mastra.observability.flush())
    const saved = yield* Effect.promise(() => traces.getTrace({ traceId: root.traceId }))
    expect(saved).not.toBeNull()
    const serialized = JSON.stringify(saved)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("password")
    expect(serialized).not.toContain("reasoning")
    expect(serialized).toContain("normalize-document")
    expect(serialized).toContain("check-pages")
    expect(serialized).toContain("doc-one")
    expect(serialized).toContain("attempt-one")
    expect(serialized).toContain("ProcessingFailure")
    const listed = yield* Effect.promise(() => traces.listTraces({ filters: { runId: "run-one", resourceId: "owner-one" } }))
    expect(listed.spans).toHaveLength(1)
    expect(listed.spans[0]?.endedAt).toBeInstanceOf(Date)
    expect([...mastra.observability.listInstances().keys()]).toEqual(["local"])
    expect(instance.getConfig().exporters?.map((exporter) => exporter.name)).toEqual(["amuseme-local-traces"])
    const exporter = instance.getConfig().exporters?.[0]
    expect(exporter?.onLogEvent).toBeUndefined()
    expect(exporter?.onMetricEvent).toBeUndefined()
    expect(exporter?.onScoreEvent).toBeUndefined()
    expect(exporter?.onFeedbackEvent).toBeUndefined()
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
