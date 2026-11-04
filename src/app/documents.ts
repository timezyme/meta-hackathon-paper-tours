import type { DocumentDetail, IdempotencyKey, Run, UploadPolicy } from "../domain/index.ts"

export type DocumentRecord = typeof DocumentDetail.Type
export type UploadAttempt = {
  readonly ownerId: string
  readonly file: File
  readonly key: IdempotencyKey
  readonly state: "pending" | "uncertain" | "rejected"
  readonly message: string
}

export const validateSelection = (files: ReadonlyArray<{ readonly size: number }>, policy: UploadPolicy): string | null => {
  if (files.length !== 1) return "Choose one PDF at a time. No files were uploaded."
  const file = files[0]
  if (file === undefined || file.size === 0) return "Choose a non-empty PDF."
  if (file.size > policy.maxBytes) return `Choose a PDF of ${formatBytes(policy.maxBytes)} or smaller.`
  return null
}

export const formatBytes = (bytes: number): string => bytes >= 1024 * 1024 ? `${Number((bytes / (1024 * 1024)).toFixed(1))} MiB` : `${Math.max(1, Math.ceil(bytes / 1024))} KiB`
export const formatExpiry = (value: string): string => `${value.slice(0, 10)} at ${value.slice(11, 16)} UTC`
export const activeRun = (run: Pick<Run, "state">): boolean => run.state._tag === "queued" || run.state._tag === "running"
export const retryEligibility = (run: Pick<Run, "state">): "unavailable" | "retryable" | "unknown-completion" => {
  const state = run.state
  if ((state._tag !== "failed" && state._tag !== "interrupted") || !state.failure.retryable) return "unavailable"
  return state.failure.code === "provider-unknown-completion" ? "unknown-completion" : "retryable"
}
const stageLabels = { extraction: "Extracting pages", "page-check": "Checking pages", headings: "Restoring headings", figures: "Describing figures", assembly: "Assembling the document", export: "Preparing downloads" } as const

export const runSummary = (run: Pick<Run, "state">): { readonly title: string; readonly description: string; readonly failed: boolean } => {
  const state = run.state
  switch (state._tag) {
    case "queued": return { title: "Queued", description: "Your document is saved and waiting for processing.", failed: false }
    case "running": return { title: stageLabels[state.progress.stage], description: state.progress.totalUnits === null ? `${state.progress.completedUnits} units completed.` : `${state.progress.completedUnits} of ${state.progress.totalUnits} units completed.`, failed: false }
    case "failed": return { title: "Processing failed", description: state.failure.message, failed: true }
    case "interrupted": return { title: "Processing interrupted", description: state.failure.message, failed: true }
    case "succeeded": return { title: "Processing complete", description: "The saved run completed. Reader and export are not connected yet.", failed: false }
    case "succeeded-with-issues": return { title: "Completed with issues", description: "The saved run completed with reported issues. Reader and export are not connected yet.", failed: false }
  }
}
