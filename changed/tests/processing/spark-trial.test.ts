import { it } from "@effect/vitest"
import { Effect, Redacted, Result } from "effect"
import { describe, expect } from "vitest"
import { parseTrialArguments, trialBudgetId, validateTrialPolicy } from "../../cli/spark-extraction/trial.ts"
import { disabledGuardPolicy } from "../../src/processing/config.ts"
import type { ServerConfig } from "../../src/server/config.ts"
import { contractFixture } from "../fixtures/contracts.ts"

const config: ServerConfig = {
  port: 4180, origin: "http://127.0.0.1:4180", secret: Redacted.make("fixture-only"), dataDirectory: "/unused", appDirectory: "/unused", pythonBin: "/unused", queueLimit: 1,
  host: "127.0.0.1" as const, judgeSignIn: undefined, examplesOwnerId: undefined, uploadsPerUser: undefined, admissionConfiguration: { _tag: "disabled", reason: "fixture" },
  processing: { pipelineVersion: "1", configuration: contractFixture().run.configuration, pipeline: { temporaryDirectory: "/unused", metaCredential: Redacted.make("fixture"), mineruToken: Redacted.make("fixture"), mineruEndpoint: "https://fixture.invalid", policy: { ...disabledGuardPolicy, enabled: true, budgetId: trialBudgetId, authorizedBudgetMicrousd: 37_000_000, maximumCostMicrousd: { extraction: 2_500_000, "page-check": 1_500_000, headings: 1_500_000, figures: 1_500_000 } } } },
}
const ledger = { budgetId: trialBudgetId, chargedMicrousd: 31_000_000, chargeRows: 18, activeRuns: 0, unresolvedAttempts: 0 }
describe("Spark trial launch contract", () => {
  it("requires explicit run intent and all selected inputs", () => {
    const parsed = parseTrialArguments(["--pdf", "one.pdf", "--owner", "owner", "--output", "new"])
    expect(Result.isSuccess(parsed) && parsed.success.run).toBe(false)
    expect(Result.isFailure(parseTrialArguments(["--run"]))).toBe(true)
    expect(Result.isFailure(parseTrialArguments(["--pdf", "a", "--pdf", "b", "--owner", "owner", "--output", "new"]))).toBe(true)
  })
  it.effect("bounds the trial to the original budget and exactly one attempt", () => Effect.gen(function* () {
    const configuration = yield* validateTrialPolicy(config, ledger)
    expect(configuration.extractionModel?.maxOutputTokens).toBe(16384)
    expect(configuration.maxProviderAttempts).toBe(1)
    expect(configuration.spendingCapUsd).toBe(5.5)
    for (const changed of [{ budgetId: "new-budget" }, { chargedMicrousd: 32_000_000 }, { chargeRows: 0 }, { activeRuns: 1 }, { unresolvedAttempts: 1 }]) expect(Result.isFailure(yield* validateTrialPolicy(config, { ...ledger, ...changed }).pipe(Effect.result))).toBe(true)
  }))
})
