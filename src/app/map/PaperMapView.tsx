import { useEffect, useRef } from "react"
import type { CanonicalDocument, SourceQuote } from "../../domain/index.ts"
import { focusMapNode } from "../client/browser.ts"
import { countLabel } from "../text.ts"
import { MathText } from "../guide/QuoteText.tsx"
import { mapConnections, mapNodeAt, mapNodeNumber, type MapEdge, type MapNode, type MapNodeKind, type PaperMap } from "./graph.ts"
import { MapGraph } from "./MapGraph.tsx"
import { MapPanel } from "./MapPanel.tsx"
import { edgeClass, nodeKicker, nodeTitle } from "./presentation.ts"
import "./map.css"

const groups: ReadonlyArray<{ readonly label: string; readonly kinds: ReadonlyArray<MapNodeKind> }> = [
  { label: "Walk-through", kinds: ["step"] },
  { label: "Claims and limits", kinds: ["claim", "limit"] },
  { label: "Cited passages", kinds: ["source"] },
]

const legend: ReadonlyArray<{ readonly edge: Pick<MapEdge, "kind" | "strength">; readonly label: string }> = [
  { edge: { kind: "next", strength: null }, label: "Reading order" },
  { edge: { kind: "cites", strength: null }, label: "Cites a passage" },
  { edge: { kind: "supports", strength: "strong" }, label: "Strong support" },
  { edge: { kind: "supports", strength: "partial" }, label: "Partial support" },
  { edge: { kind: "supports", strength: "limited" }, label: "Limited support" },
  { edge: { kind: "limits", strength: null }, label: "Limit of a claim" },
]

const linkSummary = (map: PaperMap, node: MapNode): string => {
  const connections = mapConnections(map, node.id)
  if (node.kind !== "source") return countLabel(connections.filter((item) => item.node.kind === "source").length, "passage")
  return `Cited by ${countLabel(connections.filter((item) => item.node.kind !== "source" && item.edge.kind !== "next").length, "idea")}`
}

function Legend() {
  return <ul className="map-legend" aria-label="Line types">{legend.map(({ edge, label }) => <li key={label}>
    <svg viewBox="0 0 28 8" aria-hidden="true"><path className={edgeClass(edge)} d="M 1 4 H 27" /></svg>{label}
  </li>)}</ul>
}

function MapList({ map, node, onSelect }: { readonly map: PaperMap; readonly node: MapNode | undefined; readonly onSelect: (id: string) => void }) {
  return <nav className="map-list" aria-label="Map items">{groups.map((group) => <section key={group.label} aria-label={group.label}>
    <h2>{group.label}</h2>
    <ul>{map.nodes.filter((item) => group.kinds.includes(item.kind)).map((item) =>
      <li key={item.id} className={item.kind === "limit" ? "map-list-nested" : undefined}>
        <button type="button" className={`map-list-item map-node-${item.kind}`} aria-current={item.id === node?.id ? "true" : undefined} onClick={() => onSelect(item.id)}>
          <span className="map-node-kicker">{nodeKicker(item)}</span><span className="map-list-title"><MathText text={nodeTitle(item)} /></span>
          <small>{linkSummary(map, item)}</small>
        </button>
      </li>)}</ul>
  </section>)}</nav>
}

export function PaperMapView({ canonical, map, selected, onSelect, onSource }: {
  readonly canonical: CanonicalDocument
  readonly map: PaperMap
  readonly selected: number | null
  readonly onSelect: (number: number) => void
  readonly onSource: (source: SourceQuote) => void
}) {
  const node = mapNodeAt(map, selected)
  const heading = useRef<HTMLHeadingElement>(null)
  const reveal = useRef(false)
  const select = (id: string, show: boolean) => {
    reveal.current = show
    onSelect(mapNodeNumber(map, id))
  }
  useEffect(() => {
    if (!reveal.current || heading.current === null) return
    reveal.current = false
    focusMapNode(heading.current)
  })
  const count = (kind: MapNodeKind, label: string) => countLabel(map.nodes.filter((item) => item.kind === kind).length, label)
  const summary = `Document map: ${count("step", "step")}, ${count("claim", "claim")}, ${count("source", "cited passage")}`
  return <section className="paper-map" aria-labelledby="guide-screen-title">
    <header className="map-head">
      <div><p className="guide-kicker">Document map</p><h1 id="guide-screen-title" tabIndex={-1}>How the ideas connect</h1></div>
      <p className="map-disclosure">Connections come from the guide’s citations, not measured relationships.</p>
    </header>
    <Legend />
    <div className="map-body">
      <div className="map-graph" role="group" aria-label={summary} aria-describedby="map-keys">
        <p id="map-keys" className="visually-hidden">Use the arrow keys to move between items and Enter to select one.</p>
        <MapGraph map={map} selected={node?.id ?? null} onSelect={(id) => select(id, false)} />
      </div>
      <MapPanel canonical={canonical} map={map} node={node} heading={heading} onSelect={(id) => select(id, true)} onSource={onSource} />
      <MapList map={map} node={node} onSelect={(id) => select(id, true)} />
    </div>
  </section>
}
