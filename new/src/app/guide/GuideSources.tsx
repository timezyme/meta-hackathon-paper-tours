import { useFocusOnChange } from "../useFocusOnChange.ts"
import { useRef, type RefObject } from "react"
import type { CanonicalDocument, SourceQuote } from "../../domain/index.ts"
import { focusSourceQuote } from "../client/browser.ts"
import { OriginalPreview } from "../reader/OriginalPreview.tsx"
import { displayQuote, evidencePage, highlightedSource, readableSource, sourceForQuote, sourcePages } from "./presentation.ts"
import { MathText, QuoteText } from "./QuoteText.tsx"
import { GlyphText } from "../GlyphText.tsx"

const sourceText = (pages: ReadonlyArray<number>): string =>
  pages.length === 0 ? "Source" : `Source · ${pages.length === 1 ? "page" : "pages"} ${pages.join(", ")}`
const snippet = (quote: string): string => {
  const text = displayQuote(quote).replace(/\s+/gu, " ").trim()
  return text.length > 60 ? `${text.slice(0, 60).trimEnd()}…` : text
}

function SourceIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h9l5 5v13H5ZM14 3v6h5M9 13h6M9 17h6" /></svg>
}

export function SourceLinks({ canonical, sources, onSource }: {
  readonly canonical: CanonicalDocument
  readonly sources: ReadonlyArray<SourceQuote>
  readonly onSource: (source: SourceQuote) => void
}) {
  return <div className="guide-source-links" role="group" aria-label="Source evidence">{sources.map((source, index) => {
    const block = sourceForQuote(canonical, source)
    const pages = block === undefined ? [] : sourcePages(block)
    const label = sourceText(pages)
    return <button type="button" key={`${source.sourceBlockId}-${index}`} aria-label={`${label}: “${snippet(source.quote)}”`} onClick={() => onSource(source)}>
      <SourceIcon />{label}
    </button>
  })}</div>
}

export function QuotedSourceText({ content, quote }: { readonly content: string; readonly quote?: string }) {
  const parts = quote === undefined ? null : highlightedSource(content, quote)
  if (parts === null) return <p className="guide-source-text"><MathText text={readableSource(content)} /></p>
  return <p className="guide-source-text"><MathText text={parts.before} /><mark><MathText text={parts.quote} /></mark><MathText text={parts.after} /></p>
}

function EvidenceControls({ pages, page, original, onPage, onView }: {
  readonly pages: ReadonlyArray<number>
  readonly page: number
  readonly original: boolean
  readonly onPage: (page: number) => void
  readonly onView: (original: boolean) => void
}) {
  return <div className="guide-evidence-controls">
    <div className="reader-view-switch" role="group" aria-label="Evidence view">
      <button type="button" aria-pressed={!original} onClick={() => onView(false)}>Highlighted text</button>
      <button type="button" aria-pressed={original} onClick={() => onView(true)}>Original page</button>
    </div>
    {pages.length > 1 && <nav className="guide-source-pages" aria-label="Pages containing this source">{pages.map((number) =>
      <button type="button" key={number} aria-current={number === page ? "page" : undefined} onClick={() => onPage(number)}>Page {number}</button>)}
    </nav>}
  </div>
}

function SourceTextPage({ canonical, source, page, selected }: {
  readonly canonical: CanonicalDocument
  readonly source: SourceQuote
  readonly page: number
  readonly selected: RefObject<HTMLElement | null>
}) {
  const blocks = canonical.sourceBlocks
    .filter((item) => item.locations.some((location) => location.pageNumber === page))
    .toSorted((a, b) => a.readingOrder - b.readingOrder)
  return <div className="guide-evidence-page"><p className="guide-kicker">Source text · page {page}</p>{blocks.map((item) => {
    const cited = item.id === source.sourceBlockId
    return <section key={item.id} className={`guide-source-block${cited ? " cited" : ""}`} ref={cited ? selected : undefined}
      tabIndex={cited ? -1 : undefined} aria-label={cited ? `Cited source on page ${page}` : undefined}>
      <QuotedSourceText content={item.content} {...(cited ? { quote: source.quote } : {})} />
    </section>
  })}</div>
}

export function GuideEvidence({ canonical, source, requestedPage, original, onPage, onView }: {
  readonly canonical: CanonicalDocument
  readonly source: SourceQuote
  readonly requestedPage: number
  readonly original: boolean
  readonly onPage: (page: number) => void
  readonly onView: (original: boolean) => void
}) {
  const selected = useRef<HTMLElement>(null)
  const page = evidencePage(canonical, source, requestedPage)
  const block = sourceForQuote(canonical, source)
  const pages = block === undefined ? [] : sourcePages(block)
  useFocusOnChange(original, () => {
    if (!original && selected.current !== null) focusSourceQuote(selected.current)
  }, { onMount: true })
  return <section className="guide-evidence" aria-label="Evidence from the uploaded document">
    <EvidenceControls pages={pages} page={page} original={original} onPage={onPage} onView={onView} />
    <figure className="guide-exact-quote"><figcaption className="guide-kicker">Exact quote · page {page}</figcaption>
      <blockquote>“<QuoteText quote={source.quote} />”</blockquote></figure>
    {original ? <>
      <p className="guide-note">This is page {page} exactly as uploaded, with no AI changes. Look for the quoted words above.</p>
      <OriginalPreview documentId={canonical.scope.documentId} page={page} />
    </> : <>
      <p className="guide-note">Highlighted below in the page’s saved text. <button type="button" className="reader-text-link"
        onClick={() => onView(true)}><GlyphText after="→">Compare with the original page</GlyphText></button></p>
      <SourceTextPage canonical={canonical} source={source} page={page} selected={selected} />
    </>}
  </section>
}
