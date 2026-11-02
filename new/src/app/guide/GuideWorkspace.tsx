import { useEffect, useEffectEvent, useMemo, useRef } from "react"
import type { CanonicalDocument, ReadingGuide, SourceQuote } from "../../domain/index.ts"
import type { DocumentRecord } from "../documents.ts"
import { activeRun } from "../documents.ts"
import { focusReadingPage, navigate, subscribeGuideKeys } from "../client/browser.ts"
import { ReaderDrawer } from "../reader/Panels.tsx"
import { outputUrl } from "../client/outputs.ts"
import { GoalChoices } from "./GoalChoices.tsx"
import { PaperStatus } from "./PaperStatus.tsx"
import { GuideComplete, GuideOverview, GuidePath } from "./GuidePath.tsx"
import { GuideEvidence } from "./GuideSources.tsx"
import { guideLocation, selectedGoal, type GuideMode, type GuideRoute, type ReadingGoal } from "./navigation.ts"
import { boundedGuideStep, paperHeading, sourceForQuote, turnRoute, visibleGuideSources } from "./presentation.ts"
import { mapNodeAt, paperMap, sameQuote, type PaperMap } from "../map/graph.ts"
import { PaperMapView } from "../map/PaperMapView.tsx"
import "./guide.css"

type Props = { readonly record: DocumentRecord; readonly canonical: CanonicalDocument; readonly route: GuideRoute; readonly page: number }

const returnGoal: Record<GuideMode, ReadingGoal> = {
  choices: "walk", overview: "walk", walk: "walk", "done-walk": "walk", read: "walk",
  claims: "claims", "done-claims": "claims", map: "map",
}

const routeCitations = (guide: ReadingGuide, map: PaperMap | null, route: GuideRoute): ReadonlyArray<SourceQuote> => {
  if (route.mode !== "map") return visibleGuideSources(guide, route)
  return map === null ? [] : mapNodeAt(map, route.node)?.sources ?? []
}

function RunningHead({ title, mode, onChoose, onOpen }: {
  readonly title: string
  readonly mode: GuideMode
  readonly onChoose: (goal: ReadingGoal) => void
  readonly onOpen: (goal: ReadingGoal | "overview") => void
}) {
  return <div className="guide-running-head"><p>{title}</p><nav className="guide-path-links" aria-label="Reading options">
    <button type="button" className="reader-text-link" onClick={() => onChoose(returnGoal[mode])}>Your goal</button>
    {mode !== "overview" && <button type="button" className="reader-text-link" onClick={() => onOpen("overview")}>Overview</button>}
    {mode !== "map" && <button type="button" className="reader-text-link" onClick={() => onOpen("map")}>Document map</button>}
    <button type="button" className="reader-text-link" onClick={() => onOpen("read")}>Read the document</button>
  </nav></div>
}

export function GuideWorkspace({ record, canonical, route, page }: Props) {
  const guide = canonical.guide
  const documentId = record.document.id
  const title = paperHeading(canonical) ?? record.document.originalFilename
  const mode = guide === undefined ? "choices" : route.mode
  const number = guide === undefined ? 1 : boundedGuideStep(route, guide)
  const total = mode === "claims" ? guide?.claims.length ?? 0 : guide?.steps.length ?? 0
  const screen = `${mode}-${number}`
  const previousScreen = useRef(screen)
  const body = useRef<HTMLElement>(null)
  const map = useMemo(() => paperMap(canonical), [canonical])
  const citations = guide === undefined ? [] : routeCitations(guide, map, route)
  const evidence = route.source === null ? undefined : citations[route.source - 1]
  const go = (next: GuideRoute) => navigate(guideLocation(documentId, next, page))
  const choose = (goal: ReadingGoal) => go({ mode: "choices", goal, n: 1, source: null, node: null, view: "text" })
  const open = (goal: ReadingGoal | "overview") => {
    go({ mode: goal, goal: goal === "overview" ? route.goal : goal, n: 1, source: null, node: null, view: "text" })
  }
  const turn = (delta: number) => go(turnRoute({ ...route, mode }, number + delta, total))
  const onKey = useEffectEvent(turn)
  const showSource = (source: SourceQuote) => {
    const index = citations.findIndex((item) => sameQuote(item, source))
    const block = sourceForQuote(canonical, source)
    if (index === -1 || block === undefined) return
    navigate(guideLocation(documentId, { ...route, n: number, source: index + 1, view: "text" }, block.locations[0].pageNumber))
  }
  const closeEvidence = () => go({ ...route, source: null, view: "text" })
  const finishedClaims = mode === "done-claims"
  const identity = { documentId, revisionId: canonical.scope.revisionId }
  const downloads = { zip: outputUrl(identity, "zip"), text: outputUrl(identity, "text") }
  const pathMode = mode === "walk" || mode === "claims" ? mode : null
  useEffect(() => {
    if (previousScreen.current === screen) return
    previousScreen.current = screen
    const heading = body.current?.querySelector<HTMLElement>("h1")
    if (heading) focusReadingPage(heading)
  }, [screen])
  const keysActive = pathMode !== null && evidence === undefined
  useEffect(() => keysActive ? subscribeGuideKeys((delta) => onKey(delta)) : undefined, [keysActive])
  return <section className="guide-workspace" ref={body} tabIndex={-1} aria-label="Reading guide">
    {mode === "choices" ? <div className="guide-choice-layout">
      <GoalChoices {...(guide === undefined ? {} : { guide })} paperTitle={title} selected={selectedGoal(route)}
        processing={activeRun(record.latestRun)} ready onSelect={choose} onOpen={open} />
      <PaperStatus record={record} onOriginal={() => navigate(guideLocation(documentId, { mode: "read", goal: "read", view: "original" }, 1))} />
    </div> : guide !== undefined && <>
      <RunningHead title={title} mode={mode} onChoose={choose} onOpen={open} />
      {mode === "overview" && <GuideOverview canonical={canonical} guide={guide} onSource={showSource} onWalk={() => open("walk")} />}
      {mode === "map" && map !== null && <PaperMapView canonical={canonical} map={map} selected={route.node}
        onSelect={(node) => go({ ...route, node, source: null, view: "text" })} onSource={showSource} />}
      {pathMode !== null && <GuidePath canonical={canonical} guide={guide} mode={pathMode} number={number} onSource={showSource} onTurn={turn} />}
      {(mode === "done-walk" || finishedClaims) && <GuideComplete guide={guide} claims={finishedClaims} downloads={downloads}
        onOther={() => open(finishedClaims ? "walk" : "claims")} onMap={() => open("map")}
        onChoices={() => choose(returnGoal[mode])} onRead={() => open("read")} />}
    </>}
    {evidence !== undefined && <ReaderDrawer title="Evidence in the document" side="source" focusEvidence onClose={closeEvidence}>
      <GuideEvidence key={`${route.source}-${page}`} canonical={canonical} source={evidence} requestedPage={page}
        original={route.view === "original"} onPage={(sourcePage) => navigate(guideLocation(documentId, route, sourcePage))}
        onView={(original) => go({ ...route, view: original ? "original" : "text" })} />
    </ReaderDrawer>}
  </section>
}
