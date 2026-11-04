import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Mastra } from "@mastra/core/mastra"
import { LibSQLStore } from "@mastra/libsql"
import { Deferred, Effect, Fiber, FileSystem } from "effect"
import { makeAmuseMe } from "../../src/mastra/amuseme.ts"
import { makeNormalizationBoundary } from "../../src/mastra/normalize-workflow.ts"
import { makeDocumentStoreLayer } from "../../src/storage/index.ts"
import { directory, setup } from "../fixtures/published-output.ts"

const initialize = Effect.fnUntraced(function* (dataDirectory: string, normalization: ReturnType<typeof makeNormalizationBoundary>) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(dataDirectory, { recursive: true })
  const storage = new LibSQLStore({ id: "workflow-test", url: `file:${dataDirectory}/mastra.sqlite`, maxRetries: 1 })
  yield* Effect.promise(() => storage.init())
  const mastra = yield* Effect.acquireRelease(Effect.sync(() => new Mastra({ ...makeAmuseMe(4180, { normalization }), storage })), (value) => Effect.promise(() => value.shutdown()))
  return mastra
})

describe("registered normalization workflow", () => {
  it.effect("runs all six stages with private references and publishes through the current claim", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const fixture = yield* setup(options.dataDirectory)
      const run = Effect.runPromiseWith(yield* Effect.context())
      const calls: Array<string> = []
      const artifact = fixture.publication.manifest.entries[0]
      const reference = { hash: artifact.hash, byteCount: artifact.byteCount }
      const boundary = makeNormalizationBoundary((claim, stage, input) => Effect.gen(function* () {
        calls.push(stage)
        if (stage === "export") return { _tag: "success" as const, value: { documentId: input.documentId, runId: input.runId, state: (yield* fixture.outputs.publish(claim, fixture.publication)).state } }
        const key = { extraction: "extraction", "page-check": "correction", headings: "hierarchy", figures: "descriptions", assembly: "publication" }[stage]
        return { _tag: "success" as const, value: { ...input, [key]: reference } }
      }).pipe(run))
      yield* initialize(options.dataDirectory, boundary)
      const result = yield* boundary.starter.startOrReconnect(fixture.claim)
      expect(result._tag).toBe("succeeded")
      expect(calls).toEqual(["extraction", "page-check", "headings", "figures", "assembly", "export"])
      const saved = yield* Effect.promise(() => boundary.workflow.getWorkflowRunById(fixture.claim.run.mastraRunId!))
      expect(saved?.status).toBe("success")
      const snapshot = JSON.stringify(saved)
      expect(snapshot).not.toContain(fixture.claim.claimToken)
      expect(snapshot).not.toContain("The result is 12 units")
      expect(snapshot.length).toBeLessThan(30000)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.live("waits for the canceled processing step before returning control to shutdown", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const fixture = yield* setup(options.dataDirectory)
      const started = yield* Deferred.make<void>()
      const run = Effect.runPromiseWith(yield* Effect.context())
      const events: Array<string> = []
      const boundary = makeNormalizationBoundary((_claim, _stage, _input, signal) => run(
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }).pipe(Effect.ensuring(Effect.sleep("50 millis").pipe(Effect.andThen(Effect.sync(() => { events.push("stage-ended") }))))), { signal },
      ))
      yield* initialize(options.dataDirectory, boundary)
      const fiber = yield* boundary.starter.startOrReconnect(fixture.claim).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      events.push("caller-finished")
      expect(events).toEqual(["stage-ended", "caller-finished"])
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.live("starts a recovered initial pending snapshot with no prior invocation", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const fixture = yield* setup(options.dataDirectory)
      const first = makeNormalizationBoundary()
      const mastra = yield* initialize(options.dataDirectory, first)
      if (fixture.claim.run.mastraRunId === null) return yield* Effect.die("Missing workflow identity")
      yield* Effect.promise(() => first.workflow.createRun({ runId: fixture.claim.run.mastraRunId!, resourceId: fixture.claim.run.ownerId, disableScorers: true }))
      const storage = yield* Effect.promise(() => mastra.getStorage()?.getStore("workflows") ?? Promise.resolve(undefined))
      const initial = yield* Effect.promise(() => storage?.loadWorkflowSnapshot({ workflowName: "normalize-document", runId: fixture.claim.run.mastraRunId! }) ?? Promise.resolve(null))
      expect(initial).toMatchObject({ status: "pending", context: {}, activePaths: [], activeStepsPath: {} })
      const calls: Array<string> = []
      const run = Effect.runPromiseWith(yield* Effect.context())
      const artifact = fixture.publication.manifest.entries[0]
      const reference = { hash: artifact.hash, byteCount: artifact.byteCount }
      const second = makeNormalizationBoundary((claim, stage, input) => run(Effect.gen(function* () {
        calls.push(stage)
        if (stage === "export") return { _tag: "success" as const, value: { documentId: input.documentId, runId: input.runId, state: (yield* fixture.outputs.publish(claim, fixture.publication)).state } }
        const key = { extraction: "extraction", "page-check": "correction", headings: "hierarchy", figures: "descriptions", assembly: "publication" }[stage]
        return { _tag: "success" as const, value: { ...input, [key]: reference } }
      })))
      yield* initialize(options.dataDirectory, second)
      expect(yield* second.starter.startOrReconnect(fixture.claim).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
      expect((yield* second.starter.startOrReconnect({ ...fixture.claim, recovered: true }))._tag).toBe("succeeded")
      expect(calls).toEqual(["extraction", "page-check", "headings", "figures", "assembly", "export"])
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  for (const status of ["running", "pending"] as const) {
  it.live(status === "running" ? "reopens a saved running snapshot and skips completed extraction" : "refuses to reset a pending snapshot containing prior execution", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const fixture = yield* setup(options.dataDirectory)
      const run = Effect.runPromiseWith(yield* Effect.context())
      const entered = yield* Deferred.make<void>()
      const artifact = fixture.publication.manifest.entries[0]
      const reference = { hash: artifact.hash, byteCount: artifact.byteCount }
      const calls: Array<string> = []
      const first = makeNormalizationBoundary((_claim, stage, input, signal) => run(Effect.gen(function* () {
        calls.push(`first:${stage}`)
        if (stage === "page-check") { yield* Deferred.succeed(entered, undefined); return yield* Effect.never }
        return { _tag: "success" as const, value: { ...input, extraction: reference } }
      }), { signal }))
      const mastra = yield* initialize(options.dataDirectory, first)
      const store = yield* Effect.promise(() => mastra.getStorage()?.getStore("workflows") ?? Promise.resolve(undefined))
      if (store === undefined || fixture.claim.run.mastraRunId === null) return yield* Effect.die("Missing real workflow store")
      const identity = { workflowName: "normalize-document", runId: fixture.claim.run.mastraRunId }
      const fiber = yield* first.starter.startOrReconnect(fixture.claim).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const snapshot = yield* Effect.promise(() => store.loadWorkflowSnapshot(identity))
      if (snapshot === null) return yield* Effect.die("Missing active snapshot")
      expect(snapshot.status).toBe("running")
      expect(snapshot.context["extract-document"]).toMatchObject({ status: "success" })
      yield* Fiber.interrupt(fiber)
      // Restore the real active snapshot captured before graceful shutdown wrote failure.
      yield* Effect.promise(() => store.persistWorkflowSnapshot({ ...identity, resourceId: fixture.claim.run.ownerId, snapshot: { ...snapshot, status } }))
      const second = makeNormalizationBoundary((claim, stage, input) => run(Effect.gen(function* () {
        calls.push(`second:${stage}`)
        if (stage === "export") return { _tag: "success" as const, value: { documentId: input.documentId, runId: input.runId, state: (yield* fixture.outputs.publish(claim, fixture.publication)).state } }
        const key = { extraction: "extraction", "page-check": "correction", headings: "hierarchy", figures: "descriptions", assembly: "publication" }[stage]
        return { _tag: "success" as const, value: { ...input, [key]: reference } }
      })))
      yield* initialize(options.dataDirectory, second)
      expect(yield* second.starter.startOrReconnect(fixture.claim).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
      if (status === "running") {
        expect((yield* second.starter.startOrReconnect({ ...fixture.claim, recovered: true }))._tag).toBe("succeeded")
        expect(calls).toEqual(["first:extraction", "first:page-check", "second:page-check", "second:headings", "second:figures", "second:assembly", "second:export"])
      } else {
        expect(yield* second.starter.startOrReconnect({ ...fixture.claim, recovered: true }).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: "provider-unknown-completion" } })
        expect(calls).toEqual(["first:extraction", "first:page-check"])
        expect(yield* Effect.promise(() => store.loadWorkflowSnapshot(identity))).toEqual({ ...snapshot, status })
      }
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)), { timeout: 15000 })
  }

  it.effect("denies generic execution and preserves a stage failure without advancing or retrying", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const fixture = yield* setup(options.dataDirectory)
      let calls = 0
      const failure = { code: "provider-unknown-completion" as const, message: "Saved remote receipt is uncertain", retryable: true, stage: "extraction" as const, pageId: null, figureId: null }
      const boundary = makeNormalizationBoundary(() => { calls += 1; return Promise.resolve({ _tag: "failure", failure }) })
      yield* initialize(options.dataDirectory, boundary)
      const unauthorized = yield* Effect.promise(() => boundary.workflow.createRun({ runId: "untrusted-run" }))
      const denied = yield* Effect.promise(() => unauthorized.start({ inputData: { documentId: fixture.claim.document.id, runId: fixture.claim.run.id } }))
      expect(denied.status).toBe("failed")
      expect(calls).toBe(0)
      const result = yield* boundary.starter.startOrReconnect(fixture.claim)
      expect(result._tag).toBe("interrupted")
      expect(result).toMatchObject({ failure })
      expect(calls).toBe(1)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))
})
