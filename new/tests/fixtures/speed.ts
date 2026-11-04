import { Effect, FileSystem, Schema } from "effect"
import { Admission } from "../../src/storage/index.ts"
import type { GuardPolicy } from "../../src/processing/index.ts"

export const policy: GuardPolicy = {
  mode: "fixture", enabled: true, metaCredentialConfigured: true, mineruCredentialConfigured: false, mineruEndpoint: null,
  budgetId: "speed-fixture", authorizedBudgetMicrousd: 100, maximumCostMicrousd: { extraction: 1, "page-check": 1, headings: 1, figures: 1 },
  maxConcurrentCalls: 4, maxOutputTokens: 1000, maxRequestBytes: 100000, maxResponseBytes: 100000, callDeadlineMilliseconds: 10000,
}
const model = { provider: "fixture", model: "deterministic", reasoning: "high", promptName: "check", promptVersion: "1", maxOutputTokens: 1000 }
export const admission = (owner = "reader-one") => Schema.decodeUnknownEffect(Admission)({
  ownerId: owner, idempotencyKey: `upload-${owner}`, originalFilename: "fake.pdf", bytes: new TextEncoder().encode("fake source"), pageCount: 1, pipelineVersion: "1",
  configuration: { extractionProvider: "fixture", extractionVersion: "1", pageCheck: model, headings: model, figures: model, maxProviderAttempts: 3, deadlineMilliseconds: 100000, spendingCapUsd: 1 },
})
export const options = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return { dataDirectory: yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-speed-" }), queueLimit: 5 }
})
