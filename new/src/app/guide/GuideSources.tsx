import { useEffect, useRef } from "react"
import type { CanonicalDocument, SourceQuote } from "../../domain/index.ts"
import { focusSourceQuote } from "../client/browser.ts"
import { OriginalPreview } from "../reader/OriginalPreview.tsx"
import { evidencePage, quotedParts, sourceForQuote, sourcePages } from "./presentation.ts"

export function SourceLinks({ canonical, sources, onSource }: { readonly canonical: CanonicalDocument; readonly sources: ReadonlyArray<SourceQuote>; readonly onSource: (source: SourceQuote) => void }) {
  return <div className="guide-source-links" aria-label="Source evidence">{sources.map((source, index) => {
    const block = sourceForQuote(canonical, source)
    const pages = block === undefined ? [] : sourcePages(block)
    return <button type="button" key={`${source.sourceBlockId}-${index}`} onClick={() => onSource(source)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h9l5 5v13H5ZM14 3v6h5M9 13h6M9 17h6" /></svg>Source · {pages.length === 1 ? "page" : "pages"} {pages.join(", ")}<span aria-hidden="true">↗</span></button>
  })}</div>
}

export function QuotedSourceText({ content, quote }: { readonly content: string; readonly quote?: string }) {
  const parts = quote === undefined ? null : quotedParts(content, quote)
  return <p className="guide-source-text">{parts === null ? content : <>{parts.before}<mark>{parts.quote}</mark>{parts.after}</>}</p>
}

export function GuideEvidence({ canonical, source, requestedPage, original, onPage, onView }: { readonly canonical: CanonicalDocument; readonly source: SourceQuote; readonly requestedPage: number; readonly original: boolean; readonly onPage: (page: number) => void; readonly onView: (original: boolean) => void }) {
  const selected = useRef<HTMLElement>(null)
  const page = evidencePage(canonical, source, requestedPage)
  const block = sourceForQuote(canonical, source)
  const pages = block === undefined ? [] : sourcePages(block)
  useEffect(() => { if (!original && selected.current !== null) focusSourceQuote(selected.current) }, [original])
  return <section className="guide-evidence" aria-label="Evidence from the uploaded paper">
    <p className="guide-note">The highlighted words come from the saved source text. Check the original PDF for extraction errors.</p>
    <div className="guide-evidence-controls"><div className="reader-view-switch" role="group" aria-label="Evidence view"><button type="button" aria-pressed={!original} onClick={() => onView(false)}>Source text</button><button type="button" aria-pressed={original} onClick={() => onView(true)}>Original</button></div><nav className="guide-source-pages" aria-label="Pages containing this source">{pages.map((number) => <button type="button" key={number} aria-current={number === page ? "page" : undefined} onClick={() => onPage(number)}>Page {number}</button>)}</nav></div>
    {original ? <><blockquote className="guide-exact-quote">“{source.quote}”</blockquote><OriginalPreview documentId={canonical.scope.documentId} page={page} /></> : <div className="guide-evidence-page"><p className="guide-kicker">Source text · page {page}</p>{canonical.sourceBlocks.filter((item) => item.locations.some((location) => location.pageNumber === page)).toSorted((a, b) => a.readingOrder - b.readingOrder).map((item) => <section key={item.id} className={`guide-source-block${item.id === source.sourceBlockId ? " cited" : ""}`} ref={item.id === source.sourceBlockId ? selected : undefined} tabIndex={item.id === source.sourceBlockId ? -1 : undefined} aria-label={item.id === source.sourceBlockId ? `Cited source on page ${page}` : undefined}><QuotedSourceText content={item.content} {...(item.id === source.sourceBlockId ? { quote: source.quote } : {})} /></section>)}</div>}
  </section>
}
