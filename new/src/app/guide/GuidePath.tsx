import type { ReactNode } from "react"
import type { CanonicalDocument, ReadingGuide, SourceQuote } from "../../domain/index.ts"
import { SourceLinks } from "./GuideSources.tsx"
import { countLabel } from "../text.ts"
import { QuoteText } from "./QuoteText.tsx"
import { citedBlockCount } from "../map/graph.ts"
import { GlyphText } from "../GlyphText.tsx"

type OnSource = (source: SourceQuote) => void
const strengthLabel = { strong: "Strong support", partial: "Partial support", limited: "Limited support" } as const

function PaperExcerpt({ canonical, sources, onSource }: {
  readonly canonical: CanonicalDocument
  readonly sources: readonly [SourceQuote, ...SourceQuote[]]
  readonly onSource: OnSource
}) {
  const quote = (source: SourceQuote, index: number) => <div className="guide-quotation" key={index}>
    <blockquote>“<QuoteText quote={source.quote} />”</blockquote>
    <SourceLinks canonical={canonical} sources={[source]} onSource={onSource} />
  </div>
  return <aside className="guide-words" aria-label="Source excerpts">
    <h2>From the document</h2>{quote(sources[0], 0)}
    {sources.length > 1 && <details className="guide-more-words">
      <summary>{countLabel(sources.length - 1, "more excerpt", "more excerpts")}</summary>{sources.slice(1).map(quote)}
    </details>}
  </aside>
}

const railClass = (position: number, at: number): string => {
  if (position < at) return "done"
  return position === at ? "current" : ""
}

export function GuideRail({ total, at }: { readonly total: number; readonly at: number }) {
  return <div className="guide-rail" aria-hidden="true">
    {Array.from({ length: total }, (_, index) => <span key={index} className={railClass(index + 1, at)} />)}
  </div>
}

function ClaimDetail({ item, sources }: {
  readonly item: ReadingGuide["claims"][number]
  readonly sources: (values: ReadonlyArray<SourceQuote>) => ReactNode
}) {
  return <div className="guide-claim-detail">
    <section className="guide-claim-section" aria-labelledby="guide-support-title">
      <div className="guide-section-heading">
        <h2 id="guide-support-title">Supporting evidence</h2><span className="guide-strength">{strengthLabel[item.support.strength]}</span>
      </div>
      <p className="guide-prose">{item.support.text}</p>{sources(item.support.sources)}
    </section>
    <section className="guide-claim-section" aria-labelledby="guide-limits-title"><h2 id="guide-limits-title">Where it stops</h2>
      <ol className="guide-limits">
        {item.limits.map((limit, index) => <li key={index}><p className="guide-prose">{limit.text}</p>{sources(limit.sources)}</li>)}
      </ol>
    </section>
  </div>
}

type PathMode = "walk" | "claims"
type PathItem = {
  readonly title: string | undefined
  readonly passage: ReadingGuide["steps"][number]["explanation"] | undefined
  readonly explanation: string | undefined
  readonly claim: ReadingGuide["claims"][number] | undefined
}
type PathModel = {
  readonly kicker: string
  readonly unit: string
  readonly next: string
  readonly nav: string
  readonly titleClass: string | undefined
  readonly item: (guide: ReadingGuide, index: number) => PathItem
  readonly covered: (guide: ReadingGuide) => ReadonlyArray<string>
  readonly doneTitle: string
  readonly doneSummary: (total: number) => string
  readonly otherTitle: string
  readonly otherSummary: (guide: ReadingGuide) => string
  readonly otherAction: string
}

const guidePaths: Record<PathMode, PathModel> = {
  walk: {
    kicker: "Walk-through", unit: "Step", next: "Next step", nav: "Walk-through steps", titleClass: undefined,
    item: (guide, index) => {
      const step = guide.steps[index]
      return { title: step?.title, passage: step?.explanation, explanation: step?.explanation.text, claim: undefined }
    },
    covered: (guide) => guide.steps.map((step) => step.title),
    doneTitle: "You finished the walk-through.",
    doneSummary: (total) => `All ${total} steps, from the question to the conclusion.`,
    otherTitle: "Claims and limits",
    otherSummary: (guide) => `${guide.claims.length} claims, with their support and limits.`,
    otherAction: "Start claims and limits",
  },
  claims: {
    kicker: "Claims and limits", unit: "Claim", next: "Next claim", nav: "Claims", titleClass: "guide-claim-title",
    item: (guide, index) => {
      const claim = guide.claims[index]
      return { title: claim?.claim.text, passage: claim?.claim, explanation: undefined, claim }
    },
    covered: (guide) => guide.claims.map((item) => item.claim.text),
    doneTitle: "You went through every claim.",
    doneSummary: (total) => `All ${total} claims, their supporting evidence, and their limits.`,
    otherTitle: "Walk me through it",
    otherSummary: (guide) => `${guide.steps.length} short steps through the document.`,
    otherAction: "Start the walk-through",
  },
}

export function GuidePath({ canonical, guide, mode, number, onSource, onTurn }: {
  readonly canonical: CanonicalDocument
  readonly guide: ReadingGuide
  readonly mode: "walk" | "claims"
  readonly number: number
  readonly onSource: OnSource
  readonly onTurn: (delta: number) => void
}) {
  const path = guidePaths[mode]
  const item = path.item(guide, number - 1)
  const total = path.covered(guide).length
  const label = path.unit
  const sources = (values: ReadonlyArray<SourceQuote>) => <SourceLinks canonical={canonical} sources={values} onSource={onSource} />
  const passage = item.passage
  return <div className="guide-path"><article className="guide-leaf" aria-labelledby="guide-screen-title">
    <header className="guide-leaf-head"><p className="guide-kicker">{path.kicker}</p>
      <div className="guide-progress"><span>{label} {number} of {total}</span><GuideRail total={total} at={number} /></div>
    </header>
    <div className="guide-spread"><div className="guide-leaf-body">
      <h1 id="guide-screen-title" className={path.titleClass} tabIndex={-1}>
        {item.title}
      </h1>
      {item.explanation !== undefined && <p className="guide-prose">{item.explanation}</p>}
    </div>
    {passage !== undefined && <PaperExcerpt key={`${mode}-${number}`} canonical={canonical} sources={passage.sources} onSource={onSource} />}
    {item.claim !== undefined && <ClaimDetail item={item.claim} sources={sources} />}
    </div>
  </article><nav className="guide-turn" aria-label={path.nav}>
    <button type="button" className="reader-text-link" onClick={() => onTurn(-1)}>
      <GlyphText before="←">{number === 1 ? "Your goal" : "Back"}</GlyphText></button>
    <p className="guide-turn-hint">Use <kbd>←</kbd> and <kbd>→</kbd> to turn the page.</p>
    <button type="button" className="button primary" onClick={() => onTurn(1)}>
      <GlyphText after="→">{number === total ? "Finish" : path.next}</GlyphText></button>
  </nav></div>
}

export function GuideOverview({ canonical, guide, onSource, onWalk }: {
  readonly canonical: CanonicalDocument
  readonly guide: ReadingGuide
  readonly onSource: OnSource
  readonly onWalk: () => void
}) {
  return <article className="guide-leaf guide-overview" aria-labelledby="guide-screen-title">
    <p className="guide-kicker">A short overview</p>
    <div className="guide-spread"><div className="guide-leaf-body">
      <h1 id="guide-screen-title" tabIndex={-1}>{guide.title}</h1><p className="guide-prose">{guide.overview.text}</p>
      <button className="button primary" type="button" onClick={onWalk}>
        <GlyphText after="→">Walk me through it</GlyphText></button>
    </div>
      <PaperExcerpt canonical={canonical} sources={guide.overview.sources} onSource={onSource} />
    </div>
  </article>
}

type CompleteProps = {
  readonly guide: ReadingGuide
  readonly downloads: { readonly zip: string; readonly text: string; readonly textName: string }
  readonly claims: boolean
  readonly onOther: () => void
  readonly onMap: () => void
  readonly onChoices: () => void
  readonly onRead: () => void
}

function CompletedHero({ path, total, passages }: { readonly path: PathModel; readonly total: number; readonly passages: number }) {
  return <div className="guide-done-hero"><span className="guide-done-check" aria-hidden="true">✓</span>
    <p className="guide-kicker">You reached the end</p>
    <h1 id="guide-screen-title" tabIndex={-1}>{path.doneTitle}</h1>
    <p>{path.doneSummary(total)}
      {" "}The guide rests on {countLabel(passages, "quoted passage")} you can open in the document.</p>
    <GuideRail total={total} at={total + 1} />
  </div>
}

function AnotherWayIn({ guide, path, onOther, onMap, onRead }: Omit<CompleteProps, "onChoices" | "downloads" | "claims"> & { readonly path: PathModel }) {
  return <section className="guide-done-card guide-another"><p className="guide-kicker">Another way in</p>
    <h2>{path.otherTitle}</h2>
    <p>{path.otherSummary(guide)}</p>
    <button type="button" className="button primary" onClick={onOther}>
      <GlyphText after="→">{path.otherAction}</GlyphText></button>
    <button type="button" className="reader-text-link" onClick={onMap}>
      <GlyphText after="→">See the document map</GlyphText></button>
    <button type="button" className="reader-text-link" onClick={onRead}>
      <GlyphText after="→">Read the full document</GlyphText></button>
  </section>
}

function KeepIt({ downloads }: Pick<CompleteProps, "downloads">) {
  return <section className="guide-done-card guide-keep"><p className="guide-kicker">Keep it</p>
    <h2>Take the clean document with you</h2>
    <p>The ZIP holds the clean text, its images and document.json with this guide and every citation. The text file is ready for notes or an agent.</p>
    <div className="guide-keep-actions">
      <a className="button" href={downloads.zip} download><GlyphText before="↓">Download ZIP</GlyphText></a>
      <a className="reader-text-link" href={downloads.text} download={downloads.textName}>Download text only</a></div>
  </section>
}

export function GuideComplete({ onChoices, downloads, ...props }: CompleteProps) {
  const { guide, claims } = props
  const path = guidePaths[claims ? "claims" : "walk"]
  const covered = path.covered(guide)
  const total = covered.length
  return <section className="guide-complete" aria-labelledby="guide-screen-title">
    <CompletedHero path={path} total={total} passages={citedBlockCount(guide)} />
    <div className="guide-done-grid">
      <div className="guide-done-side"><section className="guide-done-card"><h2>What you covered</h2><ol>{covered.map((title, index) => <li key={index}>{title}</li>)}</ol>
        <p className="guide-note">The guide is AI-written. Check the source for anything you rely on.</p>
      </section><KeepIt downloads={downloads} /></div>
      <AnotherWayIn {...props} path={path} />
    </div>
    <button type="button" className="reader-text-link" onClick={onChoices}>
      <GlyphText before="←">Choose how to read</GlyphText></button>
  </section>
}
