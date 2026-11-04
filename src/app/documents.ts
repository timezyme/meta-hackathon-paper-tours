import type { DocumentDetail, IdempotencyKey, Run, Stage, UploadPolicy } from "../domain/index.ts"

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

export const canChooseFile = ({ ready, uploading, attempt, allowance }: {
  readonly ready: boolean
  readonly uploading: boolean
  readonly attempt: Pick<UploadAttempt, "state"> | null
  readonly allowance: UploadPolicy["allowance"]
}): boolean => ready && !uploading && (attempt === null || attempt.state === "rejected")
  && (allowance === undefined || allowance.used < allowance.limit)

export const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${Number((bytes / (1024 * 1024)).toFixed(1))} MiB` : `${Math.max(1, Math.ceil(bytes / 1024))} KiB`
export const formatExpiry = (value: string): string => `${value.slice(0, 10)} at ${value.slice(11, 16)} UTC`
export const activeRun = (run: Pick<Run, "state">): boolean => run.state._tag === "queued" || run.state._tag === "running"
export const retryEligibility = (run: Pick<Run, "state">): "unavailable" | "retryable" | "unknown-completion" => {
  const state = run.state
  if ((state._tag !== "failed" && state._tag !== "interrupted") || !state.failure.retryable) return "unavailable"
  return state.failure.code === "provider-unknown-completion" ? "unknown-completion" : "retryable"
}
export const stageLabels: Record<typeof Stage.Type, { readonly name: string; readonly progress: string }> = {
  extraction: { name: "Extract document", progress: "Extracting pages" },
  "page-check": { name: "Check pages", progress: "Checking pages" },
  headings: { name: "Restore headings", progress: "Restoring headings" },
  figures: { name: "Describe figures", progress: "Describing figures" },
  assembly: { name: "Assemble document", progress: "Assembling the document" },
  guide: { name: "Prepare reading guide", progress: "Preparing your reading guide" },
  export: { name: "Prepare downloads", progress: "Preparing downloads" },
}

type Progress = Extract<Run["state"], { readonly _tag: "running" }>["progress"]
const stageOrder: ReadonlyArray<typeof Stage.Type> = ["extraction", "page-check", "headings", "figures", "assembly", "guide", "export"]
const plainStages: Record<typeof Stage.Type, { readonly step: string; readonly now: string; readonly unit?: string }> = {
  extraction: { step: "Read every page", now: "Muse is reading", unit: "page" },
  "page-check": { step: "Check each page against the original", now: "Muse is checking", unit: "page" },
  headings: { step: "Restore the headings", now: "Muse is restoring the headings" },
  figures: { step: "Describe the figures", now: "Muse is describing", unit: "figure" },
  assembly: { step: "Assemble the clean copy", now: "Assembling your clean copy" },
  guide: { step: "Write the reading guide", now: "Muse is writing your reading guide" },
  export: { step: "Prepare downloads", now: "Preparing your downloads" },
}

export const progressHeadline = ({ stage, completedUnits, totalUnits }: Progress): string => {
  const { now, unit } = plainStages[stage]
  if (unit === undefined) return now
  if (totalUnits === null || totalUnits === 0) return stage === "figures" ? "Looking for figures to describe" : `${now} the ${unit}s`
  if (completedUnits >= totalUnits) return `${now} the ${unit}s · all ${totalUnits} done`
  return `${now} ${unit} ${completedUnits + 1} of ${totalUnits}`
}

export type ProcessingStep = { readonly stage: typeof Stage.Type; readonly label: string; readonly state: "done" | "now" | "next"; readonly detail: string | null }
export const processingSteps = (run: Pick<Run, "state" | "configuration">): ReadonlyArray<ProcessingStep> => {
  const state = run.state
  const current = state._tag === "running" ? stageOrder.indexOf(state.progress.stage) : -1
  return stageOrder.filter((stage) => stage !== "guide" || run.configuration.guide !== undefined || (state._tag === "running" && state.progress.stage === "guide"))
    .map((stage) => {
      const index = stageOrder.indexOf(stage)
      const now = state._tag === "running" && index === current
      const detail = now && state.progress.totalUnits !== null && state.progress.totalUnits > 0
        ? `${state.progress.completedUnits} of ${state.progress.totalUnits} done` : null
      return { stage, label: plainStages[stage].step, state: index < current ? "done" : now ? "now" : "next", detail }
    })
}

export const elapsedLabel = (startedAt: string, now: number): string | null => {
  const started = Date.parse(startedAt)
  if (!Number.isFinite(started) || now < started) return null
  const seconds = Math.floor((now - started) / 1000)
  const minutes = Math.floor(seconds / 60)
  if (minutes >= 60) return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`
  return minutes === 0 ? `${seconds} s` : `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`
}

const longDocument = "This document is longer than one AmuseMe run can cover. Try a shorter PDF or an excerpt of a few pages. The original stays here to read."
export const failureCopy = (failure: { readonly code: string; readonly message: string }): { readonly title: string; readonly description: string } | null => {
  if (failure.code === "limit-exceeded") return { title: "This document is too long for one run", description: longDocument }
  return null
}

export const processingEstimate =
  "This usually takes several minutes. You can leave this page; your guide will be in your library when it’s ready."

type RunSummary = { readonly title: string; readonly description: string; readonly failed: boolean }
export const runSummary = (run: Pick<Run, "state">): RunSummary => {
  const state = run.state
  switch (state._tag) {
    case "queued": return { title: "Waiting for Muse to start", description: "Your document is saved and next in line.", failed: false }
    case "running": return { title: progressHeadline(state.progress), description: processingEstimate, failed: false }
    case "failed": return { ...failureCopy(state.failure) ?? { title: "Processing stopped", description: state.failure.message }, failed: true }
    case "interrupted": return { ...failureCopy(state.failure) ?? { title: "Processing interrupted", description: state.failure.message }, failed: true }
    case "succeeded": return { title: "Processing complete", description: "Your clean copy is ready to read and download.", failed: false }
    case "succeeded-with-issues": return { title: "Completed with issues", description: "Your clean copy is ready. Review the reported issues before using it.", failed: false }
  }
}
