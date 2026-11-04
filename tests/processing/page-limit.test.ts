import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect } from "effect"
import { processingConfig } from "../../src/processing/config.ts"
import { affordablePageLimit, minimumReservationMicrousd } from "../../src/processing/policy.ts"

const shipped = (budgetUsd: string) => processingConfig("/amuseme-page-limit").pipe(
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({
    AMUSEME_PROCESSING_ENABLED: "true", META_API_KEY: "offline-fixture",
    AMUSEME_PROCESSING_BUDGET_USD: budgetUsd, AMUSEME_BUDGET_ID: "page-limit",
  })),
  Effect.flatMap((config) => config === null
    ? Effect.die("Expected processing configuration") : Effect.succeed(config)),
  Effect.map(({ pipeline, configuration }) => ({ policy: pipeline.policy, configuration })),
  Effect.provide(NodeServices.layer),
)

describe("affordable page limit", () => {
  it.effect("allows 48 pages under the shipped reservations and $30 run cap", () => Effect.gen(function* () {
    const { policy, configuration } = yield* shipped("480")
    expect(configuration.spendingCapUsd).toBe(30)
    expect(minimumReservationMicrousd(policy, configuration, 48)).toBe(29_800_000)
    expect(minimumReservationMicrousd(policy, configuration, 49)).toBe(30_400_000)
    expect(affordablePageLimit(policy, configuration)).toBe(48)
  }))

  it.effect("follows the run's actual spending cap", () => Effect.gen(function* () {
    const { policy, configuration } = yield* shipped("10")
    expect(configuration.spendingCapUsd).toBe(10)
    expect(affordablePageLimit(policy, configuration)).toBe(15)
  }))

  it.effect("counts the guide only when the run writes one", () => Effect.gen(function* () {
    const { policy, configuration } = yield* shipped("480")
    const { guide: _guide, ...unguided } = configuration
    expect(affordablePageLimit(policy, unguided)).toBe(49)
    const { guide: _reservation, ...unreserved } = policy.maximumCostMicrousd
    expect(minimumReservationMicrousd({ ...policy, maximumCostMicrousd: unreserved }, configuration, 1)).toBeUndefined()
    expect(affordablePageLimit({ ...policy, maximumCostMicrousd: unreserved }, configuration)).toBe(0)
  }))

  it.effect("admits a page count exactly at its cap and not one microdollar below", () => Effect.gen(function* () {
    const { policy, configuration } = yield* shipped("480")
    const limit = (spendingCapUsd: number) => affordablePageLimit(policy, { ...configuration, spendingCapUsd })
    expect([limit(29.8), limit(29.799999), limit(29.2), limit(29.199999)]).toEqual([48, 47, 47, 46])
    expect([limit(1.6), limit(1.599999), limit(1), limit(0.999999), limit(0)]).toEqual([1, 0, 0, 0, 0])
  }))

  it.effect("agrees with the minimum reservation at every cap", () => Effect.gen(function* () {
    const { policy, configuration } = yield* shipped("480")
    for (let microusd = 0; microusd <= 31_000_000; microusd += 99_999) {
      const capped = { ...configuration, spendingCapUsd: microusd / 1_000_000 }
      const cap = Math.floor(capped.spendingCapUsd * 1_000_000)
      const pages = affordablePageLimit(policy, capped)
      if (pages > 0) expect(minimumReservationMicrousd(policy, capped, pages)).toBeLessThanOrEqual(cap)
      expect(minimumReservationMicrousd(policy, capped, pages + 1)).toBeGreaterThan(cap)
    }
  }))

  it.effect("places no page limit when pages reserve nothing", () => Effect.gen(function* () {
    const { policy, configuration } = yield* shipped("480")
    const free = { ...policy, maximumCostMicrousd: { ...policy.maximumCostMicrousd, extraction: 0, "page-check": 0 } }
    expect(affordablePageLimit(free, configuration)).toBe(Number.POSITIVE_INFINITY)
  }))
})
