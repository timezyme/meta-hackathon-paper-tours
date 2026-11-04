import { museSparkModel, isMuseModel } from "../domain/meta-policy.ts"
import { Schema } from "effect"
import type { ProviderStage, ProviderTask, RunConfiguration, Usage, StageReceipt } from "../domain/index.ts"
import { GuardPolicy, type ProviderResponse, type AttemptInput } from "./contracts.ts"

export const runGuardPolicy = (policy: GuardPolicy, configuration: typeof RunConfiguration.Type): GuardPolicy => {
  if (configuration.guide !== undefined || policy.maximumCostMicrousd.guide === undefined) return policy
  const { guide: _guide, ...maximumCostMicrousd } = policy.maximumCostMicrousd
  return { ...policy, maximumCostMicrousd }
}

export const processingAvailability = (policy: GuardPolicy): { readonly available: boolean; readonly reason: string | null } => {
  if (!Schema.is(GuardPolicy)(policy)) return { available: false, reason: "Processing limits are invalid" }
  if (!policy.enabled) return { available: false, reason: "Processing is not enabled" }
  if (policy.mode === "fixture") return { available: true, reason: null }
  if (!policy.metaCredentialConfigured) return { available: false, reason: "Processing credentials are not configured" }
  if (
    policy.authorizedBudgetMicrousd === null ||
    policy.authorizedBudgetMicrousd <= 0 ||
    Object.values(policy.maximumCostMicrousd).some((cost) => cost <= 0)
  )
    return { available: false, reason: "An authorized budget and worst-case provider charges are required" }
  return { available: true, reason: null }
}

export const metaRuntimeConfiguration = (configuration: typeof RunConfiguration.Type): boolean =>
  configuration.extractionProvider === "meta" &&
  configuration.extractionVersion === museSparkModel &&
  isMuseModel(configuration.extractionModel) &&
  [
    configuration.pageCheck,
    configuration.headings,
    configuration.figures,
    ...(configuration.guide === undefined ? [] : [configuration.guide]),
  ].every(isMuseModel)

export const stageReservation = (
  policy: GuardPolicy,
  stage: typeof ProviderStage.Type,
  task?: typeof ProviderTask.Type,
): number | undefined =>
  task === "figure-crop"
    ? (policy.maximumCostMicrousd["figure-crop"] ?? policy.maximumCostMicrousd.figures)
    : policy.maximumCostMicrousd[stage]

type Configuration = typeof RunConfiguration.Type
const spendingCapMicrousd = (configuration: Configuration) => Math.floor(configuration.spendingCapUsd * 1_000_000)
const pageReservation = ({ maximumCostMicrousd: cost }: GuardPolicy) => cost.extraction + cost["page-check"]

export const minimumReservationMicrousd = (policy: GuardPolicy, configuration: Configuration, pageCount: number): number | undefined => {
  const guide = configuration.guide === undefined ? 0 : policy.maximumCostMicrousd.guide
  if (guide === undefined) return undefined
  return pageCount * pageReservation(policy) + policy.maximumCostMicrousd.headings + guide
}

export const affordablePageLimit = (policy: GuardPolicy, configuration: Configuration): number => {
  const fixed = minimumReservationMicrousd(policy, configuration, 0)
  const cap = spendingCapMicrousd(configuration)
  if (fixed === undefined || !Number.isSafeInteger(fixed) || fixed > cap) return 0
  const perPage = pageReservation(policy)
  return perPage === 0 ? Number.POSITIVE_INFINITY : Math.floor((cap - fixed) / perPage)
}

const metaTokenMicrousd = (rates: NonNullable<GuardPolicy["metaRates"]>, inputTokens: number, outputTokens: number): number =>
  Math.ceil((inputTokens * rates.inputMicrousdPerMillionTokens + outputTokens * rates.outputMicrousdPerMillionTokens) / 1_000_000)

export const metaWorstCaseMicrousd = (rates: NonNullable<GuardPolicy["metaRates"]>, inputTokens: number, maxOutputTokens: number): number =>
  metaTokenMicrousd(rates, inputTokens, maxOutputTokens)

export const metaMeteredMicrousd = (rates: NonNullable<GuardPolicy["metaRates"]>, usage: typeof Usage.Type): number | null =>
  usage._tag === "reported" && usage.inputTokens !== null && usage.outputTokens !== null
    ? metaTokenMicrousd(rates, usage.inputTokens, usage.outputTokens)
    : null

export const remainingHeadroomMicrousd = (reservations: ReadonlyArray<number>, charged: ReadonlyArray<number> = []): number =>
  Math.max(
    0,
    charged.reduce(
      (remaining, cost) => remaining - cost,
      reservations.reduce((sum, cost) => sum + cost, 0),
    ),
  )

export const museSparkRates = {
  inputMicrousdPerMillionTokens: 1_250_000,
  outputMicrousdPerMillionTokens: 4_250_000,
} as const

export const stageReservations = {
  extraction: 300_000,
  "page-check": 300_000,
  headings: 500_000,
  figures: 500_000,
  guide: 500_000,
  "figure-crop": 200_000,
} as const

export const exceedsStageReservation = (
  policy: GuardPolicy,
  input: AttemptInput,
  maxOutputTokens: number | null,
  reserved: number,
): boolean =>
  policy.metaRates !== undefined &&
  input.inputTokenBound !== undefined &&
  metaWorstCaseMicrousd(policy.metaRates, input.inputTokenBound, maxOutputTokens ?? policy.maxOutputTokens) > reserved

export const chargedMicrousd = (
  policy: GuardPolicy,
  configuration: StageReceipt["configuration"],
  response: ProviderResponse,
): number | null => {
  const metered =
    policy.metaRates !== undefined && configuration.provider === "meta" ? metaMeteredMicrousd(policy.metaRates, response.usage) : null
  return response.actualCostMicrousd ?? metered
}
