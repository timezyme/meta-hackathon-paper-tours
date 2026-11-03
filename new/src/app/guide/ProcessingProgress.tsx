import { useEffect, useState } from "react"
import type { DocumentRecord } from "../documents.ts"
import { activeRun, elapsedLabel, processingSteps, runSummary } from "../documents.ts"
import { subscribeClock } from "../client/browser.ts"

function Elapsed({ startedAt }: { readonly startedAt: string }) {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => subscribeClock(setNow), [])
  const label = now === null ? null : elapsedLabel(startedAt, now)
  return label === null ? null : <span className="progress-elapsed">Running for {label}</span>
}

const stepMark = { done: "✓", now: "", next: "" } as const
const stepState = { done: "Done", now: "In progress", next: "Up next" } as const

export function ProcessingProgress({ record, compact = false }: { readonly record: DocumentRecord; readonly compact?: boolean }) {
  const run = record.latestRun
  const summary = runSummary(run, record.document.pageCount)
  if (!activeRun(run)) return null
  const steps = processingSteps(run)
  const startedAt = run.state._tag === "running" ? run.state.startedAt : null
  return <section className={`processing-progress${compact ? " compact" : ""}`} aria-label="Processing progress">
    <div className="progress-head"><span className="progress-pulse" aria-hidden="true" />
      <div><p className="progress-headline" role="status">{summary.title}</p>
        <p className="progress-meta">{startedAt !== null && <Elapsed startedAt={startedAt} />}<span>{summary.description}</span></p></div></div>
    {!compact && <ol className="progress-steps">{steps.map((step) => <li key={step.stage} className={`progress-step is-${step.state}`}
      aria-current={step.state === "now" ? "step" : undefined}>
      <span className="progress-dot" aria-hidden="true">{stepMark[step.state]}</span>
      <span className="progress-label">{step.label}<span className="visually-hidden"> · {stepState[step.state]}</span></span>
      {step.detail !== null && <span className="progress-detail">{step.detail}</span>}
    </li>)}</ol>}
    {!compact && <p className="progress-note">You can leave this page. Muse keeps working, and your library shows when the guide is ready.</p>}
  </section>
}
