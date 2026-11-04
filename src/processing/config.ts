import { Config, Effect, Option, Path, Schema } from "effect"
import { RunConfiguration } from "../domain/index.ts"
import { stageSpecs } from "../paper/correction/index.ts"
import { GuardPolicy } from "./contracts.ts"
import type { PipelineOptions } from "./pipeline.ts"

export const disabledGuardPolicy: GuardPolicy = {
  mode: "live", enabled: false, metaCredentialConfigured: false, mineruCredentialConfigured: false, mineruEndpoint: null,
  budgetId: "disabled", authorizedBudgetMicrousd: null, maximumCostMicrousd: { extraction: 0, "page-check": 0, headings: 0, figures: 0 },
  maxConcurrentCalls: 1, maxOutputTokens: 16384, maxRequestBytes: 48 * 1024 * 1024, maxResponseBytes: 2 * 1024 * 1024, callDeadlineMilliseconds: 1_500_000,
}

const credential = (name: string) => Config.schema(Schema.Redacted(Schema.String.check(Schema.isNonEmpty())), name).pipe(Config.option)
export const processingConfig = Effect.fnUntraced(function* (dataDirectory: string) {
  const enabled = yield* Config.Boolean("AMUSEME_PROCESSING_ENABLED").pipe(Config.withDefault(false))
  if (!enabled) return null
  const path = yield* Path.Path
  const meta = yield* credential("META_API_KEY")
  const mineru = yield* credential("AMUSEME_MINERU_TOKEN")
  const endpoint = yield* Config.String("AMUSEME_MINERU_URL").pipe(Config.option)
  const budget = yield* Config.schema(Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(37)), "AMUSEME_PROCESSING_BUDGET_USD").pipe(Config.option)
  const budgetId = yield* Config.schema(Schema.String.check(Schema.isNonEmpty()), "AMUSEME_BUDGET_ID").pipe(Config.option)
  if (Option.isNone(meta) || Option.isNone(mineru) || Option.isNone(endpoint) || Option.isNone(budget) || Option.isNone(budgetId)) return null
  const policy = yield* Schema.decodeUnknownEffect(GuardPolicy)({
    mode: "live", enabled: true, metaCredentialConfigured: true, mineruCredentialConfigured: true, mineruEndpoint: endpoint.value,
    budgetId: budgetId.value, authorizedBudgetMicrousd: Math.floor(budget.value * 1_000_000),
    maximumCostMicrousd: { extraction: 2_500_000, "page-check": 1_500_000, headings: 1_500_000, figures: 1_500_000 },
    maxConcurrentCalls: 1, maxOutputTokens: 16384, maxRequestBytes: 48 * 1024 * 1024, maxResponseBytes: 2 * 1024 * 1024, callDeadlineMilliseconds: 1_500_000,
  })
  const model = (stage: "page-check" | "headings" | "figures") => ({ provider: "meta", model: "muse-spark-1.3", reasoning: stage === "headings" ? "medium" : "high", promptName: stageSpecs[stage].promptName, promptVersion: stageSpecs[stage].promptVersion, maxOutputTokens: policy.maxOutputTokens })
  const configuration = yield* Schema.decodeUnknownEffect(RunConfiguration)({ extractionProvider: "mineru", extractionVersion: "4.0.12", pageCheck: model("page-check"), headings: model("headings"), figures: model("figures"), maxProviderAttempts: 100, deadlineMilliseconds: 3_600_000, spendingCapUsd: Math.min(15, budget.value) })
  const pipeline: PipelineOptions = { temporaryDirectory: path.join(dataDirectory, "processing"), policy, metaCredential: meta.value, mineruToken: mineru.value, mineruEndpoint: endpoint.value }
  return { pipeline, configuration, pipelineVersion: "amuseme-1" }
})
