import { useEffect, useRef } from "react"
import type { KeyboardEvent, ReactNode } from "react"
import type { CanonicalDocument, ProcessingReport } from "../../domain/index.ts"
import type { DocumentRecord } from "../documents.ts"
import { formatBytes, formatExpiry } from "../documents.ts"
import { originalUrl, outputUrl, type OutputIdentity } from "../client/outputs.ts"
import { stageNames, receiptOutcome } from "./presentation.ts"
import { publicPrompt } from "../../domain/prompt-templates.ts"

export function ReaderDrawer({ title, side, children, onClose, busy = false }: { readonly title: string; readonly side: "source" | "output"; readonly children: ReactNode; readonly onClose: () => void; readonly busy?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const node = dialog.current
    const previous = node?.ownerDocument.activeElement
    node?.showModal()
    return () => { node?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  useEffect(() => { if (busy) dialog.current?.focus() }, [busy])
  return <dialog className={`reader-drawer reader-drawer-${side}`} ref={dialog} tabIndex={-1} aria-label={title} aria-busy={busy} onKeyDown={containFocus} onCancel={(event) => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose() }} onClick={(event) => { if (!busy && event.target === event.currentTarget) onClose() }}><div className="drawer-content"><div className="drawer-heading"><h2>{title}</h2><button className="button" type="button" disabled={busy} onClick={onClose}>Close</button></div>{children}</div></dialog>
}

const containFocus = (event: KeyboardEvent<HTMLDialogElement>): void => {
  if (event.key !== "Tab") return
  event.stopPropagation()
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], summary, [tabindex="0"]')).filter((item) => item.getClientRects().length > 0)
  const first = items[0]
  const last = items.at(-1)
  if (first === undefined) { event.preventDefault(); event.currentTarget.focus() }
  else if (event.shiftKey && event.currentTarget.ownerDocument.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && event.currentTarget.ownerDocument.activeElement === last) { event.preventDefault(); first?.focus() }
}

export function PageNavigation({ pages, page, onPage }: { readonly pages: CanonicalDocument["pages"]; readonly page: number; readonly onPage: (number: number) => void }) {
  const index = pages.findIndex((item) => item.pageNumber === page)
  const previous = pages[index - 1]
  const next = pages[index + 1]
  return <nav className="reader-page-nav" aria-label="Document pages"><button className="button" type="button" aria-label="Previous page" disabled={previous === undefined} onClick={() => { if (previous !== undefined) onPage(previous.pageNumber) }}>←</button><span>Page {page} of {pages.length}</span><button className="button" type="button" aria-label="Next page" disabled={next === undefined} onClick={() => { if (next !== undefined) onPage(next.pageNumber) }}>→</button></nav>
}

export function SourcePanel({ record, canonical, page, onPage }: { readonly record: DocumentRecord; readonly canonical: CanonicalDocument; readonly page: number; readonly onPage: (number: number) => void }) {
  return <><h2 className="reader-pane-heading">SOURCE</h2><div className="reader-source-file"><svg viewBox="0 0 24 28" aria-hidden="true"><path d="M4 2h10l6 6v18H4ZM14 2v7h6M8 14h8M8 19h6" /></svg><div><strong>{record.document.originalFilename}</strong><small>Original document</small></div></div><dl className="reader-facts"><dt>Format</dt><dd>PDF</dd><dt>Pages</dt><dd>{canonical.pages.length}</dd><dt>File size</dt><dd>{formatBytes(record.document.byteCount)}</dd></dl><a className="reader-text-link" href={originalUrl(record.document.id)} target="_blank" rel="noreferrer">Open original ↗</a><div className="reader-source-pages"><span className="reader-section-label">IN THIS DOCUMENT</span><PageNavigation pages={canonical.pages} page={page} onPage={onPage} /></div><p className="reader-small">Available until {formatExpiry(record.document.expiresAt)}.</p></>
}

export function ReportPanel({ report, identity, onPage }: { readonly report: ProcessingReport; readonly identity: OutputIdentity; readonly onPage: (number: number) => void }) {
  return <><details className="reader-details"><summary>Processing report</summary><dl className="reader-facts"><dt>Blocks updated</dt><dd>{report.changes.changedBlockIds.length}</dd><dt>Headings changed</dt><dd>{report.changes.changedHeadingCount}</dd><dt>Paragraph joins</dt><dd>{report.changes.appliedJoinCount}</dd><dt>Unresolved issues</dt><dd>{report.issues.length}</dd><dt>Verified corrections</dt><dd>{report.verifiedCorrectionCount._tag === "measured" ? report.verifiedCorrectionCount.count : "Not measured"}</dd><dt>Ambiguity count</dt><dd>{report.ambiguity._tag === "measured" ? report.ambiguity.count : "Not measured"}</dd></dl><p className="reader-small">Recorded changes are not a count of verified fixes.</p>{report.ambiguity._tag === "unavailable" && <p className="reader-small">{report.ambiguity.reason}</p>}{report.verifiedCorrectionCount._tag === "unavailable" && <p className="reader-small">{report.verifiedCorrectionCount.reason}</p>}{report.issues.map((issue, index) => <div className="reader-issue" key={`${issue.code}-${index}`}><strong>{stageNames[issue.stage]}</strong><p>{issue.message}</p><button className="reader-text-link" type="button" onClick={() => onPage(issue.locations[0].pageNumber)}>Go to page {issue.locations[0].pageNumber} →</button></div>)}<div className="reader-report-downloads"><a className="reader-text-link" href={outputUrl(identity, "report")} download>Download processing report ↓</a><a className="reader-text-link" href={outputUrl(identity, "canonical")} download="document.json">Download document JSON ↓</a></div></details>
    <details className="reader-details"><summary>How this was produced</summary>{report.receipts.map(({ receipt, delivery }, index) => {
      const config = receipt.configuration
      const completed = receipt.state._tag === "completed" ? receipt.state : null
      const usage = completed?.usage
      const prompt = config._tag === "model" ? publicPrompt(config.promptName, config.promptVersion) : null
      return <details className="reader-stage" key={receipt.id}><summary><span>{String(index + 1).padStart(2, "0")}</span><span>{stageNames[receipt.stage]}<small>{config._tag === "model" ? config.model : config.provider} · {receiptOutcome(receipt)}</small></span></summary><dl className="reader-run-facts"><dt>Delivery</dt><dd>{delivery === "reused" ? "Reused saved response" : "Performed in this run"}</dd><dt>Provider</dt><dd>{config.provider}</dd>{config._tag === "model" ? <><dt>Model</dt><dd>{config.model}</dd><dt>Reasoning effort</dt><dd>{config.reasoning}</dd><dt>Prompt</dt><dd>{config.promptName} · {config.promptVersion}</dd><dt>Output token ceiling</dt><dd>{config.maxOutputTokens}</dd></> : <><dt>Version</dt><dd>{config.version}</dd></>}<dt>Target</dt><dd>{receipt.figureId ?? (receipt.pageIds.length > 0 ? receipt.pageIds.join(", ") : "Document")}</dd><dt>Input tokens</dt><dd>{usage?._tag === "reported" ? usage.inputTokens ?? "Unavailable" : "Unavailable"}</dd><dt>Output tokens</dt><dd>{usage?._tag === "reported" ? usage.outputTokens ?? "Unavailable" : "Unavailable"}</dd><dt>Reported cost</dt><dd>{usage?._tag === "reported" && usage.costUsd !== null ? `$${usage.costUsd}` : "Unavailable"}</dd><dt>Duration</dt><dd>{completed === null ? "Unavailable" : `${(completed.durationMilliseconds / 1000).toFixed(1)} seconds`}</dd></dl>{prompt !== null ? <details className="reader-prompt"><summary>Public prompt template</summary><pre>{prompt}</pre></details> : config._tag === "model" && <p className="reader-small">A public template is unavailable for this prompt version.</p>}{receipt.state._tag === "failed" && <p className="reader-small">{receipt.state.failure.message}</p>}{completed?.validation._tag === "rejected" && <p className="reader-small">{completed.validation.failure.message}</p>}{receipt.state._tag === "unknown-completion" && <p className="reader-small">{receipt.state.reason}</p>}</details>
    })}<p className="reader-small">Settings come from saved attempts. Usage is shown only when reported by the provider.</p></details></>
}
