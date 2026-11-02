import type { CanonicalDocument, ReadingGuide, SourceQuote } from "../../domain/index.ts"
import { SourceLinks } from "./GuideSources.tsx"

function PaperExcerpt({ canonical, sources, onSource }: { readonly canonical: CanonicalDocument; readonly sources: readonly [SourceQuote, ...SourceQuote[]]; readonly onSource: (source: SourceQuote) => void }) {
  const quote = (source: SourceQuote, index: number) => <div className="guide-quotation" key={index}>
    <blockquote>“{source.quote}”</blockquote>
    <SourceLinks canonical={canonical} sources={[source]} onSource={onSource} />
  </div>
  return <aside className="guide-words" aria-label="Source excerpts">
    <h2>From the paper</h2>{quote(sources[0], 0)}
    {sources.length > 1 && <details className="guide-more-words"><summary>{sources.length - 1} more {sources.length === 2 ? "excerpt" : "excerpts"}</summary>{sources.slice(1).map(quote)}</details>}
  </aside>
}

export function GuideRail({ total, at }: { readonly total: number; readonly at: number }) {
  return <div className="guide-rail" aria-hidden="true">{Array.from({ length: total }, (_, index) => <span key={index} className={index + 1 < at ? "done" : index + 1 === at ? "current" : ""} />)}</div>
}

export function GuidePath({ canonical, guide, mode, number, onSource, onTurn }: { readonly canonical: CanonicalDocument; readonly guide: ReadingGuide; readonly mode: "walk" | "claims"; readonly number: number; readonly onSource: (source: SourceQuote) => void; readonly onTurn: (delta: number) => void }) {
  const step = guide.steps[number - 1]
  const item = guide.claims[number - 1]
  const total = mode === "walk" ? guide.steps.length : guide.claims.length
  const label = mode === "walk" ? "Step" : "Claim"
  const sources = (values: ReadonlyArray<SourceQuote>) => <SourceLinks canonical={canonical} sources={values} onSource={onSource} />
  const passage = mode === "walk" ? step?.explanation : item?.claim
  return <div className="guide-path"><article className="guide-leaf" aria-labelledby="guide-screen-title">
    <header className="guide-leaf-head"><p className="guide-kicker">{mode === "walk" ? "Walk-through" : "Claims and limits"}</p><div className="guide-progress"><span>{label} {number} of {total}</span><GuideRail total={total} at={number} /></div></header>
    <div className="guide-spread"><div className="guide-leaf-body">
      <h1 id="guide-screen-title" className={mode === "claims" ? "guide-claim-title" : undefined} tabIndex={-1}>{mode === "walk" ? step?.title : item?.claim.text}</h1>
      {mode === "walk" && step !== undefined && <p className="guide-prose">{step.explanation.text}</p>}
    </div>
    {passage !== undefined && <PaperExcerpt key={`${mode}-${number}`} canonical={canonical} sources={passage.sources} onSource={onSource} />}
    {mode === "claims" && item !== undefined && <div className="guide-claim-detail">
      <section className="guide-claim-section" aria-labelledby="guide-support-title">
        <div className="guide-section-heading"><h2 id="guide-support-title">Supporting evidence</h2><span className="guide-strength">{item.support.strength === "strong" ? "Strong support" : item.support.strength === "partial" ? "Partial support" : "Limited support"}</span></div>
        <p className="guide-prose">{item.support.text}</p>{sources(item.support.sources)}
      </section>
      <section className="guide-claim-section" aria-labelledby="guide-limits-title"><h2 id="guide-limits-title">Where it stops</h2>
        <ol className="guide-limits">{item.limits.map((limit, index) => <li key={index}><p className="guide-prose">{limit.text}</p>{sources(limit.sources)}</li>)}</ol>
      </section>
    </div>}
    </div>
  </article><nav className="guide-turn" aria-label={mode === "walk" ? "Walk-through steps" : "Claims"}>
    <button type="button" className="reader-text-link" onClick={() => onTurn(-1)}>← {number === 1 ? "Your goal" : "Back"}</button>
    <p className="guide-turn-hint">Use <kbd>←</kbd> and <kbd>→</kbd> to turn the page.</p>
    <button type="button" className="button primary" onClick={() => onTurn(1)}>{number === total ? "Finish" : mode === "walk" ? "Next step" : "Next claim"} →</button>
  </nav></div>
}

export function GuideOverview({ canonical, guide, onSource, onWalk }: { readonly canonical: CanonicalDocument; readonly guide: ReadingGuide; readonly onSource: (source: SourceQuote) => void; readonly onWalk: () => void }) {
  return <article className="guide-leaf guide-overview" aria-labelledby="guide-screen-title">
    <p className="guide-kicker">A short overview</p>
    <div className="guide-spread"><div className="guide-leaf-body"><h1 id="guide-screen-title" tabIndex={-1}>{guide.title}</h1><p className="guide-prose">{guide.overview.text}</p><button className="button primary" type="button" onClick={onWalk}>Walk me through it →</button></div>
      <PaperExcerpt canonical={canonical} sources={guide.overview.sources} onSource={onSource} />
    </div>
  </article>
}

export function GuideComplete({ guide, claims, onOther, onChoices, onRead }: { readonly guide: ReadingGuide; readonly claims: boolean; readonly onOther: () => void; readonly onChoices: () => void; readonly onRead: () => void }) {
  const total = claims ? guide.claims.length : guide.steps.length
  return <section className="guide-complete" aria-labelledby="guide-screen-title"><div className="guide-done-hero"><span className="guide-done-check" aria-hidden="true">✓</span><p className="guide-kicker">You reached the end</p><h1 id="guide-screen-title" tabIndex={-1}>{claims ? "You went through every claim." : "You finished the walk-through."}</h1><p>{claims ? `All ${total} claims, their supporting evidence, and their limits.` : `All ${total} steps, from the question to the conclusion.`}</p><GuideRail total={total} at={total + 1} /></div><div className="guide-done-grid"><section className="guide-done-card"><h2>What you covered</h2><ol>{(claims ? guide.claims.map((item) => item.claim.text) : guide.steps.map((step) => step.title)).map((title, index) => <li key={index}>{title}</li>)}</ol><p className="guide-note">The guide is AI-written. Check the source for anything you rely on.</p></section><section className="guide-done-card guide-another"><p className="guide-kicker">Another way in</p><h2>{claims ? "Walk me through it" : "Claims and limits"}</h2><p>{claims ? `${guide.steps.length} short steps through the paper.` : `${guide.claims.length} claims, with their support and limits.`}</p><button type="button" className="button primary" onClick={onOther}>{claims ? "Start the walk-through" : "Start claims and limits"} →</button><button type="button" className="reader-text-link" onClick={onRead}>Read the full paper →</button></section></div><button type="button" className="reader-text-link" onClick={onChoices}>← Choose how to read</button></section>
}
