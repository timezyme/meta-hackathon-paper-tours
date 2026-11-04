import { museSparkModel } from "../domain/meta-policy.ts"
import { museSparkRates, stageReservations } from "./policy.ts"
import { Config, Effect, Option, Path, Redacted, Schema } from "effect"
import { RunConfiguration } from "../domain/index.ts"
import { figureCropReviewPromptVersion } from "../domain/prompt-templates.ts"
import { stageSpecs } from "../paper/correction/index.ts"
import { GuardPolicy } from "./contracts.ts"
import type { PipelineOptions } from "./pipeline.ts"

const maximumOutputTokens = 16_384
const maximumRequestBytes = 48 * 1024 * 1024
const maximumResponseBytes = 2 * 1024 * 1024
const callDeadlineMilliseconds = 1_500_000
const maximumAuthorizedBudgetUsd = 480.564373

export const disabledGuardPolicy: GuardPolicy = {
  mode: "live",
  enabled: false,
  metaCredentialConfigured: false,
  mineruCredentialConfigured: false,
  mineruEndpoint: null,
  budgetId: "disabled",
  authorizedBudgetMicrousd: null,
  maximumCostMicrousd: { extraction: 0, "page-check": 0, headings: 0, figures: 0 },
  maxConcurrentCalls: 1,
  maxOutputTokens: maximumOutputTokens,
  maxRequestBytes: maximumRequestBytes,
  maxResponseBytes: maximumResponseBytes,
  callDeadlineMilliseconds,
}

const credential = (name: string) => Config.schema(Schema.Redacted(Schema.String.check(Schema.isNonEmpty())), name).pipe(Config.option)
export const processingConfig = Effect.fnUntraced(function* (dataDirectory: string) {
  const enabled = yield* Config.Boolean("AMUSEME_PROCESSING_ENABLED").pipe(Config.withDefault(false))
  if (!enabled) return null
  const path = yield* Path.Path
  const meta = yield* credential("META_API_KEY")
  const mineru = yield* Config.schema(Schema.Redacted(Schema.String), "AMUSEME_MINERU_TOKEN").pipe(
    Config.option,
    Config.map(Option.filter((value) => Redacted.value(value) !== "")),
  )
  const endpoint = yield* Config.String("AMUSEME_MINERU_URL").pipe(Config.option, Config.map(Option.filter((value) => value !== "")))
  const budget = yield* Config.schema(
    Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(maximumAuthorizedBudgetUsd)),
    "AMUSEME_PROCESSING_BUDGET_USD",
  ).pipe(Config.option)
  const documentBudget = yield* Config.schema(
    Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(30)),
    "AMUSEME_DOCUMENT_BUDGET_USD",
  ).pipe(Config.withDefault(30))
  const budgetId = yield* Config.schema(Schema.String.check(Schema.isNonEmpty()), "AMUSEME_BUDGET_ID").pipe(Config.option)
  if (Option.isNone(meta) || Option.isNone(budget) || Option.isNone(budgetId)) return null
  const policy = yield* Schema.decodeUnknownEffect(GuardPolicy)({
    mode: "live",
    enabled: true,
    metaCredentialConfigured: true,
    mineruCredentialConfigured: Option.isSome(mineru),
    mineruEndpoint: Option.getOrNull(endpoint),
    budgetId: budgetId.value,
    authorizedBudgetMicrousd: Math.floor(budget.value * 1_000_000),
    maximumCostMicrousd: stageReservations,
    metaRates: museSparkRates,
    maxConcurrentCalls: 16,
    maxOutputTokens: maximumOutputTokens,
    maxRequestBytes: maximumRequestBytes,
    maxResponseBytes: maximumResponseBytes,
    callDeadlineMilliseconds,
  })
  const model = (stage: keyof typeof stageSpecs) => ({
    provider: "meta",
    model: museSparkModel,
    reasoning: stage === "headings" ? "medium" : "high",
    promptName: stageSpecs[stage].promptName,
    promptVersion: stageSpecs[stage].promptVersion,
    maxOutputTokens: policy.maxOutputTokens,
  })
  const configuration = yield* Schema.decodeUnknownEffect(RunConfiguration)({
    extractionProvider: "meta",
    extractionVersion: museSparkModel,
    extractionModel: model("extraction"),
    pageCheck: model("page-check"),
    headings: model("headings"),
    figures: model("figures"),
    figureCropPromptVersion: figureCropReviewPromptVersion,
    guide: model("guide"),
    maxProviderAttempts: 100,
    deadlineMilliseconds: 3_600_000,
    spendingCapUsd: Math.min(documentBudget, budget.value),
  })
  const pipeline: PipelineOptions = {
    temporaryDirectory: path.join(dataDirectory, "processing"),
    policy,
    metaCredential: meta.value,
    ...(Option.isSome(mineru) && Option.isSome(endpoint) ? { mineruToken: mineru.value, mineruEndpoint: endpoint.value } : {}),
  }
  return { pipeline, configuration, pipelineVersion: "amuseme-meta-3" }
})
