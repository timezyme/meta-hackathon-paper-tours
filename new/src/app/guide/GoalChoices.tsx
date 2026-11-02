import type { ReadingGuide } from "../../domain/index.ts"
import { citedBlockCount } from "../map/graph.ts"
import { countLabel } from "../text.ts"
import type { ReadingGoal } from "./navigation.ts"

const goals = ["walk", "claims", "map", "read"] as const
const names = { walk: "Walk me through it", claims: "Claims and limits", map: "See the document map", read: "Read the document" } as const
const actions = { walk: "Start step 1", claims: "Start claim 1", map: "Open the map" } as const

const goalLengths = (guide: ReadingGuide | undefined): Record<ReadingGoal, string | undefined> => ({
  walk: guide && countLabel(guide.steps.length, "step"),
  claims: guide && countLabel(guide.claims.length, "claim"),
  map: guide && countLabel(citedBlockCount(guide), "passage"),
  read: undefined,
})

const firstItem = (guide: ReadingGuide | undefined, goal: ReadingGoal): string | undefined => {
  if (goal === "walk") return guide?.steps[0].title
  return goal === "claims" ? guide?.claims[0].claim.text : undefined
}

const startLabel = (goal: ReadingGoal, ready: boolean): string => {
  if (goal !== "read") return actions[goal]
  return ready ? "Open the document" : "Open the original"
}

const kicker = (guide: ReadingGuide | undefined, processing: boolean): string => {
  if (guide !== undefined) return "Reading guide"
  return processing ? "While AmuseMe reads" : "Your document"
}

export function GoalChoices({ guide, paperTitle, selected, processing, ready, onSelect, onOpen }: {
  readonly guide?: ReadingGuide
  readonly paperTitle?: string
  readonly selected: ReadingGoal | null
  readonly processing: boolean
  readonly ready: boolean
  readonly onSelect: (goal: ReadingGoal) => void
  readonly onOpen: (goal: ReadingGoal | "overview") => void
}) {
  const hasChoices = guide !== undefined || processing
  const goal = hasChoices ? selected ?? "walk" : "read"
  const first = firstItem(guide, goal)
  const lengths = goalLengths(guide)
  const descriptions = {
    walk: "Follow the document one idea at a time.",
    claims: "Examine the evidence behind each claim.",
    map: "See how steps and claims share passages in the document.",
    read: ready ? "Read each page alongside the original." : "Read the original PDF.",
  }
  const action = startLabel(goal, ready)
  const note = ready
    ? "No reading guide was saved with this document. Read the document or download the full text."
    : "No reading guide was saved. You can still read and download the original PDF."

  return <section className="guide-goals" aria-labelledby="guide-goal-title">
    <header className="guide-cover-head">
      <p className="guide-kicker">{kicker(guide, processing)}</p>
      <h1 id="guide-goal-title" tabIndex={-1}>{paperTitle ?? (hasChoices ? "How would you like to read?" : "Read the document")}</h1>
    </header>
    {hasChoices ? <fieldset className="guide-choices">
      <legend>Your reading goal</legend>
      {goals.map((option) => <label className="guide-choice" key={option}>
        <input type="radio" name="reading-goal" value={option} checked={goal === option} onChange={() => onSelect(option)} />
        <span className="guide-choice-text"><strong>{names[option]}</strong><span>{descriptions[option]}</span></span>
        {lengths[option] && <small>{lengths[option]}</small>}
      </label>)}
    </fieldset> : <p className="guide-note">{note}</p>}
    {first !== undefined && <p className="guide-first"><span>{goal === "walk" ? "First step" : "First claim"}</span>{first}</p>}
    {guide === undefined && processing && goal !== "read" && <p className="guide-note" role="status">
      Your choice will stay selected while the guide is prepared.
    </p>}
    <div className="guide-start">
      <button type="button" className="button primary" disabled={goal !== "read" && guide === undefined} onClick={() => onOpen(goal)}>
        {action}<span aria-hidden="true">→</span>
      </button>
      {guide !== undefined && <button type="button" className="reader-text-link" onClick={() => onOpen("overview")}>Short overview</button>}
    </div>
  </section>
}
