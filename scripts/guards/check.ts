import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { inspectRepository } from "./repository.ts"

const directory = process.argv[2] ?? "."

inspectRepository(directory).pipe(
  Effect.flatMap((problems) => problems.length === 0
    ? Console.log("Development guards passed")
    : Console.error(problems.join("\n")).pipe(Effect.andThen(Effect.fail("Development guard violations")))),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
