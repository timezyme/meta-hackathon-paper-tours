import type { DocumentReadFailure } from "./client/documents.ts"
import { navigate } from "./client/browser.ts"

export function DocumentReadError({ error, onRetry }: { readonly error: DocumentReadFailure; readonly onRetry: () => void }) {
  return <section className="message error" role="alert">{error.status === 410 ? <><h2>This document has expired.</h2><p>Upload the PDF again from your documents to create a new copy.</p><a className="button" href="/" onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigate("/")
  }}>Return to documents</a></> : <><p>{error.message}</p><button className="button" type="button" onClick={onRetry}>Try again</button></>}</section>
}
