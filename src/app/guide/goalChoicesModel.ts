import type { ReadingGuide } from "../../domain/index.ts"
import { citedBlockCount } from "../map/graph.ts"
import { countLabel } from "../text.ts"
import type { ReadingGoal } from "./navigation.ts"

export type GoalAvailability =
  | { readonly kind: "guided"; readonly guide: ReadingGuide; readonly published: boolean }
  | { readonly kind: "preparing" | "unguided"; readonly published: boolean }

export const goals = ["walk", "claims", "map", "read"] as const
export const names = { walk: "Walk me through it", claims: "Claims and limits", map: "See the document map", read: "Read the document" } as const
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

export const goalChoicesModel = (availability: GoalAvailability, selected: ReadingGoal | null) => {
  const guide = availability.kind === "guided" ? availability.guide : undefined
  const hasChoices = availability.kind !== "unguided"
  const goal = hasChoices ? selected ?? "walk" : "read"
  const published = availability.published
  const waiting = availability.kind === "preparing" && goal !== "read"
  return {
    hasChoices, goal, waiting,
    first: firstItem(guide, goal),
    lengths: goalLengths(guide),
    kicker: kicker(guide, availability.kind === "preparing"),
    action: startLabel(goal, published),
    disabled: goal !== "read" && availability.kind !== "guided",
    overview: availability.kind === "guided",
    descriptions: {
      walk: "Follow the document one idea at a time.",
      claims: "Examine the evidence behind each claim.",
      map: "See how steps and claims share passages in the document.",
      read: published ? "Read each page alongside the original." : "Read the original PDF.",
    },
    note: published
      ? "No reading guide was saved with this document. Read the document or download the full text."
      : "No reading guide was saved. You can still read and download the original PDF.",
  }
}
