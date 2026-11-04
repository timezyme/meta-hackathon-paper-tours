import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { mastra } from "../mastra/index.ts"
import { serverConfig } from "./config.ts"
import { startServer } from "./lifecycle.ts"
import { withProcessLock } from "./process-lock.ts"

Effect.gen(function* () {
  const config = yield* serverConfig
  return yield* withProcessLock(config, Effect.gen(function* () {
    yield* startServer(mastra, config)
    return yield* Effect.never
  }))
}).pipe(
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
