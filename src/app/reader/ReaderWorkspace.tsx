import { EditionHead, PageReader } from "./ReaderContent.tsx"
import { useReaderActions, type CopyState, type Rating } from "./useReaderActions.ts"
import { useReaderOutput } from "./useReaderOutput.ts"
import { useFocusOnChange } from "../useFocusOnChange.ts"
import { useLocation } from "../Location.tsx"
import { useRef, useState } from "react"
import type { DocumentRecord } from "../documents.ts"
import { activeRun, runSummary } from "../documents.ts"
import { focusReadingPage, navigate } from "../client/browser.ts"
import { InternalLink } from "../links.tsx"
import {
  originalUrl, outputUrl, textDownloadName,
} from "../client/outputs.ts"
import type { OutputIdentity } from "../client/outputs.ts"
import type { CanonicalDocument, OutputRevisionId } from "../../domain/index.ts"
import { boundedPage } from "./presentation.ts"
import { useRoutePresentation } from "../useRoutePresentation.ts"
import { DocumentReadError } from "../DocumentReadError.tsx"
import { ReaderDrawer, ReportPanel, SourcePanel } from "./Panels.tsx"
import { DeleteDocumentControl } from "./DeleteDocument.tsx"
import { RetryDocumentControl } from "./RetryDocument.tsx"
import { GuideWorkspace } from "../guide/GuideWorkspace.tsx"
import { ProcessingProgress } from "../guide/ProcessingProgress.tsx"
import { guideLocation, type GuideRoute } from "../guide/navigation.ts"
import { documentTitle, paperHeading } from "../guide/presentation.ts"
import { countLabel } from "../text.ts"
import { GlyphText } from "../GlyphText.tsx"
import "./reader.css"

const copyLabels = { idle: "Copy entire normalized text", pending: "Copying…", done: "Copied all text" } as const
const copyLabel = (labels: Record<CopyState, string>, state: CopyState) =>
  state === "done" ? <GlyphText after="✓">{labels.done}</GlyphText> : labels[state]

const guideTitle = (route: GuideRoute, canonical: CanonicalDocument | undefined): string => {
  switch (route.mode) {
    case "walk": return `Step ${Math.min(route.n, canonical?.guide?.steps.length ?? 1)}`
    case "claims": return `Claim ${Math.min(route.n, canonical?.guide?.claims.length ?? 1)}`
    case "overview": return "Overview"
    case "map": return "Document map"
    case "done-walk":
    case "done-claims": return "Guide complete"
    case "choices": return "Your reading goal"
    case "read": return "Read the document"
  }
}

const imageSummary = (canonical: CanonicalDocument | undefined): string => {
  const available = canonical?.figures.filter((figure) => figure.asset._tag === "available").length ?? 0
  return available === 0 ? "No source images" : countLabel(available, "source image")
}

type OutputActionsProps = {
  readonly identity: OutputIdentity
  readonly copyState: CopyState
  readonly rating: Rating | null
  readonly ratingPending: boolean
  readonly message: string | null
  readonly onCopy: () => void
  readonly onRate: ((value: Rating) => void) | null
}

function OutputActions({ identity, copyState, rating, ratingPending, message, onCopy, onRate }: OutputActionsProps) {
  return <><div className="reader-downloads"><a className="button primary" href={outputUrl(identity, "zip")} download>
    <GlyphText before="↓">Download ZIP</GlyphText></a>
    <a className="reader-text-link" href={outputUrl(identity, "text")} download={textDownloadName(identity.documentId)}>
      Download text only</a>
    <a className="reader-text-link" href={originalUrl(identity.documentId)} download>Download original PDF</a>
    <button className="reader-text-link" type="button" onClick={onCopy} disabled={copyState === "pending"}>
      {copyLabel(copyLabels, copyState)}</button></div>
    {onRate !== null && <div className="reader-rating" role="group" aria-label="Rate this output"><span>Was this useful?</span>
      <button className="button" type="button" aria-pressed={rating === "up"} disabled={ratingPending} onClick={() => onRate("up")}>Yes</button>
      <button className="button" type="button" aria-pressed={rating === "down"} disabled={ratingPending} onClick={() => onRate("down")}>
        Needs work</button></div>}
    {message !== null && <p className="reader-small reader-action-status" role="status">{message}</p>}</>
}

const trustNote = (fullReader: boolean, canonical: CanonicalDocument): string => {
  if (fullReader) return "AI can change or miss content. Compare anything you rely on with the original."
  if (canonical.guide === undefined) return "The original PDF is available in Downloads & details."
  return "This guide is AI-written. Check the cited passages against the original document."
}

type WorkspaceProps = {
  readonly record: DocumentRecord
  readonly revisionId: OutputRevisionId
  readonly readOnly: boolean
  readonly onRefresh: () => void
  readonly onUnauthenticated: () => void
}

export function ReaderWorkspace({ record, revisionId, readOnly, onRefresh, onUnauthenticated }: WorkspaceProps) {
  const [drawer, setDrawer] = useState<"source" | "output" | null>(null)
  const [reviewIssues, setReviewIssues] = useState(false)
  const [pageNavigation, setPageNavigation] = useState<{ readonly page: number } | null>(null)
  const readingPage = useRef<HTMLElement>(null)
  const { guide: route, page: requestedPage } = useLocation()
  const view = route.view === "original" ? "original" : "clean"
  const identity: OutputIdentity = { documentId: record.document.id, revisionId }
  const { copyState, rating, ratingPending, message, copy, rate, setRating } = useReaderActions(identity, onUnauthenticated)
  const { data, error, loaded, retry } = useReaderOutput(identity, onUnauthenticated, setRating)
  const heading = data === null ? undefined : paperHeading(data.canonical)
  const paperTitle = (data === null ? undefined : documentTitle(data.canonical)) ?? record.document.originalFilename
  const main = useRoutePresentation(loaded, `${guideTitle(route, data?.canonical)} · ${paperTitle} · AmuseMe`)
  const page = data === null ? 1 : boundedPage(requestedPage, data.canonical.pages)
  useFocusOnChange(route.mode, () => {
    if (route.mode === "read" && readingPage.current !== null) focusReadingPage(readingPage.current)
  }, { enabled: data !== null })
  useFocusOnChange(pageNavigation, () => {
    if (readingPage.current !== null) focusReadingPage(readingPage.current)
  }, { enabled: pageNavigation !== null && pageNavigation.page === page })
  const onPage = (number: number) => {
    setPageNavigation({ page: number })
    setDrawer(null)
    setReviewIssues(false)
    navigate(guideLocation(record.document.id, { mode: "read", view }, number))
  }
  const closeDrawer = () => { setDrawer(null); setReviewIssues(false) }
  const reviewAll = () => { setReviewIssues(true); setDrawer("output") }
  const read = (nextView: "clean" | "original") => navigate(guideLocation(record.document.id, { mode: "read", view: nextView }, page))
  const source = data === null ? null : <SourcePanel record={record} canonical={data.canonical} page={page} onPage={onPage} />
  const output = data === null ? null : <><ReportPanel reviewing={reviewIssues} report={data.report} canonical={data.canonical} identity={identity} onPage={onPage} imageSummary={imageSummary(data.canonical)}>
    <OutputActions identity={identity} copyState={copyState} rating={rating} ratingPending={ratingPending} message={message} onCopy={copy} onRate={readOnly ? null : rate} />
  </ReportPanel>{readOnly
    ? <p className="reader-small">This is a shared example. You can read and download it, but only its owner can change or delete it.</p>
    : <DeleteDocumentControl record={record} onDeleted={() => navigate("/")} onUnauthenticated={onUnauthenticated} />}</>
  const summary = runSummary(record.latestRun)
  const fullReader = route.mode === "read"
  const titleInPage = view === "clean" && heading !== undefined && page === data?.canonical.pages[0].pageNumber
  const issueCount = data?.report.issues.length ?? 0
  return <main className={`reader-page live-reader${fullReader ? "" : " goal-reader"}`} id="main-content" ref={main} tabIndex={-1}>
    <div className="reader-toolbar">
      <InternalLink className="back-link" href="/"><GlyphText before="←">Your library</GlyphText></InternalLink>
      {data !== null && <div className="reader-utilities">
        {issueCount > 0 && <button className="reader-text-link reader-issue-link" type="button" aria-haspopup="dialog" onClick={reviewAll}>
          Review {countLabel(issueCount, "issue")}</button>}
        <button className="button reader-download-trigger" type="button" aria-haspopup="dialog" onClick={() => setDrawer("output")}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v10m-4-4 4 4 4-4M3 13v4h14v-4" /></svg>Downloads &amp; details</button>
      </div>}
    </div>
    {message !== null && drawer === null && <p className="reader-action-status" role="status">{message}
      {" "}{copyState === "idle" && <a className="reader-text-link" href={outputUrl(identity, "text")}
        download={textDownloadName(identity.documentId)}>Download text instead</a>}</p>}
    {(summary.failed || activeRun(record.latestRun)) && <section className="reader-run-notice" aria-label="Latest processing run">
      {activeRun(record.latestRun) ? <ProcessingProgress record={record} compact /> : <><h2>{summary.title}</h2><p>{summary.description}</p></>}
      <p>Your saved output remains available below.</p>
      {!readOnly && <RetryDocumentControl record={record} onRefresh={onRefresh} onUnauthenticated={onUnauthenticated} />}</section>}
    {data === null && error === null && <p className="reader-loading" role="status">Loading your normalized document…</p>}
    {error !== null && <DocumentReadError error={error} onRetry={retry} />}
    {data !== null && !fullReader && <GuideWorkspace record={record} canonical={data.canonical} route={route} page={page} />}
    {data !== null && fullReader && <EditionHead documentId={record.document.id} canonical={data.canonical} identity={identity} paperTitle={paperTitle}
      titleInPage={titleInPage} page={page} copyState={copyState} onCopy={copy} />}
    {data !== null && fullReader && <div className="reader-workspace">
      <aside className="reader-control reader-source" aria-label="Document source">{source}</aside>
      <PageReader canonical={data.canonical} identity={identity} view={view} page={page} readingPage={readingPage}
        onPage={onPage} onView={read} onPages={() => setDrawer("source")} /></div>}
    {data !== null && <p className="reader-trust-note">{trustNote(fullReader, data.canonical)}</p>}
    {drawer !== null && data !== null && <ReaderDrawer title={drawer === "source" ? "Document source" : "Downloads & details"} side={drawer}
      onClose={closeDrawer}>{drawer === "source" ? source : output}</ReaderDrawer>}
  </main>
}
