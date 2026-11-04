import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { DocumentRecord } from "../documents.ts"
import { activeRun, runSummary } from "../documents.ts"
import { focusReadingPage, navigate, readLocation, subscribeLocation } from "../client/browser.ts"
import { runDocument } from "../client/documents.ts"
import { copyNormalizedText, originalUrl, outputUrl, readOutputs, saveRating, type OutputData, type OutputIdentity } from "../client/outputs.ts"
import type { OutputRevisionId, RatingValue } from "../../domain/index.ts"
import { blockPage, blocksOnPage, continuationsOnPage, pageFromLocation, pageLocation } from "./presentation.ts"
import { ReaderBlock } from "./ReaderBlock.tsx"
import { ReaderDrawer, ReportPanel, SourcePanel } from "./Panels.tsx"
import { DeleteDocumentControl } from "./DeleteDocument.tsx"
import { RetryDocumentControl } from "./RetryDocument.tsx"
import "./reader.css"

export function ReaderWorkspace({ record, revisionId, onRefresh, onUnauthenticated }: { readonly record: DocumentRecord; readonly revisionId: OutputRevisionId; readonly onRefresh: () => void; readonly onUnauthenticated: () => void }) {
  const [version, setVersion] = useState(0)
  const [snapshot, setSnapshot] = useState<{ readonly version: number; readonly data: OutputData | null; readonly error: string | null }>({ version: 0, data: null, error: null })
  const [drawer, setDrawer] = useState<"source" | "output" | null>(null)
  const [copyState, setCopyState] = useState<"idle" | "pending" | "done">("idle")
  const [rating, setRating] = useState<typeof RatingValue.Type | null>(null)
  const [ratingPending, setRatingPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [pageNavigation, setPageNavigation] = useState<{ readonly page: number } | null>(null)
  const completedPageNavigation = useRef(pageNavigation)
  const readingPage = useRef<HTMLElement>(null)
  const lock = useRef({ copy: false, rating: false })
  const cancelCopy = useRef<(() => void) | undefined>(undefined)
  const cancelRating = useRef<(() => void) | undefined>(undefined)
  const location = useSyncExternalStore(subscribeLocation, readLocation)
  const identity: OutputIdentity = { documentId: record.document.id, revisionId }
  const data = snapshot.version === version ? snapshot.data : null
  const availableImages = data?.canonical.figures.filter((figure) => figure.asset._tag === "available").length ?? 0
  const imageSummary = availableImages === 0 ? "No original images" : `${availableImages} original ${availableImages === 1 ? "image" : "images"}`
  useEffect(() => runDocument(readOutputs({ documentId: record.document.id, revisionId }), (output) => {
    setSnapshot({ version, data: output, error: null })
    setRating(output.rating)
  }, (error) => {
    if (error.kind === "unauthenticated") onUnauthenticated()
    else setSnapshot({ version, data: null, error: error.message })
  }), [record.document.id, revisionId, version, onUnauthenticated])
  useEffect(() => () => { cancelCopy.current?.(); cancelRating.current?.() }, [])
  const page = data === null ? 1 : pageFromLocation(location, data.canonical.pages)
  useEffect(() => {
    if (pageNavigation === null || completedPageNavigation.current === pageNavigation || pageNavigation.page !== page || readingPage.current === null) return
    completedPageNavigation.current = pageNavigation
    focusReadingPage(readingPage.current)
  }, [page, pageNavigation])
  const onPage = (number: number) => {
    setPageNavigation({ page: number })
    setDrawer(null)
    navigate(pageLocation(record.document.id, number))
  }
  const onFailure = (error: { readonly kind: string; readonly message: string }) => {
    setMessage(error.message)
    if (error.kind === "unauthenticated") onUnauthenticated()
  }
  const copy = () => {
    if (lock.current.copy) return
    lock.current.copy = true
    setCopyState("pending")
    setMessage(null)
    cancelCopy.current = runDocument(copyNormalizedText(identity), () => { lock.current.copy = false; setCopyState("done"); setMessage("The entire normalized text was copied.") }, (error) => { lock.current.copy = false; setCopyState("idle"); onFailure(error) })
  }
  const rate = (value: typeof RatingValue.Type) => {
    if (lock.current.rating) return
    lock.current.rating = true
    setRatingPending(true)
    setMessage(null)
    cancelRating.current = runDocument(saveRating(identity, rating === value ? null : value), (saved) => { lock.current.rating = false; setRatingPending(false); setRating(saved); setMessage(saved === null ? "Your rating was removed." : "Your rating was saved.") }, (error) => { lock.current.rating = false; setRatingPending(false); onFailure(error) })
  }
  const source = data === null ? null : <SourcePanel record={record} canonical={data.canonical} page={page} onPage={onPage} />
  const output = data === null ? null : <><h2 className="reader-pane-heading">OUTPUT</h2><p className="reader-output-summary">Ready to read and use.<span>Normalized text · {imageSummary}</span></p><div className="reader-downloads"><a className="button primary" href={outputUrl(identity, "zip")} download>↓ Download ZIP</a><a className="reader-text-link" href={outputUrl(identity, "text")} download>Download text only</a><a className="reader-text-link" href={originalUrl(identity.documentId)} download>Download original PDF</a><button className="reader-text-link" type="button" onClick={copy} disabled={copyState === "pending"}>{copyState === "pending" ? "Copying…" : copyState === "done" ? "Copied all text ✓" : "Copy entire normalized text"}</button></div><div className="reader-rating" role="group" aria-label="Rate this output"><span>Was this useful?</span><button className="button" type="button" aria-label="Rate output positively" aria-pressed={rating === "up"} disabled={ratingPending} onClick={() => rate("up")}>Yes</button><button className="button" type="button" aria-label="Rate output negatively" aria-pressed={rating === "down"} disabled={ratingPending} onClick={() => rate("down")}>Needs work</button></div>{message !== null && <p className="reader-small reader-action-status" role="status">{message}</p>}<ReportPanel report={data.report} identity={identity} onPage={onPage} /><DeleteDocumentControl record={record} onDeleted={() => navigate("/")} onUnauthenticated={onUnauthenticated} /></>
  const blocks = data === null ? [] : blocksOnPage(data.canonical, page)
  const continuations = data === null ? [] : continuationsOnPage(data.canonical, page)
  const nextPage = data?.canonical.pages.find((item) => item.pageNumber > page)
  const summary = runSummary(record.latestRun)
  return <main className="reader-page" id="main-content"><div className="reader-toolbar"><a className="back-link" href="/" onClick={(event) => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate("/") } }}>← All documents</a>{data !== null && <div className="reader-state"><span className={data.report.issues.length > 0 ? "reader-has-issues" : ""}>● {data.report.issues.length > 0 ? `Ready · ${data.report.issues.length} ${data.report.issues.length === 1 ? "issue" : "issues"}` : "Ready to download"}</span><span>{data.canonical.pages.length} {data.canonical.pages.length === 1 ? "page" : "pages"} · {data.canonical.figures.length} {data.canonical.figures.length === 1 ? "figure" : "figures"}</span></div>}</div>
    {(summary.failed || activeRun(record.latestRun)) && <section className="reader-run-notice" aria-label="Latest processing run"><h2>{summary.title}</h2><p>{summary.description} Your saved output remains available below.</p><RetryDocumentControl record={record} onRefresh={onRefresh} onUnauthenticated={onUnauthenticated} /></section>}
    {data === null && snapshot.error === null && <p className="reader-loading" role="status">Loading your normalized document…</p>}
    {snapshot.error !== null && <section className="message error" role="alert"><p>{snapshot.error}</p><button className="button" type="button" onClick={() => { setSnapshot({ version: version + 1, data: null, error: null }); setVersion((value) => value + 1) }}>Try again</button></section>}
    {data !== null && <div className="reader-workspace"><aside className="reader-control reader-source" aria-label="Document source">{source}</aside><section className="reading-surface" aria-label="Processed document output"><div className="reading-bar"><button className="reader-edge" type="button" aria-label="Open document source" onClick={() => setDrawer("source")}>☰</button><span>NORMALIZED DOCUMENT</span><span>PAGE {String(page).padStart(2, "0")} / {String(data.canonical.pages.length).padStart(2, "0")}</span><button className="reader-edge" type="button" aria-label="Open output details" onClick={() => setDrawer("output")}>⋯</button></div><article className="paper-content" ref={readingPage} tabIndex={-1} aria-label={`Normalized document page ${page}`}>
      {continuations.map((block) => <p className="reader-continuation" key={block.id}>Text from this page continues a paragraph on <button type="button" onClick={() => onPage(blockPage(block))}>page {blockPage(block)} →</button></p>)}
      {blocks.map((block) => <ReaderBlock key={block.id} block={block} canonical={data.canonical} identity={identity} />)}
      {blocks.length === 0 && continuations.length === 0 && <p className="reader-small">No text or figures were extracted from this page. <a href={`${originalUrl(identity.documentId)}#page=${page}`} target="_blank" rel="noreferrer">View the original page.</a></p>}
    </article><footer className="reading-footer"><span>END OF PAGE {page}</span>{nextPage === undefined ? <span>End of document</span> : <button type="button" className="reader-text-link" onClick={() => onPage(nextPage.pageNumber)}>Continue to page {nextPage.pageNumber} →</button>}</footer></section><aside className="reader-control reader-output" aria-label="Output details">{output}</aside></div>}
    {drawer !== null && data !== null && <ReaderDrawer title={drawer === "source" ? "Document source" : "Output details"} side={drawer} onClose={() => setDrawer(null)}>{drawer === "source" ? source : output}</ReaderDrawer>}
  </main>
}
