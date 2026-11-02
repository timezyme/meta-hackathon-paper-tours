import type { ReactNode } from "react"
import type { CanonicalDocument, ReadingGuide, SourceQuote } from "../../domain/index.ts"
import { SourceLinks } from "./GuideSources.tsx"
import { countLabel } from "../text.ts"
import { QuoteText } from "./QuoteText.tsx"
import { citedBlockCount } from "../map/graph.ts"

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

const nextLabel = (mode: "walk" | "claims", last: boolean): string => {
  if (last) return "Finish"
  return mode === "walk" ? "Next step" : "Next claim"
}

export function GuidePath({ canonical, guide, mode, number, onSource, onTurn }: {
  readonly canonical: CanonicalDocument
  readonly guide: ReadingGuide
  readonly mode: "walk" | "claims"
  readonly number: number
  readonly onSource: OnSource
  readonly onTurn: (delta: number) => void
}) {
  const step = guide.steps[number - 1]
  const item = guide.claims[number - 1]
  const total = mode === "walk" ? guide.steps.length : guide.claims.length
  const label = mode === "walk" ? "Step" : "Claim"
  const sources = (values: ReadonlyArray<SourceQuote>) => <SourceLinks canonical={canonical} sources={values} onSource={onSource} />
  const passage = mode === "walk" ? step?.explanation : item?.claim
  return <div className="guide-path"><article className="guide-leaf" aria-labelledby="guide-screen-title">
    <header className="guide-leaf-head"><p className="guide-kicker">{mode === "walk" ? "Walk-through" : "Claims and limits"}</p>
      <div className="guide-progress"><span>{label} {number} of {total}</span><GuideRail total={total} at={number} /></div>
    </header>
    <div className="guide-spread"><div className="guide-leaf-body">
      <h1 id="guide-screen-title" className={mode === "claims" ? "guide-claim-title" : undefined} tabIndex={-1}>
        {mode === "walk" ? step?.title : item?.claim.text}
      </h1>
      {mode === "walk" && step !== undefined && <p className="guide-prose">{step.explanation.text}</p>}
    </div>
    {passage !== undefined && <PaperExcerpt key={`${mode}-${number}`} canonical={canonical} sources={passage.sources} onSource={onSource} />}
    {mode === "claims" && item !== undefined && <ClaimDetail item={item} sources={sources} />}
    </div>
  </article><nav className="guide-turn" aria-label={mode === "walk" ? "Walk-through steps" : "Claims"}>
    <button type="button" className="reader-text-link" onClick={() => onTurn(-1)}>← {number === 1 ? "Your goal" : "Back"}</button>
    <p className="guide-turn-hint">Use <kbd>←</kbd> and <kbd>→</kbd> to turn the page.</p>
    <button type="button" className="button primary" onClick={() => onTurn(1)}>{nextLabel(mode, number === total)} →</button>
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
      <button className="button primary" type="button" onClick={onWalk}>Walk me through it →</button>
    </div>
      <PaperExcerpt canonical={canonical} sources={guide.overview.sources} onSource={onSource} />
    </div>
  </article>
}

type CompleteProps = {
  readonly guide: ReadingGuide
  readonly downloads: { readonly zip: string; readonly text: string }
  readonly claims: boolean
  readonly onOther: () => void
  readonly onMap: () => void
  readonly onChoices: () => void
  readonly onRead: () => void
}

function CompletedHero({ claims, total, passages }: { readonly claims: boolean; readonly total: number; readonly passages: number }) {
  return <div className="guide-done-hero"><span className="guide-done-check" aria-hidden="true">✓</span>
    <p className="guide-kicker">You reached the end</p>
    <h1 id="guide-screen-title" tabIndex={-1}>{claims ? "You went through every claim." : "You finished the walk-through."}</h1>
    <p>{claims ? `All ${total} claims, their supporting evidence, and their limits.` : `All ${total} steps, from the question to the conclusion.`}
      {" "}The guide rests on {countLabel(passages, "quoted passage")} you can open in the document.</p>
    <GuideRail total={total} at={total + 1} />
  </div>
}

function AnotherWayIn({ guide, claims, onOther, onMap, onRead }: Omit<CompleteProps, "onChoices" | "downloads">) {
  return <section className="guide-done-card guide-another"><p className="guide-kicker">Another way in</p>
    <h2>{claims ? "Walk me through it" : "Claims and limits"}</h2>
    <p>{claims ? `${guide.steps.length} short steps through the document.` : `${guide.claims.length} claims, with their support and limits.`}</p>
    <button type="button" className="button primary" onClick={onOther}>{claims ? "Start the walk-through" : "Start claims and limits"} →</button>
    <button type="button" className="reader-text-link" onClick={onMap}>See the document map →</button>
    <button type="button" className="reader-text-link" onClick={onRead}>Read the full document →</button>
  </section>
}

function KeepIt({ downloads }: Pick<CompleteProps, "downloads">) {
  return <section className="guide-done-card guide-keep"><p className="guide-kicker">Keep it</p>
    <h2>Take the clean document with you</h2>
    <p>The ZIP holds the clean text, its images and document.json with this guide and every citation. The text file is ready for notes or an agent.</p>
    <div className="guide-keep-actions"><a className="button" href={downloads.zip} download>↓ Download ZIP</a>
      <a className="reader-text-link" href={downloads.text} download>Download text only</a></div>
  </section>
}

export function GuideComplete({ onChoices, downloads, ...props }: CompleteProps) {
  const { guide, claims } = props
  const total = claims ? guide.claims.length : guide.steps.length
  const covered = claims ? guide.claims.map((item) => item.claim.text) : guide.steps.map((step) => step.title)
  return <section className="guide-complete" aria-labelledby="guide-screen-title">
    <CompletedHero claims={claims} total={total} passages={citedBlockCount(guide)} />
    <div className="guide-done-grid">
      <div className="guide-done-side"><section className="guide-done-card"><h2>What you covered</h2><ol>{covered.map((title, index) => <li key={index}>{title}</li>)}</ol>
        <p className="guide-note">The guide is AI-written. Check the source for anything you rely on.</p>
      </section><KeepIt downloads={downloads} /></div>
      <AnotherWayIn {...props} />
    </div>
    <button type="button" className="reader-text-link" onClick={onChoices}>← Choose how to read</button>
  </section>
}
