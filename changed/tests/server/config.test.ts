import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Redacted, Result } from "effect"
import { serverConfig } from "../../src/server/config.ts"

const secret = "test-only-secret-with-thirty-two-characters"
const config = (values: Record<string, string | undefined>) => serverConfig.pipe(
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
  Effect.provide(NodeServices.layer),
)

const settings = (host: string | undefined, origin: string | undefined, port?: string) =>
  config({ BETTER_AUTH_SECRET: secret, AMUSEME_HOST: host, AMUSEME_ORIGIN: origin, AMUSEME_PORT: port })

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
    expect(parsed.processing?.configuration.spendingCapUsd).toBe(27)
    expect(parsed.processing?.configuration.pageCheck.model).toBe("muse-spark-1.3")
    expect(parsed.processing?.configuration.headings.reasoning).toBe("medium")
    expect(parsed.processing?.configuration.figures.reasoning).toBe("high")
    expect(parsed.processing?.configuration.figureCropPromptVersion).toBe("amuseme-2")
    expect(parsed.processing?.pipelineVersion).toBe("amuseme-meta-3")
    expect(parsed.processing?.configuration.guide).toMatchObject({ model: "muse-spark-1.3", reasoning: "high", promptName: "reading-guide", promptVersion: "amuseme-1" })
    const policy = parsed.processing?.pipeline.policy
    expect(policy?.maximumCostMicrousd).toEqual({ extraction: 300_000, "page-check": 300_000, headings: 500_000, figures: 500_000, guide: 500_000, "figure-crop": 200_000 })
    expect(policy?.metaRates).toEqual({ inputMicrousdPerMillionTokens: 1_250_000, outputMicrousdPerMillionTokens: 4_250_000 })
    expect(policy?.maxConcurrentCalls).toBe(4)
    const reserved = policy?.maximumCostMicrousd
    const mandatory = (pages: number) => reserved === undefined || reserved.guide === undefined ? Infinity : pages * (reserved.extraction + reserved["page-check"]) + reserved.headings + reserved.guide
    const perFigure = reserved === undefined ? Infinity : 2 * (reserved["figure-crop"] ?? reserved.figures) + reserved.figures
    expect(mandatory(15) + 5 * perFigure).toBe(14_500_000)
    expect(mandatory(15) + 5 * perFigure).toBeLessThanOrEqual(30_000_000)
    const raised = yield* config({ ...values, AMUSEME_PROCESSING_BUDGET_USD: "67" })
    expect(raised.admissionConfiguration._tag).toBe("live")
    expect(raised.processing?.pipeline.policy).toEqual({ ...parsed.processing?.pipeline.policy, authorizedBudgetMicrousd: 67_000_000 })
    expect(raised.processing?.configuration).toEqual({ ...parsed.processing?.configuration, spendingCapUsd: 30 })
    const guideAcceptance = yield* config({ ...values, AMUSEME_PROCESSING_BUDGET_USD: "100.564373" })
    expect(guideAcceptance.processing?.pipeline.policy.authorizedBudgetMicrousd).toBe(100_564_373)
    expect(guideAcceptance.processing?.configuration.spendingCapUsd).toBe(30)
    expect(guideAcceptance.processing?.pipeline.policy.budgetId).toBe(values.AMUSEME_BUDGET_ID)
    for (const key of ["META_API_KEY", "AMUSEME_PROCESSING_BUDGET_USD", "AMUSEME_BUDGET_ID"]) {
      expect((yield* config({ ...values, [key]: undefined })).admissionConfiguration._tag).toBe("disabled")
    }
    const papersAllowance = yield* config({ ...values, AMUSEME_PROCESSING_BUDGET_USD: "160.564373" })
    expect(papersAllowance.processing?.pipeline.policy.authorizedBudgetMicrousd).toBe(160_564_373)
    expect(papersAllowance.processing?.configuration.spendingCapUsd).toBe(30)
    const documentTypesAllowance = yield* config({ ...values, AMUSEME_PROCESSING_BUDGET_USD: "260.564373" })
    expect(documentTypesAllowance.processing?.pipeline.policy.authorizedBudgetMicrousd).toBe(260_564_373)
    expect(documentTypesAllowance.processing?.configuration.spendingCapUsd).toBe(30)
    const museReviewAllowance = yield* config({ ...values, AMUSEME_PROCESSING_BUDGET_USD: "360.564373" })
    expect(museReviewAllowance.processing?.pipeline.policy.authorizedBudgetMicrousd).toBe(360_564_373)
    expect(museReviewAllowance.processing?.configuration.spendingCapUsd).toBe(30)
    const moreTypesAllowance = yield* config({ ...values, AMUSEME_PROCESSING_BUDGET_USD: "480.564373" })
    expect(moreTypesAllowance.processing?.pipeline.policy.authorizedBudgetMicrousd).toBe(480_564_373)
    expect(moreTypesAllowance.processing?.configuration.spendingCapUsd).toBe(30)
    for (const allowance of ["0", "480.564374", "481", "-1", "NaN", "Infinity"]) expect((yield* config({ ...values, AMUSEME_PROCESSING_BUDGET_USD: allowance }).pipe(Effect.result))._tag).toBe("Failure")
  }))

  it.effect("rejects malformed, noncanonical, and nonlocal HTTP origins", () => Effect.gen(function* () {
    for (const origin of ["https://example.test/", "https://example.test/path", "https://name:password@example.test", "ftp://example.test", "http://example.test", "null", "http://127.0.0.1:4183"]) {
      expect(Result.isFailure(yield* Effect.result(config({ BETTER_AUTH_SECRET: secret, AMUSEME_ORIGIN: origin }))), origin).toBe(true)
    }
    const parsed = yield* config({ BETTER_AUTH_SECRET: secret, AMUSEME_PORT: "4183", AMUSEME_ORIGIN: "http://127.0.0.1:4183", AMUSEME_DATA_DIR: "/tmp/amuseme-config-test" })
    expect(parsed.port).toBe(4183)
    expect(parsed.origin).toBe("http://127.0.0.1:4183")
    expect(parsed.dataDirectory).toBe("/tmp/amuseme-config-test")
  }))
  it.effect("accepts an HTTPS proxy origin, a container bind address, and judge access settings", () => Effect.gen(function* () {
    const local = yield* config({ BETTER_AUTH_SECRET: secret })
    expect(local).toMatchObject({ host: "127.0.0.1", judgeSignIn: undefined, examplesOwnerId: undefined, uploadsPerUser: undefined })
    const deployed = yield* config({
      BETTER_AUTH_SECRET: secret, AMUSEME_PORT: "8000", AMUSEME_HOST: "0.0.0.0", AMUSEME_ORIGIN: "https://amuseme--web.modal.run",
      AMUSEME_JUDGE_SIGN_IN: "true", AMUSEME_EXAMPLES_OWNER_ID: "OPChbgeWYpiYv5TKcvPIGFKe3rfY47kn", AMUSEME_UPLOADS_PER_USER: "3",
    })
    expect(deployed).toMatchObject({ port: 8000, host: "0.0.0.0", origin: "https://amuseme--web.modal.run", judgeSignIn: { accessCode: null }, examplesOwnerId: "OPChbgeWYpiYv5TKcvPIGFKe3rfY47kn", uploadsPerUser: 3 })
    const coded = yield* config({ BETTER_AUTH_SECRET: secret, AMUSEME_JUDGE_SIGN_IN: "true", AMUSEME_JUDGE_ACCESS_CODE: "meta-judges" })
    expect(coded.judgeSignIn?.accessCode === null ? null : Redacted.value(coded.judgeSignIn?.accessCode ?? Redacted.make(""))).toBe("meta-judges")
    expect((yield* config({ BETTER_AUTH_SECRET: secret, AMUSEME_JUDGE_SIGN_IN: "true", AMUSEME_JUDGE_ACCESS_CODE: "" })).judgeSignIn).toEqual({ accessCode: null })
    expect((yield* config({ BETTER_AUTH_SECRET: secret, AMUSEME_JUDGE_ACCESS_CODE: "ignored-when-off" })).judgeSignIn).toBeUndefined()
    expect(yield* config({ BETTER_AUTH_SECRET: secret, AMUSEME_JUDGE_SIGN_IN: "", AMUSEME_EXAMPLES_OWNER_ID: "", AMUSEME_UPLOADS_PER_USER: " " })).toMatchObject({ judgeSignIn: undefined, examplesOwnerId: undefined, uploadsPerUser: undefined })
    for (const values of [{ AMUSEME_HOST: "10.0.0.1" }, { AMUSEME_UPLOADS_PER_USER: "0" }, { AMUSEME_UPLOADS_PER_USER: "1001" }, { AMUSEME_UPLOADS_PER_USER: "three" },
      { AMUSEME_EXAMPLES_OWNER_ID: "../owner" }, { AMUSEME_JUDGE_SIGN_IN: "maybe" }, { AMUSEME_ORIGIN: "https://example.test:8443/path" }]) {
      expect(Result.isFailure(yield* Effect.result(config({ BETTER_AUTH_SECRET: secret, ...values }))), JSON.stringify(values)).toBe(true)
    }
  }))

  it.effect("binds every interface only behind an HTTPS origin", () => Effect.gen(function* () {
    for (const origin of [undefined, "http://127.0.0.1:4180", "http://localhost:4180"]) {
      const exposed = yield* Effect.result(settings("0.0.0.0", origin))
      expect(Result.isFailure(exposed), String(origin)).toBe(true)
      const message = String(Result.isFailure(exposed) ? exposed.failure : "")
      expect(message, String(origin)).toContain("needs an https:// AMUSEME_ORIGIN")
    }
    expect(yield* settings(undefined, "http://127.0.0.1:4180")).toMatchObject({ host: "127.0.0.1" })
    expect(yield* settings("127.0.0.1", "https://judges.example.test")).toMatchObject({ host: "127.0.0.1" })
    expect(yield* settings("0.0.0.0", "https://amuseme--web.modal.run", "8000"))
      .toMatchObject({ host: "0.0.0.0", port: 8000 })
  }))

  it.effect("trusts forwarded client addresses only when the Modal proxy is named", () => Effect.gen(function* () {
    expect((yield* config({ BETTER_AUTH_SECRET: secret })).trustedProxy).toBeUndefined()
    expect((yield* config({ BETTER_AUTH_SECRET: secret, AMUSEME_TRUSTED_PROXY: "none" })).trustedProxy).toBeUndefined()
    expect((yield* config({ BETTER_AUTH_SECRET: secret, AMUSEME_TRUSTED_PROXY: "modal" })).trustedProxy).toBe("modal")
    for (const value of ["true", "x-forwarded-for", "Modal"]) {
      const parsed = yield* Effect.result(config({ BETTER_AUTH_SECRET: secret, AMUSEME_TRUSTED_PROXY: value }))
      expect(Result.isFailure(parsed), value).toBe(true)
    }
  }))

  it.effect("enables Meta-only normal uploads without MinerU credentials", () => Effect.gen(function* () {
    const values = { BETTER_AUTH_SECRET: "x".repeat(40), AMUSEME_PROCESSING_ENABLED: "true", META_API_KEY: "fixture-only", AMUSEME_BUDGET_ID: "original-fixture-budget", AMUSEME_PROCESSING_BUDGET_USD: "37" }
    const configured = yield* config(values)
    expect(configured.admissionConfiguration._tag).toBe("live")
    expect(configured.processing?.configuration.extractionProvider).toBe("meta")
    expect(configured.processing?.configuration.extractionModel?.promptVersion).toBe("2")
    expect(configured.processing?.pipeline.mineruToken).toBeUndefined()
    expect(configured.processing?.pipeline.policy.authorizedBudgetMicrousd).toBe(37000000)
    const blanks = yield* config({ ...values, AMUSEME_MINERU_TOKEN: "", AMUSEME_MINERU_URL: "" })
    expect(blanks.processing).toEqual(configured.processing)
  }))

})
