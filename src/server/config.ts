import { Config, Effect, Path, Schema } from "effect"
import { processingConfig } from "../processing/config.ts"
import { processingAvailability } from "../processing/index.ts"
import { AdmissionConfiguration } from "./documents.ts"

export const serverPort = Config.schema(
  Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65535 })),
  "AMUSEME_PORT",
).pipe(Config.withDefault(4180))

const Origin = Schema.String.check(Schema.makeFilter((value) => {
  const url = URL.parse(value)
  return url !== null && url.protocol === "http:"
    && url.origin === value && url.username === "" && url.password === ""
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    || "This listener supports canonical loopback HTTP origins only; TLS/proxy deployment is not configured"
}))

export const serverConfig = Effect.gen(function* () {
  const path = yield* Path.Path
  const port = yield* serverPort
  const origin = yield* Config.schema(Origin.check(Schema.makeFilter((value) => Number(new URL(value).port || "80") === port || "Origin port must match AMUSEME_PORT")), "AMUSEME_ORIGIN").pipe(Config.withDefault(`http://127.0.0.1:${port}`))
  const secret = yield* Config.schema(Schema.Redacted(Schema.String.check(Schema.isMinLength(32))), "BETTER_AUTH_SECRET")
  const dataDirectory = path.resolve(yield* Config.schema(Schema.String.check(Schema.isNonEmpty()), "AMUSEME_DATA_DIR").pipe(Config.withDefault("data")))
  const appDirectory = path.resolve(yield* Config.schema(Schema.String.check(Schema.isNonEmpty()), "AMUSEME_APP_DIR").pipe(Config.withDefault(".mastra/output/app")))
  const pythonBin = path.resolve(yield* Config.schema(Schema.String.check(Schema.isNonEmpty()), "AMUSEME_PYTHON_BIN").pipe(Config.withDefault("data/python/.venv/bin/python")))
  const queueLimit = yield* Config.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })), "AMUSEME_QUEUE_LIMIT").pipe(Config.withDefault(10))
  const processing = yield* processingConfig(dataDirectory)
  const admissionConfiguration = yield* Schema.decodeUnknownEffect(AdmissionConfiguration)(processing !== null && processingAvailability(processing.pipeline.policy).available ? { _tag: "live", configuration: processing.configuration, pipelineVersion: processing.pipelineVersion } : {
    _tag: "disabled", reason: "Document processing is not configured. Uploads will open when the processing pipeline, provider access, and budget are ready.",
  })
  return { port, origin, secret, dataDirectory, appDirectory, pythonBin, queueLimit, admissionConfiguration, processing }
})

export type ServerConfig = Effect.Success<typeof serverConfig>
