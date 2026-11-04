import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Redacted, Result } from "effect"
import { serverConfig } from "../../src/server/config.ts"

const secret = "test-only-secret-with-thirty-two-characters"
const config = (values: Record<string, string | undefined>) => serverConfig.pipe(
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
  Effect.provide(NodeServices.layer),
)

describe("server startup configuration", () => {
  it.effect("requires a strong secret and resolves private storage and app roots", () => Effect.gen(function* () {
    const parsed = yield* config({ BETTER_AUTH_SECRET: secret })
    expect(parsed.port).toBe(4180)
    expect(parsed.origin).toBe("http://127.0.0.1:4180")
    expect(parsed.dataDirectory).toMatch(/\/data$/u)
    expect(parsed.appDirectory).toMatch(/\/\.mastra\/output\/app$/u)
    expect(parsed.pythonBin).toMatch(/\/data\/python\/\.venv\/bin\/python$/u)
    expect(parsed.queueLimit).toBe(10)
    expect(parsed.admissionConfiguration._tag).toBe("disabled")
    expect(Redacted.value(parsed.secret)).toBe(secret)
    for (const values of [{}, { BETTER_AUTH_SECRET: "too-short" }]) expect(Result.isFailure(yield* Effect.result(config(values)))).toBe(true)
  }))

  it.effect("validates queue bounds and cannot enable fixture admission through environment variables", () => Effect.gen(function* () {
    for (const queueLimit of ["0", "-1", "1001", "one"]) {
      expect(Result.isFailure(yield* Effect.result(config({ BETTER_AUTH_SECRET: secret, AMUSEME_QUEUE_LIMIT: queueLimit })))).toBe(true)
    }
    const parsed = yield* config({ BETTER_AUTH_SECRET: secret, AMUSEME_QUEUE_LIMIT: "3", AMUSEME_PYTHON_BIN: "/private/python", AMUSEME_FIXTURE_MODE: "true", AMUSEME_PROCESSING_ENABLED: "true" })
    expect(parsed.queueLimit).toBe(3)
    expect(parsed.pythonBin).toBe("/private/python")
    expect(parsed.admissionConfiguration._tag).toBe("disabled")
  }))

  it.effect("requires explicit live credentials and one bounded persistent budget", () => Effect.gen(function* () {
    const values = { BETTER_AUTH_SECRET: secret, AMUSEME_PROCESSING_ENABLED: "true", META_API_KEY: "test-meta", AMUSEME_MINERU_TOKEN: "test-mineru", AMUSEME_MINERU_URL: "https://amuseme-example.modal.run", AMUSEME_PROCESSING_BUDGET_USD: "27", AMUSEME_BUDGET_ID: "approved-integration" }
    const parsed = yield* config(values)
    expect(parsed.admissionConfiguration._tag).toBe("live")
    expect(parsed.processing?.pipeline.policy.authorizedBudgetMicrousd).toBe(27_000_000)
    expect(parsed.processing?.configuration.pageCheck.model).toBe("muse-spark-1.3")
    expect(parsed.processing?.configuration.headings.reasoning).toBe("medium")
    expect(parsed.processing?.configuration.figures.reasoning).toBe("high")
    const raised = yield* config({ ...values, AMUSEME_PROCESSING_BUDGET_USD: "37" })
    expect(raised.admissionConfiguration._tag).toBe("live")
    expect(raised.processing?.pipeline.policy).toEqual({ ...parsed.processing?.pipeline.policy, authorizedBudgetMicrousd: 37_000_000 })
    expect(raised.processing?.configuration).toEqual(parsed.processing?.configuration)
    for (const key of ["META_API_KEY", "AMUSEME_MINERU_TOKEN", "AMUSEME_MINERU_URL", "AMUSEME_PROCESSING_BUDGET_USD", "AMUSEME_BUDGET_ID"]) {
      expect((yield* config({ ...values, [key]: undefined })).admissionConfiguration._tag).toBe("disabled")
    }
    for (const allowance of ["0", "38", "-1", "NaN"]) expect((yield* config({ ...values, AMUSEME_PROCESSING_BUDGET_USD: allowance }).pipe(Effect.result))._tag).toBe("Failure")
  }))

  it.effect("rejects malformed, noncanonical, and nonlocal HTTP origins", () => Effect.gen(function* () {
    for (const origin of ["https://example.test", "https://example.test/", "https://example.test/path", "https://name:password@example.test", "ftp://example.test", "http://example.test", "null", "http://127.0.0.1:4183"]) {
      expect(Result.isFailure(yield* Effect.result(config({ BETTER_AUTH_SECRET: secret, AMUSEME_ORIGIN: origin }))), origin).toBe(true)
    }
    const parsed = yield* config({ BETTER_AUTH_SECRET: secret, AMUSEME_PORT: "4183", AMUSEME_ORIGIN: "http://127.0.0.1:4183", AMUSEME_DATA_DIR: "/tmp/amuseme-config-test" })
    expect(parsed.port).toBe(4183)
    expect(parsed.origin).toBe("http://127.0.0.1:4183")
    expect(parsed.dataDirectory).toBe("/tmp/amuseme-config-test")
  }))
})
