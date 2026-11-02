import type { ReadingGuide } from "../../domain/index.ts"
import type { ReadingGoal } from "./navigation.ts"

const goals = ["walk", "claims", "read"] as const
const names = { walk: "Walk me through it", claims: "Claims and limits", read: "Read the paper" } as const

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
  const first = goal === "walk" ? guide?.steps[0].title : goal === "claims" ? guide?.claims[0].claim.text : undefined
  const lengths = { walk: guide && `${guide.steps.length} ${guide.steps.length === 1 ? "step" : "steps"}`, claims: guide && `${guide.claims.length} ${guide.claims.length === 1 ? "claim" : "claims"}`, read: undefined }
  const descriptions = { walk: "Follow the paper one idea at a time.", claims: "Examine the evidence behind each claim.", read: ready ? "Read each page alongside the original." : "Read the original PDF." }
  const action = goal === "walk" ? "Start step 1" : goal === "claims" ? "Start claim 1" : ready ? "Open the paper" : "Open the original"

  return <section className="guide-goals" aria-labelledby="guide-goal-title">
    <header className="guide-cover-head">
      <p className="guide-kicker">{guide !== undefined ? "Reading guide" : processing ? "While AmuseMe reads" : "Your paper"}</p>
      <h1 id="guide-goal-title" tabIndex={-1}>{paperTitle ?? (hasChoices ? "How would you like to read?" : "Read the paper")}</h1>
    </header>
    {hasChoices ? <fieldset className="guide-choices">
      <legend>Your reading goal</legend>
      {goals.map((option) => <label className="guide-choice" key={option}>
        <input type="radio" name="reading-goal" value={option} checked={goal === option} onChange={() => onSelect(option)} />
        <span className="guide-choice-text"><strong>{names[option]}</strong><span>{descriptions[option]}</span></span>
        {lengths[option] && <small>{lengths[option]}</small>}
      </label>)}
    </fieldset> : <p className="guide-note">{ready ? "No reading guide was saved with this document. Read the paper or download the full text." : "No reading guide was saved. You can still read and download the original PDF."}</p>}
    {first !== undefined && <p className="guide-first"><span>{goal === "walk" ? "First step" : "First claim"}</span>{first}</p>}
    {guide === undefined && processing && goal !== "read" && <p className="guide-note" role="status">Your choice will stay selected while the guide is prepared.</p>}
    <div className="guide-start">
      <button type="button" className="button primary" disabled={goal !== "read" && guide === undefined} onClick={() => onOpen(goal)}>{action}<span aria-hidden="true">→</span></button>
      {guide !== undefined && <button type="button" className="reader-text-link" onClick={() => onOpen("overview")}>Short overview</button>}
    </div>
  </section>
}
