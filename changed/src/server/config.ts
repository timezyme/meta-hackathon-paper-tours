import { Config, Effect, Option, Path, Redacted, Schema } from "effect"
import type { TrustedProxy } from "../auth/index.ts"
import { UserId } from "../domain/index.ts"
import { processingConfig } from "../processing/config.ts"
import { processingAvailability } from "../processing/index.ts"
import { affordablePageLimit } from "../processing/policy.ts"
import { AdmissionConfiguration } from "./documents.ts"

export const serverPort = Config.schema(
  Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65535 })),
  "AMUSEME_PORT",
).pipe(Config.withDefault(4180))

const Origin = Schema.String.check(Schema.makeFilter((value) => {
  const url = URL.parse(value)
  return url !== null && url.origin === value && url.username === "" && url.password === ""
    && (url.protocol === "https:" || url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))
    || "Expected a canonical loopback HTTP origin or an HTTPS origin served through a TLS-terminating proxy"
}))
const optionalSetting = <A>(schema: Schema.Codec<A, string>, name: string) => Config.String(name).pipe(Config.option, Effect.flatMap((value) =>
  Option.isNone(value) || value.value.trim() === "" ? Effect.succeed(undefined) : Schema.decodeUnknownEffect(schema)(value.value.trim())))
const optionalText = (name: string) => Config.schema(Schema.Redacted(Schema.String), name).pipe(Config.option, Config.map(Option.filter((value) => Redacted.value(value) !== "")))

export const serverConfig = Effect.gen(function* () {
  const path = yield* Path.Path
  const port = yield* serverPort
  const origin = yield* Config.schema(Origin.check(Schema.makeFilter((value) => value.startsWith("https:") || Number(new URL(value).port || "80") === port || "Origin port must match AMUSEME_PORT")), "AMUSEME_ORIGIN").pipe(Config.withDefault(`http://127.0.0.1:${port}`))
  const Host = Schema.Literals(["127.0.0.1", "0.0.0.0"]).check(Schema.makeFilter((value) =>
    value === "127.0.0.1" || origin.startsWith("https:")
    || "AMUSEME_HOST=0.0.0.0 needs an https:// AMUSEME_ORIGIN served through a TLS-terminating proxy."
    + " Use 127.0.0.1 for plain HTTP"))
  const host = yield* Config.schema(Host, "AMUSEME_HOST").pipe(Config.withDefault("127.0.0.1" as const))
  const proxy = yield* Config.Literals(["none", "modal"], "AMUSEME_TRUSTED_PROXY")
    .pipe(Config.withDefault("none" as const))
  const trustedProxy: TrustedProxy | undefined = proxy === "none" ? undefined : proxy
  const secret = yield* Config.schema(Schema.Redacted(Schema.String.check(Schema.isMinLength(32))), "BETTER_AUTH_SECRET")
  const dataDirectory = path.resolve(yield* Config.schema(Schema.String.check(Schema.isNonEmpty()), "AMUSEME_DATA_DIR").pipe(Config.withDefault("data")))
  const appDirectory = path.resolve(yield* Config.schema(Schema.String.check(Schema.isNonEmpty()), "AMUSEME_APP_DIR").pipe(Config.withDefault(".mastra/output/app")))
  const pythonBin = path.resolve(yield* Config.schema(Schema.String.check(Schema.isNonEmpty()), "AMUSEME_PYTHON_BIN").pipe(Config.withDefault("data/python/.venv/bin/python")))
  const queueLimit = yield* Config.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })), "AMUSEME_QUEUE_LIMIT").pipe(Config.withDefault(10))
  const judgeSignIn = (yield* optionalSetting(Schema.Literals(["true", "false"]), "AMUSEME_JUDGE_SIGN_IN")) === "true"
    ? { accessCode: Option.getOrNull(yield* optionalText("AMUSEME_JUDGE_ACCESS_CODE")) }
    : undefined
  const examplesOwnerId = yield* optionalSetting(UserId, "AMUSEME_EXAMPLES_OWNER_ID")
  const uploadsPerUser = yield* optionalSetting(Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 1000 })), "AMUSEME_UPLOADS_PER_USER")
  const processing = yield* processingConfig(dataDirectory)
  const maxPages = processing === null ? 0 : Math.min(Number.MAX_SAFE_INTEGER, affordablePageLimit(processing.pipeline.policy, processing.configuration))
  const admissionConfiguration = yield* Schema.decodeUnknownEffect(AdmissionConfiguration)(processing !== null && processingAvailability(processing.pipeline.policy).available && maxPages >= 1 ? {
    _tag: "live", configuration: processing.configuration, pipelineVersion: processing.pipelineVersion, maxPages,
  } : {
    _tag: "disabled", reason: "Document processing is not configured. Uploads will open when the processing pipeline, provider access, and budget are ready.",
  })
  return {
    port, host, origin, secret, dataDirectory, appDirectory, pythonBin, queueLimit, admissionConfiguration, processing,
    judgeSignIn, examplesOwnerId, uploadsPerUser, ...(trustedProxy === undefined ? {} : { trustedProxy }),
  }
})

export type ServerConfig = Effect.Success<typeof serverConfig>
