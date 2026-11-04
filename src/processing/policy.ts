import { Schema } from "effect"
import { GuardPolicy } from "./contracts.ts"

export const processingAvailability = (policy: GuardPolicy): { readonly available: boolean; readonly reason: string | null } => {
  if (!Schema.is(GuardPolicy)(policy)) return { available: false, reason: "Processing limits are invalid" }
  if (!policy.enabled) return { available: false, reason: "Processing is not enabled" }
  if (policy.mode === "fixture") return { available: true, reason: null }
  if (!policy.metaCredentialConfigured || !policy.mineruCredentialConfigured) return { available: false, reason: "Processing credentials are not configured" }
  if (policy.mineruEndpoint === null || !URL.canParse(policy.mineruEndpoint)) return { available: false, reason: "The AmuseMe extraction endpoint is not configured" }
  const endpoint = new URL(policy.mineruEndpoint)
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "") return { available: false, reason: "The AmuseMe extraction endpoint must use HTTPS without embedded credentials" }
  if (policy.authorizedBudgetMicrousd === null || policy.authorizedBudgetMicrousd <= 0 || Object.values(policy.maximumCostMicrousd).some((cost) => cost <= 0)) return { available: false, reason: "An authorized budget and worst-case provider charges are required" }
  return { available: true, reason: null }
}
