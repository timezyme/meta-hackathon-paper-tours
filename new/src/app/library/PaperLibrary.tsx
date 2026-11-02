import { useEffect, useState } from "react"
import type { MouseEvent } from "react"
import type { OutputRevisionId } from "../../domain/index.ts"
import { navigate } from "../client/browser.ts"
import { runDocument } from "../client/documents.ts"
import { originalUrl, outputUrl, previewUrl, readPublishedDocument } from "../client/outputs.ts"
import { activeRun, formatBytes, formatExpiry, runSummary, type DocumentRecord } from "../documents.ts"
import { guideLocation } from "../guide/navigation.ts"
import { DeleteDocumentControl } from "../reader/DeleteDocument.tsx"
import { RetryDocumentControl } from "../reader/RetryDocument.tsx"
import { featuredPaper, paperPreview } from "./presentation.ts"

type Controls = {
  readonly retryEnabled: boolean
  readonly onDeleted: () => void
  readonly onRefresh: () => void
  readonly onUnauthenticated: () => void
}

export const openLibraryLink = (event: MouseEvent<HTMLAnchorElement>, path: string) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  navigate(path)
}

const fileTitle = (record: DocumentRecord) => record.document.originalFilename.replace(/\.pdf$/iu, "") || record.document.originalFilename
const pageCount = (record: DocumentRecord) => `${record.document.pageCount} ${record.document.pageCount === 1 ? "page" : "pages"}`

function PaperDetails({ record, controls }: { readonly record: DocumentRecord; readonly controls: Controls }) {
  const id = record.document.id
  return <details className="library-details"><summary>Paper details</summary><div className="library-detail-body">
    <dl><div><dt>Original file</dt><dd>{record.document.originalFilename}</dd></div><div><dt>File size</dt><dd>{formatBytes(record.document.byteCount)}</dd></div><div><dt>Available until</dt><dd>{formatExpiry(record.document.expiresAt)}</dd></div></dl>
    <div className="library-file-actions">{record.currentRevisionId !== null && <a className="reader-text-link" href={outputUrl({ documentId: id, revisionId: record.currentRevisionId }, "text")} download="normalized.txt" aria-label={`Download text for ${record.document.originalFilename}`}>Download text</a>}<a className="reader-text-link" href={originalUrl(id)} download>Download original PDF</a></div>
    <DeleteDocumentControl record={record} onDeleted={controls.onDeleted} onUnauthenticated={controls.onUnauthenticated} />
  </div></details>
}

function RunNotice({ record, controls }: { readonly record: DocumentRecord; readonly controls: Controls }) {
  const summary = runSummary(record.latestRun)
  if (summary.failed) return <div className="library-run-notice failed"><p><strong>{summary.title}.</strong> {summary.description}{record.currentRevisionId !== null && " Your saved copy is still available."}</p>{controls.retryEnabled && <RetryDocumentControl record={record} onRefresh={controls.onRefresh} onUnauthenticated={controls.onUnauthenticated} />}</div>
  if (activeRun(record.latestRun)) return <p className="library-run-notice"><strong>{summary.title}.</strong> {summary.description}</p>
  if (record.latestRun.state._tag === "succeeded-with-issues") return <p className="library-run-notice failed">This paper has reported issues. You can review them in the reader.</p>
  return null
}

function PaperCover({ record }: { readonly record: DocumentRecord }) {
  const [failed, setFailed] = useState(false)
  const path = guideLocation(record.document.id, { mode: "read", view: "original" }, 1)
  return <a className="library-cover" href={path} onClick={(event) => openLibraryLink(event, path)} aria-label={`View the first page of ${record.document.originalFilename}`}>
    {failed ? <span className="library-cover-fallback"><b>PDF</b><span>Preview unavailable</span></span> : <img src={previewUrl(record.document.id, 1)} alt="" onError={() => setFailed(true)} />}
    <span className="library-page-label">Original PDF <span aria-hidden="true">↗</span></span>
  </a>
}

export function FeaturedPaperContent({ record, controls, content, error }: { readonly record: DocumentRecord; readonly controls: Controls; readonly content: ReturnType<typeof paperPreview> | null; readonly error: string | null }) {
  const guide = content?.guide
  const id = record.document.id
  const readPath = guideLocation(id, { mode: "read" })
  const mainPath = guide ? guideLocation(id, { mode: "choices", goal: "walk" }) : readPath
  return <article className="library-feature" aria-labelledby="featured-paper-title">
    <PaperCover record={record} />
    <div className="library-feature-body"><p className="library-eyebrow">{guide ? "Reading guide" : "On your shelf"}</p><h2 id="featured-paper-title">{content?.title ?? fileTitle(record)}</h2>
      <p className="library-byline">{pageCount(record)}{guide && <> <span aria-hidden="true">/</span> {guide.steps} {guide.steps === 1 ? "step" : "steps"} <span aria-hidden="true">/</span> {guide.claims} {guide.claims === 1 ? "claim" : "claims"}</>}</p>
      {guide && <p className="library-excerpt">{guide.excerpt}</p>}
      {!guide && content !== null && <p className="library-excerpt">Read the clean copy alongside the original PDF. This paper has no saved guide.</p>}
      {content === null && error === null && <p className="library-note" role="status">Loading reading details…</p>}
      {error !== null && <p className="library-note" role="status">Reading details are unavailable. {error}</p>}
      <div className="library-feature-actions"><a className="button primary" href={mainPath} onClick={(event) => openLibraryLink(event, mainPath)}>{guide ? "Open reading guide" : "Open paper"} <span aria-hidden="true">→</span></a>{guide && <a className="library-secondary-link" href={readPath} onClick={(event) => openLibraryLink(event, readPath)}>Read full paper</a>}</div>
      <RunNotice record={record} controls={controls} />
      <PaperDetails record={record} controls={controls} />
    </div>
  </article>
}

function FeaturedPaper({ record, revisionId, controls }: { readonly record: DocumentRecord; readonly revisionId: OutputRevisionId; readonly controls: Controls }) {
  const [content, setContent] = useState<ReturnType<typeof paperPreview> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { onUnauthenticated } = controls
  useEffect(() => runDocument(readPublishedDocument({ documentId: record.document.id, revisionId }), (output) => setContent(paperPreview(output.canonical)), (failure) => {
    if (failure.kind === "unauthenticated") onUnauthenticated()
    else setError(failure.message)
  }), [record.document.id, revisionId, onUnauthenticated])
  return <FeaturedPaperContent record={record} controls={controls} content={content} error={error} />
}

function PaperRow({ record, controls }: { readonly record: DocumentRecord; readonly controls: Controls }) {
  const saved = record.currentRevisionId !== null
  const path = `/documents/${record.document.id}`
  return <article className="library-paper-row"><div className="library-row-main"><p className="library-eyebrow">{pageCount(record)} · PDF</p><h3><a href={path} onClick={(event) => openLibraryLink(event, path)}>{fileTitle(record)}</a></h3><RunNotice record={record} controls={controls} /></div><a className="library-secondary-link" href={path} onClick={(event) => openLibraryLink(event, path)}>{saved ? "Open paper" : activeRun(record.latestRun) ? "View progress" : "View document"} <span aria-hidden="true">→</span></a><PaperDetails record={record} controls={controls} /></article>
}

export function PaperLibrary({ records, controls }: { readonly records: ReadonlyArray<DocumentRecord>; readonly controls: Controls }) {
  const featured = featuredPaper(records)
  const otherPapers = records.filter((record) => record.document.id !== featured?.document.id)
  if (records.length === 0) return <p className="library-empty">No papers yet. Your uploaded PDFs will appear here.</p>
  return <>{featured !== undefined && featured.currentRevisionId !== null && <FeaturedPaper key={`${featured.document.id}-${featured.currentRevisionId}`} record={featured} revisionId={featured.currentRevisionId} controls={controls} />}
    {otherPapers.length > 0 && <section className="library-remaining" aria-labelledby="library-remaining-title"><h2 id="library-remaining-title">{featured ? "More papers" : "Your papers"}</h2>{otherPapers.map((record) => <PaperRow key={record.document.id} record={record} controls={controls} />)}</section>}
  </>
}
