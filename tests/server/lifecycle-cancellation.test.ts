import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Mastra } from "@mastra/core/mastra"
import { LibSQLStore } from "@mastra/libsql"
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Redacted } from "effect"
import { vi } from "vitest"
import * as processing from "../../src/processing/index.ts"
import { disabledGuardPolicy } from "../../src/processing/config.ts"
import { startServer } from "../../src/server/lifecycle.ts"
import type { ServerConfig } from "../../src/server/config.ts"
import { contractFixture } from "../fixtures/contracts.ts"
import { makeNormalizationBoundary } from "../../src/mastra/normalize-workflow.ts"
import { makeAmuseMe } from "../../src/mastra/amuseme.ts"
import { makeDocumentStoreLayer } from "../../src/storage/index.ts"
import { directory as outputDirectory, setup } from "../fixtures/published-output.ts"

describe("processing shutdown order", () => {
  for (const operation of ["recover", "dispatch"] as const) it.live(`${operation} ends and finishes cleanup before Mastra storage closes`, () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-shutdown-" })
    const entered = yield* Deferred.make<void>()
    const events: Array<string> = []
    const blocked = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sleep("50 millis").pipe(Effect.andThen(Effect.sync(() => events.push("worker-finalized"))))))
    yield* Effect.acquireRelease(Effect.sync(() => vi.spyOn(processing, "makeRunDispatcherLayer").mockReturnValue(Layer.succeed(processing.RunDispatcher, {
      recover: () => operation === "recover" ? blocked : Effect.succeed(0),
      dispatchOne: () => blocked,
    }))), (spy) => Effect.sync(() => spy.mockRestore()))
    const close = LibSQLStore.prototype.close
    yield* Effect.acquireRelease(Effect.sync(() => vi.spyOn(LibSQLStore.prototype, "close").mockImplementation(function(this: LibSQLStore) {
      events.push("mastra-storage-close")
      return close.call(this)
    })), (spy) => Effect.sync(() => spy.mockRestore()))
    const fixture = contractFixture()
    const config: ServerConfig = {
      port: 0, origin: "http://127.0.0.1:4180", secret: Redacted.make("test-only-shutdown-secret-with-thirty-two-characters"),
      dataDirectory: path.join(directory, "data"), appDirectory: path.resolve(".mastra/output/app"), pythonBin: path.resolve("data/python/.venv/bin/python"), queueLimit: 1,
      admissionConfiguration: { _tag: "disabled", reason: "Cancellation test" },
      processing: { configuration: fixture.run.configuration, pipelineVersion: "amuseme-1", pipeline: {
        policy: disabledGuardPolicy, temporaryDirectory: path.join(directory, "processing"), metaCredential: Redacted.make("fixture"), mineruToken: Redacted.make("fixture"), mineruEndpoint: "https://amuseme-fixture.invalid",
      } },
    }
    const server = yield* Effect.forkChild(startServer(new Mastra(), config).pipe(Effect.andThen(Effect.never), Effect.scoped))
    yield* Deferred.await(entered).pipe(Effect.timeout("10 seconds"))
    yield* Fiber.interrupt(server)
    expect(events).toContain("mastra-storage-close")
    expect(events[0]).toBe("worker-finalized")
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { timeout: 20000 })
})

describe("normalization cancellation", () => {
  it.live("awaits the current Mastra step cleanup before the starter returns from interruption", () => Effect.gen(function* () {
    const options = yield* outputDirectory
    yield* Effect.gen(function* () {
      const fixture = yield* setup(options.dataDirectory)
      const entered = yield* Deferred.make<void>()
      const finalized = yield* Deferred.make<void>()
      const events: Array<string> = []
      const stages: Array<string> = []
      const runEffect = Effect.runPromiseWith(yield* Effect.context())
      const boundary = makeNormalizationBoundary((_claim, stage, _input, signal) => {
        stages.push(stage)
        return runEffect(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sleep("50 millis").pipe(Effect.andThen(Effect.sync(() => events.push("step-finalized"))), Effect.andThen(Deferred.succeed(finalized, undefined))))), { signal })
      })
      const storage = new LibSQLStore({ id: "workflow-cancel", url: `file:${options.dataDirectory}/mastra.sqlite`, maxRetries: 1 })
      yield* Effect.promise(() => storage.init())
      yield* Effect.acquireRelease(Effect.sync(() => new Mastra({ ...makeAmuseMe(0, { normalization: boundary }), storage })), (mastra) => Effect.promise(() => mastra.shutdown()))
      const fiber = yield* Effect.forkChild(boundary.starter.startOrReconnect(fixture.claim))
      yield* Deferred.await(entered).pipe(Effect.timeout("5 seconds"))
      yield* Fiber.interrupt(fiber)
      events.push("starter-interrupted")
      yield* Deferred.await(finalized).pipe(Effect.timeout("5 seconds"))
      expect(stages).toEqual(["extraction"])
      expect(events).toEqual(["step-finalized", "starter-interrupted"])
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { timeout: 15000 })
})
