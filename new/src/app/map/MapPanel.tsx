import type { RefObject } from "react"
import type { CanonicalDocument, SourceQuote } from "../../domain/index.ts"
import { SourceLinks } from "../guide/GuideSources.tsx"
import { MathText, QuoteText } from "../guide/QuoteText.tsx"
import { mapConnections, sameQuote, sourceNodeId, type MapConnection, type MapNode, type PaperMap } from "./graph.ts"
import { nodeKicker, nodeTitle } from "./presentation.ts"

type OnSelect = (id: string) => void

const relation = ({ edge, node, outgoing }: MapConnection): string => {
  if (edge.kind === "next") return outgoing ? "Next step" : "Previous step"
  if (edge.kind === "limits") return outgoing ? "Limited by" : "Limits"
  if (edge.kind === "supports") return `Supports ${node.label.toLowerCase()} · ${edge.strength}`
  return `Cited by ${node.label.toLowerCase()}`
}

const citationLabel = (node: MapNode, source: SourceQuote): string => {
  if (node.support.some((item) => sameQuote(item, source))) return `Supporting evidence · ${node.strength} support`
  return node.kind === "claim" ? "States the claim" : "Cited passage"
}

function NodeLink({ node, label, onSelect }: { readonly node: MapNode; readonly label: string; readonly onSelect: OnSelect }) {
  return <li className="map-link-row"><span className="map-link-relation">{label}</span>
    <button type="button" className="map-link" onClick={() => onSelect(node.id)}><strong>{node.label}</strong><span><MathText text={nodeTitle(node)} /></span></button>
  </li>
}

function IntroPanel({ heading }: { readonly heading: RefObject<HTMLHeadingElement | null> }) {
  return <aside className="map-panel" aria-label="Selected map item">
    <p className="guide-kicker">How to use the map</p>
    <h2 ref={heading} tabIndex={-1}>Choose a step, claim, or passage</h2>
    <p className="map-panel-text">
      Lines show which passages of the document each step and claim cites. Shared passages connect ideas that rely on the same words.
      Select anything to follow it to the source.
    </p>
  </aside>
}

function Citation({ canonical, map, node, source, onSelect, onSource }: {
  readonly canonical: CanonicalDocument
  readonly map: PaperMap
  readonly node: MapNode
  readonly source: SourceQuote
  readonly onSelect: OnSelect
  readonly onSource: (source: SourceQuote) => void
}) {
  const isSource = node.kind === "source"
  const passage = isSource ? undefined : map.nodes.find((item) => item.id === sourceNodeId(source.sourceBlockId))
  return <li>
    {!isSource && <span className="map-link-relation">{citationLabel(node, source)}</span>}
    {(!isSource || node.sources.length > 1) && <blockquote>“<QuoteText quote={source.quote} />”</blockquote>}
    <div className="map-citation-actions"><SourceLinks canonical={canonical} sources={[source]} onSource={onSource} />
      {passage !== undefined && <button type="button" className="reader-text-link" onClick={() => onSelect(passage.id)}>Show on map</button>}
    </div>
  </li>
}

export function MapPanel({ canonical, map, node, heading, onSelect, onSource }: {
  readonly canonical: CanonicalDocument
  readonly map: PaperMap
  readonly node: MapNode | undefined
  readonly heading: RefObject<HTMLHeadingElement | null>
  readonly onSelect: OnSelect
  readonly onSource: (source: SourceQuote) => void
}) {
  if (node === undefined) return <IntroPanel heading={heading} />
  const isSource = node.kind === "source"
  const ideas = mapConnections(map, node.id).filter((connection) => connection.node.kind !== "source")
  return <aside className="map-panel" aria-label="Selected map item">
    <p className="guide-kicker">{nodeKicker(node)}</p>
    <h2 ref={heading} tabIndex={-1} className={isSource ? "map-panel-quote" : undefined}><MathText text={nodeTitle(node)} /></h2>
    {node.text !== null && <p className="map-panel-text">{node.kind === "claim" && <strong>Support: </strong>}{node.text}</p>}
    <section className="map-panel-section" aria-label="Passages in the document"><h3>{isSource ? "Open in the document" : "Passages in the document"}</h3>
      <ul className="map-citations">{node.sources.map((source, index) => <Citation key={`${source.sourceBlockId}-${index}`}
        canonical={canonical} map={map} node={node} source={source} onSelect={onSelect} onSource={onSource} />)}</ul>
    </section>
    {ideas.length > 0 && <section className="map-panel-section" aria-label="Connected ideas">
      <h3>{isSource ? "Ideas that cite this passage" : "Connected ideas"}</h3>
      <ul className="map-links">{ideas.map((connection) =>
        <NodeLink key={connection.node.id} node={connection.node} label={relation(connection)} onSelect={onSelect} />)}</ul>
    </section>}
  </aside>
}
