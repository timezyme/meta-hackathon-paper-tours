import { useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent } from "react"
import { focusMapNode, observeWidth } from "../client/browser.ts"
import { MathText } from "../guide/QuoteText.tsx"
import type { MapEdge, MapNode, PaperMap } from "./graph.ts"
import { mapLayout, mapNeighbor, type MapBox, type MapDirection } from "./layout.ts"
import { edgeClass, nodeKicker, nodeTitle } from "./presentation.ts"

const directions: ReadonlySet<string> = new Set<MapDirection>(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"])

const touches = (edge: MapEdge, id: string | null): boolean => id !== null && (edge.from === id || edge.to === id)
const neighbors = (map: PaperMap, id: string | null): ReadonlySet<string> =>
  new Set(map.edges.flatMap((edge) => touches(edge, id) ? [edge.from === id ? edge.to : edge.from] : []))

const nodeState = (id: string, selected: string | null, active: string | null, related: ReadonlySet<string>): string => {
  if (id === selected) return " is-selected"
  if (id === active) return " is-active"
  return related.has(id) ? " is-related" : ""
}

type NodeProps = {
  readonly node: MapNode
  readonly box: MapBox
  readonly state: string
  readonly focusable: boolean
  readonly selected: boolean
  readonly register: (id: string, element: HTMLButtonElement | null) => void
  readonly onSelect: (id: string) => void
  readonly onArrow: (event: KeyboardEvent<HTMLButtonElement>, id: string) => void
  readonly onHover: (id: string | null) => void
}

function MapNodeButton({ node, box, state, focusable, selected, register, onSelect, onArrow, onHover }: NodeProps) {
  return <button type="button" ref={(element) => register(node.id, element)}
    className={`map-node map-node-${node.kind}${state}`} style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    tabIndex={focusable ? 0 : -1} aria-current={selected ? "true" : undefined}
    onClick={() => onSelect(node.id)} onKeyDown={(event) => onArrow(event, node.id)}
    onPointerEnter={(event) => { if (event.pointerType === "mouse") onHover(node.id) }}
    onFocus={() => onHover(node.id)} onBlur={() => onHover(null)}>
    <span className="map-node-kicker" title={nodeKicker(node)}>{nodeKicker(node, true)}</span>
    <span className="map-node-title"><MathText text={nodeTitle(node)} /></span>
  </button>
}

export function MapGraph({ map, selected, onSelect }: {
  readonly map: PaperMap
  readonly selected: string | null
  readonly onSelect: (id: string) => void
}) {
  const stage = useRef<HTMLDivElement>(null)
  const ruler = useRef<HTMLSpanElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const [width, setWidth] = useState(900)
  const [rem, setRem] = useState(16)
  const [hovered, setHovered] = useState<string | null>(null)
  const layout = useMemo(() => mapLayout(map, width, rem), [map, width, rem])
  const active = hovered ?? selected
  const related = useMemo(() => neighbors(map, active), [map, active])
  const focusable = selected ?? map.nodes[0]?.id
  useEffect(() => {
    const element = stage.current
    const unit = ruler.current
    if (element === null || unit === null) return undefined
    const stopWidth = observeWidth(element, setWidth)
    const stopRem = observeWidth(unit, (size) => { if (size > 0) setRem(size) })
    return () => { stopWidth(); stopRem() }
  }, [])
  const register = (id: string, element: HTMLButtonElement | null) => {
    if (element === null) buttons.current.delete(id)
    else buttons.current.set(id, element)
  }
  const onArrow = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (!directions.has(event.key)) return
    const next = mapNeighbor(map, layout, id, event.key as MapDirection)
    const target = next === undefined ? undefined : buttons.current.get(next)
    event.preventDefault()
    if (target !== undefined) focusMapNode(target)
  }
  const size = { width: layout.width, height: layout.height }

  return <div className="map-stage" ref={stage}>
    <span className="map-ruler" ref={ruler} aria-hidden="true" />
    <div className={`map-canvas${active === null ? "" : " has-active"}`} style={size} onPointerLeave={() => setHovered(null)}>
      {layout.columns.map((column) =>
        <p className="map-column-label" key={column.label} style={{ left: column.x, width: column.width }}>{column.label}</p>)}
      <svg className="map-edges" {...size} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
        {layout.paths.map(({ edge, d }) =>
          <path key={`${edge.from}|${edge.to}`} d={d} className={`${edgeClass(edge)}${touches(edge, active) ? " is-active" : ""}`} />)}
      </svg>
      {map.nodes.map((node) => {
        const box = layout.boxes.get(node.id)
        if (box === undefined) return null
        return <MapNodeButton key={node.id} node={node} box={box} state={nodeState(node.id, selected, active, related)}
          focusable={node.id === focusable} selected={node.id === selected} register={register}
          onSelect={onSelect} onArrow={onArrow} onHover={setHovered} />
      })}
    </div>
  </div>
}
