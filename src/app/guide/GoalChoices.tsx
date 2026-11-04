import { goalChoicesModel, goals, names } from "./goalChoicesModel.ts"
import type { ReadingGuide } from "../../domain/index.ts"
import { navigate } from "../client/browser.ts"
import { guideLocation, type ReadingGoal } from "./navigation.ts"

export const chooseGoal = (documentId: string, goal: ReadingGoal, page: number): void =>
  navigate(guideLocation(documentId, { mode: "choices", goal }, page), true)

export function GoalChoices({ guide, paperTitle, selected, processing, ready, onSelect, onOpen }: {
  readonly guide?: ReadingGuide
  readonly paperTitle?: string
  readonly selected: ReadingGoal | null
  readonly processing: boolean
  readonly ready: boolean
  readonly onSelect: (goal: ReadingGoal) => void
  readonly onOpen: (goal: ReadingGoal | "overview") => void
}) {
  const model = goalChoicesModel(guide === undefined
    ? { kind: processing ? "preparing" : "unguided", published: ready }
    : { kind: "guided", guide, published: ready }, selected)
  const { hasChoices, goal, first, lengths, descriptions, action, note } = model

  return <section className="guide-goals" aria-labelledby="guide-goal-title">
    <header className="guide-cover-head">
      <p className="guide-kicker">{model.kicker}</p>
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
    {model.waiting && <p className="guide-note" role="status">
      Your choice will stay selected while the guide is prepared.
    </p>}
    <div className="guide-start">
      <button type="button" className="button primary" disabled={model.disabled} onClick={() => onOpen(goal)}>
        {action}<span aria-hidden="true">→</span>
      </button>
      {model.overview && <button type="button" className="reader-text-link" onClick={() => onOpen("overview")}>Short overview</button>}
    </div>
  </section>
}
