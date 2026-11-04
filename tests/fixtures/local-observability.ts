import { Mastra } from "@mastra/core/mastra"
import { LibSQLStore } from "@mastra/libsql"
import { Effect, FileSystem, Path } from "effect"
import { makeLocalObservability } from "../../src/mastra/observability.ts"

export const localTraceFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-traces-" })
  const storage = new LibSQLStore({ id: "local-traces", url: `file:${path.join(directory, "mastra.sqlite")}`, maxRetries: 1 })
  yield* Effect.promise(() => storage.init())
  const mastra = yield* Effect.acquireRelease(Effect.sync(() => new Mastra({ storage, observability: makeLocalObservability(), logger: false })), (value) => Effect.promise(() => value.shutdown()))
  const instance = mastra.observability.getDefaultInstance()
  const traces = yield* Effect.promise(() => storage.getStore("observability"))
  const workflows = yield* Effect.promise(() => storage.getStore("workflows"))
  if (instance === undefined || traces === undefined || workflows === undefined) return yield* Effect.die("Expected local observability stores")
  return { storage, mastra, instance, traces, workflows }
})
