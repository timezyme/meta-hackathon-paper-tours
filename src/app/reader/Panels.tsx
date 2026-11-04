import { useFocusOnChange } from "../useFocusOnChange.ts"
import { useLayoutEffect, useRef } from "react"
import type { KeyboardEvent, ReactNode } from "react"
import type { CanonicalDocument, ProcessingReport, StageReceipt } from "../../domain/index.ts"
import type { DocumentRecord } from "../documents.ts"
import { formatBytes, formatExpiry, stageLabels } from "../documents.ts"
import { openProcessingReport } from "../client/browser.ts"
import { originalUrl, outputUrl, type OutputIdentity } from "../client/outputs.ts"
import { receiptOutcome } from "./presentation.ts"
import { publicPrompt } from "../../domain/prompt-templates.ts"
import { countLabel, headingText } from "../text.ts"
import { GlyphText } from "../GlyphText.tsx"

type DrawerProps = {
  readonly title: string
  readonly side: "source" | "output"
  readonly children: ReactNode
  readonly onClose: () => void
  readonly busy?: boolean
}

export function ReaderDrawer({ title, side, children, onClose, busy = false }: DrawerProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const node = dialog.current
    const previous = node?.ownerDocument.activeElement
    node?.showModal()
    return () => { node?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  useFocusOnChange(busy, () => { if (busy) dialog.current?.focus() }, { onMount: true })
  return <dialog className={`reader-drawer reader-drawer-${side}`} ref={dialog} tabIndex={-1} aria-label={title} aria-busy={busy} onKeyDown={containFocus}
    onCancel={(event) => { event.preventDefault(); event.stopPropagation(); if (!busy) onClose() }}
    onClick={(event) => { if (!busy && event.target === event.currentTarget) onClose() }}>
    <div className="drawer-content"><div className="drawer-heading"><h2>{title}</h2>
      <button className="button" type="button" disabled={busy} onClick={onClose}>Close</button></div>{children}</div>
  </dialog>
}

const containFocus = (event: KeyboardEvent<HTMLDialogElement>): void => {
  if (event.key !== "Tab") return
  event.stopPropagation()
  const focusable = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], summary, [tabindex="0"]')
  const items = Array.from(focusable).filter((item) => item.getClientRects().length > 0)
  const first = items[0]
  const last = items.at(-1)
  if (first === undefined) { event.preventDefault(); event.currentTarget.focus() }
  else if (event.shiftKey && event.currentTarget.ownerDocument.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && event.currentTarget.ownerDocument.activeElement === last) { event.preventDefault(); first?.focus() }
}

type PageProps = { readonly page: number; readonly onPage: (number: number) => void }
type PageTarget = { readonly pageNumber: number } | undefined

type PageButtonProps = Pick<PageProps, "onPage"> & { readonly target: PageTarget; readonly label: string; readonly children: ReactNode }

function PageButton({ target, label, onPage, children }: PageButtonProps) {
  return <button className="button" type="button" aria-label={label} disabled={target === undefined}
    onClick={() => { if (target !== undefined) onPage(target.pageNumber) }}>{children}</button>
}

export function PageNavigation({ pages, page, onPage }: PageProps & { readonly pages: ReadonlyArray<{ readonly pageNumber: number }> }) {
  const index = pages.findIndex((item) => item.pageNumber === page)
  return <nav className="reader-page-nav" aria-label="Document pages">
    <PageButton target={pages[index - 1]} label="Previous page" onPage={onPage}>←</PageButton>
    <span>Page {page} of {pages.length}</span>
    <PageButton target={pages[index + 1]} label="Next page" onPage={onPage}>→</PageButton>
  </nav>
}

function SectionNavigation({ canonical, onPage }: Pick<PageProps, "onPage"> & { readonly canonical: CanonicalDocument }) {
  const sections = canonical.blocks.filter((block) => block.kind === "heading" && (block.headingLevel ?? 1) <= 2)
  return <nav className="reader-section-nav" aria-label="Document sections">{sections.map((block) => {
    const sectionPage = block.locations[0].pageNumber
    return <button key={block.id} type="button" onClick={() => onPage(sectionPage)}>{headingText(block.content)}<small>Page {sectionPage}</small></button>
  })}</nav>
}

export function SourcePanel({ record, canonical, page, onPage }: PageProps & { readonly record: DocumentRecord; readonly canonical: CanonicalDocument }) {
  return <><h2 className="reader-pane-heading">SOURCE</h2>
    <div className="reader-source-file"><svg viewBox="0 0 24 28" aria-hidden="true"><path d="M4 2h10l6 6v18H4ZM14 2v7h6M8 14h8M8 19h6" /></svg>
      <div><strong>{record.document.originalFilename}</strong><small>Original document</small></div></div>
    <dl className="reader-facts"><dt>Format</dt><dd>PDF</dd><dt>Pages</dt><dd>{canonical.pages.length}</dd>
      <dt>File size</dt><dd>{formatBytes(record.document.byteCount)}</dd></dl>
    <a className="reader-text-link" href={originalUrl(record.document.id)} target="_blank" rel="noreferrer">
      <GlyphText after="↗">Open original</GlyphText></a>
    <div className="reader-source-pages"><span className="reader-section-label">IN THIS DOCUMENT</span>
      <PageNavigation pages={canonical.pages} page={page} onPage={onPage} /></div>
    <SectionNavigation canonical={canonical} onPage={onPage} />
    <p className="reader-small">Available until {formatExpiry(record.document.expiresAt)}.</p></>
}

type ReportProps = {
  readonly reviewing?: boolean
  readonly report: ProcessingReport
  readonly canonical?: CanonicalDocument
  readonly identity: OutputIdentity
  readonly onPage: (number: number) => void
  readonly imageSummary: string
  readonly children?: ReactNode
}

const measured = (value: ProcessingReport["ambiguity"]) => value._tag === "measured" ? value.count : "Not measured"

function ReportFacts({ report }: { readonly report: ProcessingReport }) {
  return <dl className="reader-facts"><dt>Blocks updated</dt><dd>{report.changes.changedBlockIds.length}</dd>
    <dt>Headings changed</dt><dd>{report.changes.changedHeadingCount}</dd><dt>Paragraph joins</dt><dd>{report.changes.appliedJoinCount}</dd>
    <dt>Unresolved issues</dt><dd>{report.issues.length}</dd><dt>Verified corrections</dt><dd>{measured(report.verifiedCorrectionCount)}</dd>
    <dt>Ambiguity count</dt><dd>{measured(report.ambiguity)}</dd></dl>
}

type Review = NonNullable<ProcessingReport["museReviews"]>[number]
const keptByFallback: Partial<Record<Review["stage"], string>> = {
  "page-check": "Muse checked this and kept the original text.",
  headings: "Muse checked this and kept the original headings.",
  figures: "Muse checked this and published the figure without an AI description.",
  guide: "Muse checked this and published the document without a reading guide.",
}
const reviewLine = (review: Review, pages: ReadonlyArray<number>): string => {
  const where = pages.length === 0 ? (review.figureId === null ? "" : " a figure") : ` page${pages.length === 1 ? "" : "s"} ${pages.join(", ")}`
  if (review.outcome === "corrected") return `Muse’s check caught a problem${where ? ` on${where}` : ""} and a second review fixed it.`
  return `${keptByFallback[review.stage] ?? "Muse checked this and kept the safe original."}${where ? ` (${where.trim()})` : ""}`
}

function MuseChecks({ report, canonical }: { readonly report: ProcessingReport; readonly canonical: CanonicalDocument | undefined }) {
  const reviews = report.museReviews ?? []
  if (reviews.length === 0) return null
  const pageNumber = (id: string) => canonical?.pages.find((page) => page.id === id)?.pageNumber
  return <section className="reader-muse-checks" aria-labelledby="muse-checks-title"><h3 id="muse-checks-title">What Muse double-checked</h3>
    <ul>{reviews.map((review, index) => <li key={`${review.stage}-${index}`} className={review.outcome}>
      <strong>{stageLabels[review.stage].name}</strong>
      <span>{reviewLine(review, review.pageIds.flatMap((id) => { const number = pageNumber(id); return number === undefined ? [] : [number] }))}</span>
    </li>)}</ul></section>
}

const issueLead = (issue: ProcessingReport["issues"][number], report: ProcessingReport): string | null =>
  issue.code === "provider-failure" && (report.museReviews ?? []).some((review) => review.outcome === "fallback" && review.stage === issue.stage)
    ? keptByFallback[issue.stage as Review["stage"]] ?? null : null

function ReportIssues({ report, onPage }: Pick<ReportProps, "report" | "onPage">) {
  return report.issues.map((issue, index) => {
    const issuePage = issue.locations[0].pageNumber
    const lead = issueLead(issue, report)
    return <div className="reader-issue" key={`${issue.code}-${index}`}><strong>{stageLabels[issue.stage].name} · page {issuePage}</strong>
      {lead !== null && <p className="reader-issue-lead">{lead}</p>}<p>{issue.message}</p>
      <button className="reader-text-link" type="button" onClick={() => onPage(issuePage)}>
        <GlyphText after="→">Compare page {issuePage}</GlyphText></button></div>
  })
}

function ReportDownloads({ identity }: { readonly identity: OutputIdentity }) {
  return <div className="reader-report-downloads">
    <a className="reader-text-link" href={outputUrl(identity, "report")} download>
      <GlyphText after="↓">Download processing report</GlyphText></a>
    <a className="reader-text-link" href={outputUrl(identity, "canonical")} download="document.json">
      <GlyphText after="↓">Download document JSON</GlyphText></a></div>
}

const outputSummary = (issueCount: number): string => issueCount === 0 ? "Ready to read and use." : `Ready with ${countLabel(issueCount, "issue")}.`

export function ReportPanel({ report, canonical, identity, onPage, imageSummary, children, reviewing = false }: ReportProps) {
  const details = useRef<HTMLDetailsElement>(null)
  const summary = useRef<HTMLElement>(null)
  const issueCount = report.issues.length
  const review = () => { if (details.current !== null && summary.current !== null) openProcessingReport(details.current, summary.current) }
  useFocusOnChange(reviewing, () => { if (reviewing) review() }, { onMount: true })
  return <><h2 className="reader-pane-heading">OUTPUT</h2>
    <p className="reader-output-summary">{outputSummary(issueCount)}<span>Normalized text · {imageSummary}</span></p>
    {issueCount > 0 && <button className="reader-text-link reader-review-issues" type="button" onClick={review}>
      <GlyphText after="→">Review {issueCount === 1 ? "issue" : "issues"}</GlyphText></button>}
    {children}
    <MuseChecks report={report} canonical={canonical} />
    <details className="reader-details" ref={details}><summary ref={summary}>Processing report</summary><ReportFacts report={report} />
      <p className="reader-small">Recorded changes are not a count of verified fixes.</p>
      {report.ambiguity._tag === "unavailable" && <p className="reader-small">{report.ambiguity.reason}</p>}
      {report.verifiedCorrectionCount._tag === "unavailable" && <p className="reader-small">{report.verifiedCorrectionCount.reason}</p>}
      <ReportIssues report={report} onPage={onPage} /><ReportDownloads identity={identity} /></details>
    <details className="reader-details"><summary>How this was produced</summary>
      {report.receipts.map(({ receipt, delivery }, index) => <ReceiptStage key={receipt.id} receipt={receipt} delivery={delivery} index={index} />)}
      <p className="reader-small">Settings come from saved attempts. Usage is shown only when reported by the provider.</p></details></>
}

type Delivery = ProcessingReport["receipts"][number]["delivery"]
type Completed = Extract<StageReceipt["state"], { readonly _tag: "completed" }>
type Usage = Completed["usage"] | undefined

const reportedTokens = (usage: Usage, key: "inputTokens" | "outputTokens") => usage?._tag === "reported" ? usage[key] ?? "Unavailable" : "Unavailable"
const reportedCost = (usage: Usage) => usage?._tag === "reported" && usage.costUsd !== null ? `$${usage.costUsd}` : "Unavailable"
const duration = (completed: Completed | null) => completed === null ? "Unavailable" : `${(completed.durationMilliseconds / 1000).toFixed(1)} seconds`
const receiptTarget = (receipt: StageReceipt) => receipt.figureId ?? (receipt.pageIds.length > 0 ? receipt.pageIds.join(", ") : "Document")

function ReceiptStage({ receipt, delivery, index }: { readonly receipt: StageReceipt; readonly delivery: Delivery; readonly index: number }) {
  const config = receipt.configuration
  const model = config._tag === "model" ? config : config.model
  const completed = receipt.state._tag === "completed" ? receipt.state : null
  const usage = completed?.usage
  const prompt = model === undefined ? null : publicPrompt(model.promptName, model.promptVersion)
  return <details className="reader-stage"><summary><span>{String(index + 1).padStart(2, "0")}</span>
    <span>{stageLabels[receipt.stage].name}<small>{model?.model ?? config.provider} · {receiptOutcome(receipt)}</small></span></summary>
    <dl className="reader-run-facts"><dt>Delivery</dt><dd>{delivery === "reused" ? "Reused saved response" : "Performed in this run"}</dd>
      <dt>Provider</dt><dd>{config.provider}</dd>
      {model !== undefined ? <><dt>Model</dt><dd>{model.model}</dd><dt>Reasoning effort</dt><dd>{model.reasoning}</dd>
        <dt>Prompt</dt><dd>{model.promptName} · {model.promptVersion}</dd><dt>Output token ceiling</dt><dd>{model.maxOutputTokens}</dd></>
        : <><dt>Version</dt><dd>{config._tag === "extraction" ? config.version : "Unavailable"}</dd></>}
      <dt>Target</dt><dd>{receiptTarget(receipt)}</dd>
      <dt>Input tokens</dt><dd>{reportedTokens(usage, "inputTokens")}</dd><dt>Output tokens</dt><dd>{reportedTokens(usage, "outputTokens")}</dd>
      <dt>Reported cost</dt><dd>{reportedCost(usage)}</dd><dt>Duration</dt><dd>{duration(completed)}</dd></dl>
    {prompt !== null ? <details className="reader-prompt"><summary>Public prompt template</summary><pre>{prompt}</pre></details>
      : model !== undefined && <p className="reader-small">A public template is unavailable for this prompt version.</p>}
    {receipt.state._tag === "failed" && <p className="reader-small">{receipt.state.failure.message}</p>}
    {completed?.validation._tag === "rejected" && <p className="reader-small">{completed.validation.failure.message}</p>}
    {receipt.state._tag === "unknown-completion" && <p className="reader-small">{receipt.state.reason}</p>}
  </details>
}
