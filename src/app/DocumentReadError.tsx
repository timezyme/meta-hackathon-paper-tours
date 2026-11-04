import type { DocumentReadFailure } from "./client/http.ts"
import { InternalLink } from "./links.tsx"

export function DocumentReadError({ error, onRetry }: { readonly error: DocumentReadFailure; readonly onRetry: () => void }) {
  if (error.status === 410) return <section className="message error" role="alert">
    <h2>This document has expired.</h2><p>Upload the PDF again from your documents to create a new copy.</p>
    <InternalLink className="button" href="/">Return to documents</InternalLink>
  </section>
  return <section className="message error" role="alert">
    <p>{error.message}</p><button className="button" type="button" onClick={onRetry}>Try again</button>
  </section>
}
