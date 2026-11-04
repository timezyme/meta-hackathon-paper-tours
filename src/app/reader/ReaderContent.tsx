import type { RefObject } from "react"
import type { Block, CanonicalDocument } from "../../domain/index.ts"
import { navigate } from "../client/browser.ts"
import { outputUrl, type OutputIdentity } from "../client/outputs.ts"
import { guideLocation } from "../guide/navigation.ts"
import { GlyphText } from "../GlyphText.tsx"
import { blockPage, blocksOnPage, continuationsOnPage } from "./presentation.ts"
import { ReaderBlock } from "./ReaderBlock.tsx"
import { OriginalPreview } from "./OriginalPreview.tsx"
import type { CopyState } from "./useReaderActions.ts"

const shortCopyLabels = { idle: "Copy all text", pending: "Copying…", done: "Copied" } as const
const copyLabel = (labels: Record<CopyState, string>, state: CopyState) =>
  state === "done" ? <GlyphText after="✓">{labels.done}</GlyphText> : labels[state]

type EditionProps = {
  readonly documentId: string
  readonly canonical: CanonicalDocument
  readonly identity: OutputIdentity
  readonly paperTitle: string
  readonly titleInPage: boolean
  readonly page: number
  readonly copyState: CopyState
  readonly onCopy: () => void
}

export function EditionHead({ documentId, canonical, identity, paperTitle, titleInPage, page, copyState, onCopy }: EditionProps) {
  const go = (route: Parameters<typeof guideLocation>[1]) => navigate(guideLocation(documentId, route, page))
  const guided = canonical.guide !== undefined
  return <header className="reader-edition-head">
    <div className="reader-edition-title"><p className="guide-kicker">Full document</p>{!titleInPage && <h1>{paperTitle}</h1>}</div>
    <div className="reader-edition-tools"><nav className="guide-reader-links" aria-label="Reading options">
      <button type="button" className="reader-text-link" onClick={() => go({ mode: "choices", goal: "read" })}>Choose how to read</button>
      {guided && <button type="button" className="reader-text-link" onClick={() => go({ mode: "overview" })}>Overview</button>}
      {guided && <button type="button" className="reader-text-link" onClick={() => go({ mode: "map", goal: "map" })}>Document map</button>}</nav>
      <div className="live-reader-actions">
        <button className="button" type="button" onClick={onCopy} disabled={copyState === "pending"}>
          {copyLabel(shortCopyLabels, copyState)}</button>
        <a className="button" href={outputUrl(identity, "zip")} download>Download ZIP</a></div>
    </div>
  </header>
}

type PageReaderProps = {
  readonly canonical: CanonicalDocument
  readonly identity: OutputIdentity
  readonly view: "clean" | "original"
  readonly page: number
  readonly readingPage: RefObject<HTMLElement | null>
  readonly onPage: (number: number) => void
  readonly onView: (view: "clean" | "original") => void
  readonly onPages: () => void
}

function PageText({ canonical, identity, page, onPage, onOriginal }: Pick<PageReaderProps, "canonical" | "identity" | "page" | "onPage"> & {
  readonly onOriginal: () => void
}) {
  const blocks = blocksOnPage(canonical, page)
  const continuations = continuationsOnPage(canonical, page)
  const continuation = (block: Block) => <p className="reader-continuation" key={block.id}>Text from this page continues a paragraph on
    {" "}<button type="button" onClick={() => onPage(blockPage(block))}>
      <GlyphText after="→">page {blockPage(block)}</GlyphText></button></p>
  return <>
    {continuations.map(continuation)}
    {blocks.map((block) => <ReaderBlock key={block.id} block={block} canonical={canonical} identity={identity} />)}
    {blocks.length === 0 && continuations.length === 0 && <p className="reader-small">No text or figures were extracted from this page.
      {" "}<button type="button" className="reader-text-link" onClick={onOriginal}>View the original page.</button></p>}
  </>
}

export function PageReader({ canonical, identity, view, page, readingPage, onPage, onView, onPages }: PageReaderProps) {
  const nextPage = canonical.pages.find((item) => item.pageNumber > page)
  const label = `${view === "clean" ? "Normalized document" : "Original PDF"} page ${page}`
  return <section className="reading-surface" aria-label="Document reader">
    <div className="reading-bar"><div className="reader-view-switch" role="group" aria-label="Reading view">
      <button type="button" aria-pressed={view === "clean"} onClick={() => onView("clean")}>Clean copy</button>
      <button type="button" aria-pressed={view === "original"} onClick={() => onView("original")}>Original</button></div>
      <span>Page {page} of {canonical.pages.length}</span><button className="reader-edge" type="button" onClick={onPages}>Pages</button></div>
    <article className={`paper-content${view === "original" ? " paper-original" : ""}`} ref={readingPage} tabIndex={-1} aria-label={label}>
      {view === "original" ? <OriginalPreview documentId={identity.documentId} page={page} />
        : <PageText canonical={canonical} identity={identity} page={page} onPage={onPage} onOriginal={() => onView("original")} />}
    </article>
    <footer className="reading-footer"><span>END OF PAGE {page}</span>{nextPage === undefined ? <span>End of document</span>
      : <button type="button" className="reader-text-link" onClick={() => onPage(nextPage.pageNumber)}>
        <GlyphText after="→">Continue to page {nextPage.pageNumber}</GlyphText></button>}</footer>
  </section>
}

