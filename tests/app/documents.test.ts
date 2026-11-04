import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { RunState, UploadPolicy } from "../../src/domain/index.ts"
import { newSubmissionKey } from "../../src/app/client/documents.ts"
import { activeRun, formatBytes, formatExpiry, runSummary, validateSelection } from "../../src/app/documents.ts"

const policy = Schema.decodeUnknownSync(UploadPolicy)({ maxBytes: 50 * 1024 * 1024, maxPages: 50, mediaType: "application/pdf", mode: "fixture", availability: { _tag: "enabled" } })
const state = Schema.decodeUnknownSync(RunState)

describe("document presentation and selection", () => {
  it("accepts one nonempty file up to the exact server ceiling", () => {
    expect(validateSelection([{ size: 1 }], policy)).toBeNull()
    expect(validateSelection([{ size: policy.maxBytes }], policy)).toBeNull()
    expect(validateSelection([{ size: policy.maxBytes + 1 }], policy)).toContain("50 MiB")
    expect(validateSelection([{ size: 0 }], policy)).toContain("non-empty")
    expect(validateSelection([], policy)).toContain("one PDF")
    expect(validateSelection([{ size: 12 }, { size: 12 }], policy)).toContain("No files were uploaded")
  })
  it("uses only actual saved state and progress", () => {
    const queued = { state: state({ _tag: "queued" }) }
    const running = { state: state({ _tag: "running", startedAt: "2026-10-27T12:00:00.000Z", progress: { stage: "page-check", completedUnits: 1, totalUnits: 3 } }) }
    const failed = { state: state({ _tag: "failed", finishedAt: "2026-10-27T12:00:00.000Z", failure: { code: "provider-failed", message: "Saved failure reason", retryable: false, stage: "extraction", pageId: null, figureId: null } }) }
    expect(activeRun(queued)).toBe(true)
    expect(runSummary(queued).title).toBe("Queued")
    expect(runSummary(running)).toEqual({ title: "Checking pages", description: "1 of 3 units completed.", failed: false })
    expect(activeRun(failed)).toBe(false)
    expect(runSummary(failed)).toEqual({ title: "Processing failed", description: "Saved failure reason", failed: true })
  })
  it("formats bytes and expiry without hiding the timezone", () => {
    expect(formatBytes(1025)).toBe("2 KiB")
    expect(formatBytes(50 * 1024 * 1024)).toBe("50 MiB")
    expect(formatExpiry("2026-11-03T12:34:00.000Z")).toBe("2026-11-03 at 12:34 UTC")
  })
  it.effect("creates a schema-valid 128-bit submission identifier", () => Effect.gen(function* () {
    const key = yield* newSubmissionKey
    expect(key).toMatch(/^[a-f0-9]{32}$/u)
  }))
})
