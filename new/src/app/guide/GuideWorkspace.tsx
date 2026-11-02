import { useEffect, useRef } from "react"
import type { CanonicalDocument, SourceQuote } from "../../domain/index.ts"
import type { DocumentRecord } from "../documents.ts"
import { activeRun } from "../documents.ts"
import { focusReadingPage, navigate, subscribeGuideKeys } from "../client/browser.ts"
import { ReaderDrawer } from "../reader/Panels.tsx"
import { GoalChoices } from "./GoalChoices.tsx"
import { PaperStatus } from "./PaperStatus.tsx"
import { GuideComplete, GuideOverview, GuidePath } from "./GuidePath.tsx"
import { GuideEvidence } from "./GuideSources.tsx"
import { guideLocation, type GuideRoute, type ReadingGoal } from "./navigation.ts"
import { boundedGuideStep, paperHeading, sourceForQuote, visibleGuideSources } from "./presentation.ts"
import "./guide.css"

export function GuideWorkspace({ record, canonical, route, page }: { readonly record: DocumentRecord; readonly canonical: CanonicalDocument; readonly route: GuideRoute; readonly page: number }) {
  const guide = canonical.guide
  const title = paperHeading(canonical) ?? record.document.originalFilename
  const mode = guide === undefined ? "choices" : route.mode
  const number = guide === undefined ? 1 : boundedGuideStep(route, guide)
  const total = mode === "claims" ? guide?.claims.length ?? 0 : guide?.steps.length ?? 0
  const screen = `${mode}-${number}`
  const previousScreen = useRef(screen)
  const body = useRef<HTMLElement>(null)
  const citations = guide === undefined ? [] : visibleGuideSources(guide, route)
  const evidence = route.source === null ? undefined : citations[route.source - 1]
  const go = (next: GuideRoute) => navigate(guideLocation(record.document.id, next, page))
  const choose = (goal: ReadingGoal) => go({ mode: "choices", goal, n: 1, source: null, view: "text" })
  const open = (goal: ReadingGoal | "overview") => go({ mode: goal, goal: goal === "overview" ? route.goal : goal, n: 1, source: null, view: "text" })
  const turn = (delta: number) => go({ mode: number + delta < 1 ? "choices" : number + delta > total ? mode === "claims" ? "done-claims" : "done-walk" : mode, goal: mode === "claims" ? "claims" : "walk", n: number + delta, source: null, view: "text" })
  const showSource = (source: SourceQuote) => {
    const index = citations.findIndex((item) => item.sourceBlockId === source.sourceBlockId && item.quote === source.quote)
    const block = sourceForQuote(canonical, source)
    if (index !== -1 && block !== undefined) navigate(guideLocation(record.document.id, { ...route, n: number, source: index + 1, view: "text" }, block.locations[0].pageNumber))
  }
  useEffect(() => {
    if (previousScreen.current === screen) return
    previousScreen.current = screen
    const heading = body.current?.querySelector<HTMLElement>("h1")
    if (heading) focusReadingPage(heading)
  }, [screen])
  useEffect(() => {
    if ((mode !== "walk" && mode !== "claims") || evidence !== undefined) return
    return subscribeGuideKeys((delta) => navigate(guideLocation(record.document.id, { mode: number + delta < 1 ? "choices" : number + delta > total ? mode === "claims" ? "done-claims" : "done-walk" : mode, goal: mode, n: number + delta, source: null, view: "text" }, page)))
  }, [mode, evidence, record.document.id, number, total, page])
  return <section className="guide-workspace" ref={body} tabIndex={-1} aria-label="Reading guide">
    {mode === "choices" ? <div className="guide-choice-layout">
      <GoalChoices {...(guide === undefined ? {} : { guide })} paperTitle={title} selected={route.goal ?? (route.mode === "walk" || route.mode === "claims" ? route.mode : null)} processing={activeRun(record.latestRun)} ready onSelect={choose} onOpen={open} />
      <PaperStatus record={record} onOriginal={() => navigate(guideLocation(record.document.id, { mode: "read", goal: "read", view: "original" }, 1))} />
    </div> : guide !== undefined && <><div className="guide-running-head"><p>{title}</p><nav className="guide-path-links" aria-label="Reading options"><button type="button" className="reader-text-link" onClick={() => choose(mode === "claims" || mode === "done-claims" ? "claims" : "walk")}>Your goal</button>{mode !== "overview" && <button type="button" className="reader-text-link" onClick={() => open("overview")}>Overview</button>}<button type="button" className="reader-text-link" onClick={() => open("read")}>Read the paper</button></nav></div>
      {mode === "overview" && <GuideOverview canonical={canonical} guide={guide} onSource={showSource} onWalk={() => open("walk")} />}
      {(mode === "walk" || mode === "claims") && <GuidePath canonical={canonical} guide={guide} mode={mode} number={number} onSource={showSource} onTurn={turn} />}
      {(mode === "done-walk" || mode === "done-claims") && <GuideComplete guide={guide} claims={mode === "done-claims"} onOther={() => open(mode === "done-claims" ? "walk" : "claims")} onChoices={() => choose(mode === "done-claims" ? "claims" : "walk")} onRead={() => open("read")} />}
    </>}
    {evidence !== undefined && <ReaderDrawer title="Evidence in the paper" side="source" focusEvidence onClose={() => go({ ...route, source: null, view: "text" })}><GuideEvidence key={`${route.source}-${page}`} canonical={canonical} source={evidence} requestedPage={page} original={route.view === "original"} onPage={(sourcePage) => navigate(guideLocation(record.document.id, route, sourcePage))} onView={(original) => go({ ...route, view: original ? "original" : "text" })} /></ReaderDrawer>}
  </section>
}
