import type { DocumentRecord } from "../documents.ts"
import { formatBytes, runSummary } from "../documents.ts"
import { OriginalPreview } from "../reader/OriginalPreview.tsx"

export function PaperStatus({ record, onOriginal }: { readonly record: DocumentRecord; readonly onOriginal?: () => void }) {
  const unpublished = record.currentRevisionId === null
  const summary = runSummary(record.latestRun)
  return <aside className="guide-paper-status" aria-label={unpublished ? "Your paper and processing status" : "Original paper preview"}>
    {unpublished && <div className="guide-file"><h2>{record.document.originalFilename}</h2>
      <div className={`guide-live-status${summary.failed ? " failed" : ""}`} role="status"><strong>{summary.title}</strong><p>{summary.description}</p></div>
    </div>}
    <figure className="guide-cover">
      <div className="guide-paper-preview"><OriginalPreview documentId={record.document.id} page={1} /></div>
      <figcaption><span>Original PDF</span><span>Page 1 of {record.document.pageCount}</span></figcaption>
    </figure>
    {onOriginal && <div className="guide-cover-link"><button className="reader-text-link" type="button" aria-label="Open original page 1" onClick={onOriginal}>Open page 1 <span aria-hidden="true">↗</span></button><span>{formatBytes(record.document.byteCount)}</span></div>}
    {record.latestRun.configuration.extractionProvider === "fixture" && <p className="fixture-note">Test fixture · Document processing is not connected.</p>}
  </aside>
}
