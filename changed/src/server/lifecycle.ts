import { NodeServices } from "@effect/platform-node"
import { createAdaptorServer } from "@hono/node-server"
import type { ServerType } from "@hono/node-server"
import type { Mastra } from "@mastra/core/mastra"
import { LibSQLStore } from "@mastra/libsql"
import { Effect, FileSystem, Layer, ManagedRuntime, Path } from "effect"
import type { Hono } from "hono"
import { makeAuthLayer } from "../auth/index.ts"
import { makeAmuseMe } from "../mastra/amuseme.ts"
import { registerLocalObservability } from "../mastra/observability.ts"
import { FetchHttpClient } from "effect/http"
import { makeNormalizationBoundary } from "../mastra/normalize-workflow.ts"
import { stageSpecs } from "../paper/correction/index.ts"
import { makeMetaAgentBoundary } from "../paper/providers/meta/index.ts"
import { disabledGuardPolicy } from "../processing/config.ts"
import { NormalizationStages } from "../processing/pipeline.ts"
import { makeProviderGuardLayer, makeRunRecoveryLayer, makeRunDispatcherLayer, RunDispatcher, RunStarter } from "../processing/index.ts"
import { PdfInspector, PdfRenderer } from "../paper/pdf/index.ts"
import { makeArtifactStoreLayer, makeDocumentStoreLayer, makeOutputStoreLayer } from "../storage/index.ts"
import type { ServerConfig } from "./config.ts"
import { DocumentHandler } from "./documents.ts"
import { OutputHandler } from "./outputs.ts"
import { makeDocumentMaintenance } from "./maintenance.ts"
import { makeDocumentRetention } from "./retention.ts"
import { createGuardedApp, ServerError, type ServerState } from "./http.ts"

const shutdownFailure = (operation: string) => (cause: unknown) => Effect.logError(`Shutdown failed: ${operation}`, cause)

const closeListener = Effect.fnUntraced(function* (server: ServerType, state: ServerState) {
  state.phase = "draining"
  if (!server.listening) return
  yield* Effect.callback<void, ServerError>((resume) => {
    server.close((cause) => resume(cause === undefined
      ? Effect.void
      : Effect.fail(new ServerError({ operation: "close listener", cause }))))
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.catchTag("TimeoutError", () => Effect.sync(() => {
      if ("closeAllConnections" in server) server.closeAllConnections()
    })),
    Effect.catch(shutdownFailure("listener")),
  )
})

export const openListener = Effect.fnUntraced(function* (app: Hono, port: number, state: ServerState, host: "127.0.0.1" | "0.0.0.0" = "127.0.0.1") {
  const server = yield* Effect.acquireRelease(
    Effect.try({
      try: () => createAdaptorServer({
        fetch: app.fetch,
        overrideGlobalObjects: false,
        serverOptions: { requestTimeout: 30_000, headersTimeout: 10_000 },
      }),
      catch: (cause) => new ServerError({ operation: "create listener", cause }),
    }),
    (listener) => closeListener(listener, state),
  )
  yield* Effect.callback<void, ServerError>((resume) => {
    const onError = (cause: Error) => resume(Effect.fail(new ServerError({ operation: "listen", cause })))
    server.once("error", onError)
    server.listen(port, host, () => resume(Effect.void))
    return Effect.sync(() => { server.off("error", onError) })
  })
  state.phase = "ready"
  return server
})

export const makeServerRuntime = Effect.fnUntraced(function* (config: ServerConfig, meta = makeMetaAgentBoundary(stageSpecs)) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.makeDirectory(config.dataDirectory, { recursive: true, mode: 0o700 })
  yield* fs.chmod(config.dataDirectory, 0o700)
  yield* fs.makeDirectory(path.join(config.dataDirectory, "archives"), { recursive: true, mode: 0o700 })
  const authLayer = makeAuthLayer({
    origin: config.origin, secret: config.secret, databasePath: path.join(config.dataDirectory, "auth.sqlite"),
    judgeSignIn: config.judgeSignIn, trustedProxy: config.trustedProxy,
  })
  const documents = makeDocumentStoreLayer(config)
  const artifacts = makeArtifactStoreLayer(config.dataDirectory).pipe(Layer.provideMerge(documents))
  const outputs = makeOutputStoreLayer.pipe(Layer.provideMerge(artifacts))
  const policy = config.processing?.pipeline.policy ?? disabledGuardPolicy
  const guarded = Layer.merge(makeProviderGuardLayer(policy), makeRunRecoveryLayer(policy, config.queueLimit)).pipe(Layer.provideMerge(outputs))
  const infrastructure = Layer.mergeAll(authLayer, guarded, PdfInspector.layer({ pythonBin: config.pythonBin }), PdfRenderer.layer({ pythonBin: config.pythonBin }), FetchHttpClient.layer)
  const stages = NormalizationStages.layer(meta, config.processing?.pipeline).pipe(Layer.provideMerge(infrastructure))
  const dependencies = makeRunDispatcherLayer(policy, "amuseme-local", 60_000).pipe(Layer.provideMerge(stages))
  const services = Layer.merge(DocumentHandler.layer({
    origin: config.origin, temporaryDirectory: path.join(config.dataDirectory, "uploads"), admissionConfiguration: config.admissionConfiguration, uploadsPerUser: config.uploadsPerUser,
  }), OutputHandler.layer(config.origin)).pipe(Layer.provideMerge(dependencies), Layer.provide(NodeServices.layer))
  const runtime = yield* Effect.acquireRelease(
    Effect.sync(() => ManagedRuntime.make(services)),
    (managed) => managed.disposeEffect,
  )
  yield* runtime.contextEffect
  return runtime
})

export const startServer = Effect.fnUntraced(function* (mastra: Mastra, config: ServerConfig) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const meta = makeMetaAgentBoundary(stageSpecs)
  const runtime = yield* makeServerRuntime(config, meta)
  const normalization = makeNormalizationBoundary((claim, stage, input, signal) => runtime.runPromise(Effect.flatMap(NormalizationStages, (stages) => stages.execute(claim, stage, input)).pipe(Effect.match({ onSuccess: (value) => ({ _tag: "success" as const, value }), onFailure: (error) => ({ _tag: "failure" as const, failure: error.failure }) })), { signal }))
  const storagePath = path.join(config.dataDirectory, "mastra.sqlite")
  yield* fs.writeFile(storagePath, new Uint8Array(), { flag: "a", mode: 0o600 })
  yield* fs.chmod(storagePath, 0o600)
  const storageUrl = yield* path.toFileUrl(storagePath)
  const storage = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new LibSQLStore({
        id: "amuseme-mastra",
        url: storageUrl.href,
        maxRetries: 1,
        connectionTimeoutMs: 5_000,
      }),
      catch: (cause) => new ServerError({ operation: "open Mastra storage", cause }),
    }),
    (store) => Effect.tryPromise({
      try: () => store.close(),
      catch: (cause) => new ServerError({ operation: "close Mastra storage", cause }),
    }).pipe(Effect.catch(shutdownFailure("Mastra storage"))),
  )
  yield* Effect.tryPromise({
    try: () => storage.init(),
    catch: (cause) => new ServerError({ operation: "initialize Mastra storage", cause }),
  })
  yield* Effect.acquireRelease(Effect.succeed(mastra), (instance) => Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => instance.stopWorkers({ drainTimeout: 5_000 }),
      catch: (cause) => new ServerError({ operation: "stop Mastra workers", cause }),
    }).pipe(Effect.timeout("5 seconds"), Effect.catch(shutdownFailure("Mastra workers")))
    yield* Effect.tryPromise({
      try: () => instance.observability.flush(),
      catch: (cause) => new ServerError({ operation: "flush Mastra traces", cause }),
    }).pipe(Effect.timeout("1 second"), Effect.catch(shutdownFailure("Mastra traces")))
  }).pipe(Effect.ensuring(Effect.tryPromise({
    try: () => instance.shutdown({ drainTimeout: 0 }),
    catch: (cause) => new ServerError({ operation: "shutdown Mastra", cause }),
  }).pipe(Effect.timeout("1 second"), Effect.catch(shutdownFailure("Mastra"))))))
  mastra.setStorage(storage)
  yield* registerLocalObservability(mastra)
  const configuration = makeAmuseMe(config.port, {
    ...config, meta, normalization,
    runDocumentRequest: (operation, request, documentId) => runtime.runPromise(
      Effect.flatMap(DocumentHandler, (handler) => handler.handle(operation, request, documentId)),
      { signal: request.signal },
    ),
    runOutputRequest: (operation, request, documentId, revisionId, figureId) => runtime.runPromise(
      Effect.flatMap(OutputHandler, (handler) => handler.handle(operation, request, documentId, revisionId, figureId)),
      { signal: request.signal },
    ),
  })
  for (const [id, agent] of Object.entries(configuration.agents ?? {})) {
    mastra.removeAgent(id)
    mastra.addAgent(agent, id)
  }
  mastra.removeWorkflow("normalize-document")
  mastra.addWorkflow(normalization.workflow, "normalize-document")
  if (configuration.server !== undefined) mastra.setServer(configuration.server)
  const state: ServerState = { phase: "starting" }
  const app = yield* createGuardedApp(mastra, runtime, config.origin, state)
  yield* Effect.tryPromise({
    try: () => mastra.startWorkers(),
    catch: (cause) => new ServerError({ operation: "start workers", cause }),
  })
  const listener = yield* openListener(app, config.port, state, config.host)
  const maintenance = yield* makeDocumentMaintenance({
    purge: makeDocumentRetention(storage, () => mastra.observability.flush()).purge,
    mineru: config.processing?.pipeline.mineruEndpoint === undefined || config.processing.pipeline.mineruToken === undefined ? null : { endpoint: config.processing.pipeline.mineruEndpoint, token: config.processing.pipeline.mineruToken },
  }).pipe(Effect.provide(yield* runtime.contextEffect))
  yield* Effect.forkScoped(Effect.gen(function* () {
    while (true) {
      yield* maintenance.runOnce().pipe(Effect.flatMap((report) => report.reconciliationFailed || report.localFailures > 0 || report.remotePending > 0 ? Effect.logWarning("Document cleanup has pending work", report) : Effect.void), Effect.catch((error) => Effect.logError("Document maintenance failed", error)))
      yield* Effect.sleep("60 seconds")
    }
  }))
  if (config.processing != null) {
    const context = yield* runtime.contextEffect
    yield* Effect.flatMap(RunDispatcher, (dispatcher) => dispatcher.recover()).pipe(Effect.provide(context))
    yield* Effect.forEach([0, 1], () => Effect.forkScoped(Effect.gen(function* () {
      while (true) {
        yield* Effect.flatMap(RunDispatcher, (dispatcher) => dispatcher.dispatchOne()).pipe(Effect.provideService(RunStarter, normalization.starter), Effect.provide(context), Effect.catch((error) => Effect.logError("Document dispatcher stopped this attempt", error)))
        yield* Effect.sleep("1 second")
      }
    })), { discard: true })
  }
  yield* Effect.logInfo("AmuseMe ready", { origin: config.origin, port: config.port })
  return { listener, state, runtime }
})
