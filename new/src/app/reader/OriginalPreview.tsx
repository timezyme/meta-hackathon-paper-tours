import { useState } from "react"
import { originalUrl, previewUrl } from "../client/outputs.ts"

export function OriginalPreview({ documentId, page }: { readonly documentId: string; readonly page: number }) {
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const source = `${previewUrl(documentId, page)}&attempt=${attempt}`
  return <section className="original-preview" aria-label={`Original PDF page ${page}`}>
    {loaded !== source && failed !== source && <p className="preview-loading" role="status">Loading original page {page}…</p>}
    {failed === source ? <div className="preview-error" role="alert"><p>The original page preview could not be loaded.</p><button type="button" className="button" onClick={() => setAttempt((value) => value + 1)}>Try preview again</button></div> : <img key={source} src={source} alt={`Page ${page} of the original PDF, as uploaded`} onLoad={() => setLoaded(source)} onError={() => setFailed(source)} />}
    <p className="reader-small">Original page, rendered without AI changes. <a href={originalUrl(documentId)} download>Download original PDF</a>.</p>
  </section>
}
