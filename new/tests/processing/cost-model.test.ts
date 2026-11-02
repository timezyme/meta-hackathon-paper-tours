import { describe, expect, it } from "vitest"
import type { GuardPolicy } from "../../src/processing/contracts.ts"
import { metaWorstCaseMicrousd, stageReservation } from "../../src/processing/policy.ts"

const rates = { inputMicrousdPerMillionTokens: 1_250_000, outputMicrousdPerMillionTokens: 4_250_000 }
const policy = (crop?: number): GuardPolicy => ({
  mode: "fixture", enabled: true, metaCredentialConfigured: true, mineruCredentialConfigured: false, mineruEndpoint: null, budgetId: "cost-model", authorizedBudgetMicrousd: 1_000_000,
  maximumCostMicrousd: { extraction: 300_000, "page-check": 300_000, headings: 500_000, figures: 500_000, guide: 500_000, ...(crop === undefined ? {} : { "figure-crop": crop }) },
  metaRates: rates, maxConcurrentCalls: 1, maxOutputTokens: 16384, maxRequestBytes: 1024, maxResponseBytes: 1024, callDeadlineMilliseconds: 1000,
})

describe("provider cost model", () => {
  it("charges every input token at the uncached rate and every possible output token", () => {
    expect(metaWorstCaseMicrousd(rates, 0, 16384)).toBe(69_632)
    expect(metaWorstCaseMicrousd(rates, 1_000_000, 0)).toBe(1_250_000)
    expect(metaWorstCaseMicrousd(rates, 1, 0)).toBe(2)
  })
  it("admits the largest observed calls with their framing reserve under the new reservations", () => {
    const framing = 65536
    const worst = (inputTokens: number) => metaWorstCaseMicrousd(rates, inputTokens + framing, 16384)
    expect(worst(4785)).toBeLessThanOrEqual(300_000)
    expect(worst(9693)).toBeLessThanOrEqual(300_000)
    expect(worst(15347)).toBeLessThanOrEqual(500_000)
    expect(worst(2 * 6506)).toBeLessThanOrEqual(200_000)
    expect(worst(118_758)).toBeLessThanOrEqual(300_000)
    expect(worst(118_759)).toBeGreaterThan(300_000)
    expect(worst(278_758)).toBeLessThanOrEqual(500_000)
    expect(worst(38_758)).toBeLessThanOrEqual(200_000)
    expect(worst(38_759)).toBeGreaterThan(200_000)
  })
  it("reserves crop reviews separately and falls back to the figures reservation for older policies", () => {
    expect(stageReservation(policy(200_000), "figures", "figure-crop")).toBe(200_000)
    expect(stageReservation(policy(200_000), "figures")).toBe(500_000)
    expect(stageReservation(policy(), "figures", "figure-crop")).toBe(500_000)
    expect(stageReservation(policy(), "guide")).toBe(500_000)
  })
})
