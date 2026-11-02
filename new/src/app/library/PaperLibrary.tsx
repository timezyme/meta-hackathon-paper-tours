import { useState } from "react"
import type { OutputRevisionId } from "../../domain/index.ts"
import { originalUrl, outputUrl, previewUrl } from "../client/outputs.ts"
import { activeRun, formatBytes, formatExpiry, runSummary, type DocumentRecord } from "../documents.ts"
import { guideLocation } from "../guide/navigation.ts"
import { ProcessingProgress } from "../guide/ProcessingProgress.tsx"
import { DeleteDocumentControl } from "../reader/DeleteDocument.tsx"
import { RetryDocumentControl } from "../reader/RetryDocument.tsx"
import { countLabel } from "../text.ts"
import { InternalLink } from "../links.tsx"
import { featuredPaper } from "./presentation.ts"
import { usePaperPreview, type PaperPreview } from "./usePaperPreview.ts"

type Controls = {
  readonly retryEnabled: boolean
  readonly readOnly?: boolean
  readonly onDeleted: () => void
  readonly onRefresh: () => void
  readonly onUnauthenticated: () => void
}

const fileTitle = (record: DocumentRecord) => record.document.originalFilename.replace(/\.pdf$/iu, "") || record.document.originalFilename
const pageCount = (record: DocumentRecord) => countLabel(record.document.pageCount, "page")
type Props = { readonly record: DocumentRecord; readonly controls: Controls }

function FileActions({ record }: { readonly record: DocumentRecord }) {
  const id = record.document.id
  const name = record.document.originalFilename
  return <div className="library-file-actions">
    {record.currentRevisionId !== null && <a className="reader-text-link" href={outputUrl({ documentId: id, revisionId: record.currentRevisionId }, "text")}
      download="normalized.txt" aria-label={`Download text for ${name}`}>Download text</a>}
    <a className="reader-text-link" href={originalUrl(id)} download aria-label={`Download original PDF ${name}`}>Download original PDF</a>
  </div>
}

function PaperDetails({ record, controls }: Props) {
  return <details className="library-details"><summary>Document details</summary><div className="library-detail-body">
    <dl><div><dt>Original file</dt><dd>{record.document.originalFilename}</dd></div>
      <div><dt>File size</dt><dd>{formatBytes(record.document.byteCount)}</dd></div>
      <div><dt>Available until</dt><dd>{formatExpiry(record.document.expiresAt)}</dd></div></dl>
    <FileActions record={record} />
    {controls.readOnly !== true && <DeleteDocumentControl record={record} onDeleted={controls.onDeleted} onUnauthenticated={controls.onUnauthenticated} />}
  </div></details>
}

function RunNotice({ record, controls }: Props) {
  const summary = runSummary(record.latestRun)
  if (summary.failed) return <div className="library-run-notice failed">
    <p><strong>{summary.title}.</strong> {summary.description}{record.currentRevisionId !== null && " Your saved copy is still available."}</p>
    {controls.retryEnabled && controls.readOnly !== true && <RetryDocumentControl record={record} onRefresh={controls.onRefresh} onUnauthenticated={controls.onUnauthenticated} />}
  </div>
  if (activeRun(record.latestRun)) return <ProcessingProgress record={record} compact />
  if (record.latestRun.state._tag === "succeeded-with-issues") {
    return <p className="library-run-notice failed">This document has reported issues. You can review them in the reader.</p>
  }
  return null
}

function PaperCover({ record }: { readonly record: DocumentRecord }) {
  const [failed, setFailed] = useState(false)
  const path = guideLocation(record.document.id, { mode: "read", view: "original" }, 1)
  const label = `View the first page of ${record.document.originalFilename}`
  return <InternalLink className="library-cover" href={path} aria-label={label}>
    {failed
      ? <span className="library-cover-fallback"><b>PDF</b><span>Preview unavailable</span></span>
      : <img src={previewUrl(record.document.id, 1)} alt="" onError={() => setFailed(true)} />}
    <span className="library-page-label">Original PDF <span aria-hidden="true">↗</span></span>
  </InternalLink>
}

function GuideByline({ guide }: { readonly guide: NonNullable<PaperPreview["guide"]> }) {
  return <> <span aria-hidden="true">/</span> {countLabel(guide.steps, "step")} <span aria-hidden="true">/</span> {countLabel(guide.claims, "claim")}</>
}

function FeatureActions({ mainPath, readPath, quotePath }: { readonly mainPath: string; readonly readPath: string; readonly quotePath: string | null }) {
  return <div className="library-feature-actions">
    <InternalLink className="button primary" href={mainPath}>
      {quotePath !== null ? "Open reading guide" : "Open document"} <span aria-hidden="true">→</span></InternalLink>
    {quotePath !== null && <InternalLink className="library-secondary-link" href={quotePath}>See a cited passage in the document</InternalLink>}
    {quotePath !== null && <InternalLink className="library-secondary-link" href={readPath}>Read full document</InternalLink>}
  </div>
}

type FeaturedProps = Props & { readonly content: PaperPreview | null; readonly error: string | null }

export function FeaturedPaperContent({ record, controls, content, error }: FeaturedProps) {
  const guide = content?.guide
  const id = record.document.id
  const readPath = guideLocation(id, { mode: "read" })
  const mainPath = guide ? guideLocation(id, { mode: "choices", goal: "walk" }) : readPath
  return <article className="library-feature" aria-labelledby="featured-paper-title">
    <PaperCover record={record} />
    <div className="library-feature-body"><p className="library-eyebrow">{guide ? "Reading guide" : "On your shelf"}</p>
      <h2 id="featured-paper-title">{content?.title ?? fileTitle(record)}</h2>
      <p className="library-byline">{pageCount(record)}{guide && <GuideByline guide={guide} />}</p>
      {guide && <p className="library-excerpt">{guide.excerpt}</p>}
      {!guide && content !== null && <p className="library-excerpt">
        Read the clean copy alongside the original PDF. This document has no saved guide.</p>}
      {content === null && error === null && <p className="library-note" role="status">Loading reading details…</p>}
      {error !== null && <p className="library-note" role="status">Reading details are unavailable. {error}</p>}
      <FeatureActions mainPath={mainPath} readPath={readPath}
        quotePath={guide ? guideLocation(id, { mode: "walk", goal: "walk", n: 1, source: 1 }) : null} />
      <RunNotice record={record} controls={controls} />
      <PaperDetails record={record} controls={controls} />
    </div>
  </article>
}

function FeaturedPaper({ record, revisionId, controls }: Props & { readonly revisionId: OutputRevisionId }) {
  const { content, error } = usePaperPreview(record.document.id, revisionId, controls.onUnauthenticated)
  return <FeaturedPaperContent record={record} controls={controls} content={content} error={error} />
}

const rowAction = (record: DocumentRecord): string => {
  if (record.currentRevisionId !== null) return "Open document"
  return activeRun(record.latestRun) ? "View progress" : "View document"
}

function PaperRow({ record, controls, content = null }: Props & { readonly content?: PaperPreview | null }) {
  const path = `/documents/${record.document.id}`
  return <article className="library-paper-row">
    <div className="library-row-main"><p className="library-eyebrow">{pageCount(record)}{content?.guide && <GuideByline guide={content.guide} />}</p>
      <h3><InternalLink href={path}>{content?.title ?? fileTitle(record)}</InternalLink></h3><RunNotice record={record} controls={controls} /></div>
    <InternalLink className="library-secondary-link" href={path} tabIndex={-1} aria-hidden="true">
      {rowAction(record)} <span aria-hidden="true">→</span></InternalLink>
    <PaperDetails record={record} controls={controls} />
  </article>
}

function PublishedPaperRow({ record, revisionId, controls }: Props & { readonly revisionId: OutputRevisionId }) {
  const { content } = usePaperPreview(record.document.id, revisionId, controls.onUnauthenticated)
  return <PaperRow record={record} controls={controls} content={content} />
}

function LibraryRow({ record, controls }: Props) {
  const revisionId = record.currentRevisionId
  if (revisionId === null) return <PaperRow record={record} controls={controls} />
  return <PublishedPaperRow key={revisionId} record={record} revisionId={revisionId} controls={controls} />
}

export function ExampleLibrary({ records, controls }: { readonly records: ReadonlyArray<DocumentRecord>; readonly controls: Controls }) {
  if (records.length === 0) return null
  const readOnly = { ...controls, readOnly: true }
  return <section className="library-remaining library-examples" aria-labelledby="library-examples-title">
    <h2 id="library-examples-title">Examples</h2>
    <p className="library-note">Documents already processed by AmuseMe. Everyone can read them; only their owner can change them.</p>
    {records.map((record) => <LibraryRow key={record.document.id} record={record} controls={readOnly} />)}
  </section>
}

export function PaperLibrary({ records, controls }: { readonly records: ReadonlyArray<DocumentRecord>; readonly controls: Controls }) {
  const featured = featuredPaper(records)
  const otherPapers = records.filter((record) => record.document.id !== featured?.document.id)
  if (records.length === 0) return <p className="library-empty">No documents yet. Your uploaded PDFs will appear here.</p>
  const revisionId = featured?.currentRevisionId ?? null
  return <>{featured !== undefined && revisionId !== null
    && <FeaturedPaper key={`${featured.document.id}-${revisionId}`} record={featured} revisionId={revisionId} controls={controls} />}
    {otherPapers.length > 0 && <section className="library-remaining" aria-labelledby="library-remaining-title">
      <h2 id="library-remaining-title">{featured ? "More documents" : "Your documents"}</h2>
      {otherPapers.map((record) => <LibraryRow key={record.document.id} record={record} controls={controls} />)}
    </section>}
  </>
}
