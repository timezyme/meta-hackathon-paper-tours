import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Console, Effect, Layer, Schema } from "effect"
import { DocumentId, OutputRevisionId, UserId } from "../src/domain/index.ts"
import { serverConfig } from "../src/server/config.ts"
import { withProcessLock } from "../src/server/process-lock.ts"
import { repairCodeOutput } from "../src/storage/code-repair.ts"
import { makeArtifactStoreLayer, makeDocumentStoreLayer, makeOutputStoreLayer, StorageFailure } from "../src/storage/index.ts"

const program = Effect.gen(function* () {
  const config = yield* serverConfig
  if (config.processing !== null) return yield* new StorageFailure({ code: "conflict", operation: "code-repair", message: "Disable paid processing before offline repair", cause: undefined })
  const args = yield* Config.all({ owner: Config.String("AMUSEME_REPAIR_OWNER"), document: Config.String("AMUSEME_REPAIR_DOCUMENT"), revision: Config.String("AMUSEME_REPAIR_REVISION"), apply: Config.Boolean("AMUSEME_REPAIR_APPLY").pipe(Config.withDefault(false)) })
  const owner = yield* Schema.decodeUnknownEffect(UserId)(args.owner)
  const document = yield* Schema.decodeUnknownEffect(DocumentId)(args.document)
  const revision = yield* Schema.decodeUnknownEffect(OutputRevisionId)(args.revision)
  const documents = makeDocumentStoreLayer(config)
  const artifacts = makeArtifactStoreLayer(config.dataDirectory).pipe(Layer.provideMerge(documents))
  const outputs = makeOutputStoreLayer.pipe(Layer.provideMerge(artifacts))
  const result = yield* withProcessLock(config, repairCodeOutput(owner, document, revision, args.apply).pipe(Effect.provide(outputs)))
  yield* Console.log(JSON.stringify(result, null, 2))
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
