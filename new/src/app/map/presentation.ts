import { displayQuote } from "../guide/presentation.ts"
import type { MapEdge, MapNode } from "./graph.ts"

const strengthNames = { strong: "strong support", partial: "partial support", limited: "limited support" } as const

export const nodeKicker = (node: MapNode, compact = false): string => {
  if (node.kind !== "claim" || node.strength === null) return node.label
  return `${node.label} · ${compact ? node.strength : strengthNames[node.strength]}`
}
export const nodeTitle = (node: MapNode): string => node.kind === "source" ? `“${displayQuote(node.title)}”` : node.title
export const edgeClass = (edge: Pick<MapEdge, "kind" | "strength">): string =>
  `map-edge map-edge-${edge.kind}${edge.strength === null ? "" : ` map-strength-${edge.strength}`}`
