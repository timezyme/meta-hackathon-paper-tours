// SPDX-License-Identifier: MIT -- Curved-link geometry adapted from Vectorize Hindsight; see NOTICE.md and LICENSE.
import type { MapEdge, MapNode, MapNodeKind, PaperMap } from "./graph.ts"

type Column = 0 | 1 | 2
type Point = { readonly x: number; readonly y: number }
export type MapBox = { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly column: Column }
export type MapColumn = { readonly label: string; readonly x: number; readonly width: number }
export type MapLayout = {
  readonly width: number
  readonly height: number
  readonly columns: ReadonlyArray<MapColumn>
  readonly boxes: ReadonlyMap<string, MapBox>
  readonly paths: ReadonlyArray<{ readonly edge: MapEdge; readonly d: string }>
}
export type MapDirection = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"

const kickerAndTitleRems: Record<MapNodeKind, number> = { step: 3.25, source: 3.45, claim: 4.4, limit: 3.25 }
const paddingBorderGapPx = 24
type Heights = Readonly<Record<MapNodeKind, number>>
const nodeHeights = (rem: number): Heights => {
  const size = (kind: MapNodeKind) => Math.ceil(paddingBorderGapPx + kickerAndTitleRems[kind] * rem)
  return { step: size("step"), source: size("source"), claim: size("claim"), limit: size("limit") }
}
const columnOf: Record<MapNodeKind, Column> = { step: 0, source: 1, claim: 2, limit: 2 }
const columnLabels = ["Walk-through", "Cited passages", "Claims and limits"] as const
const top = 44
const arcRoom = 26
const hug = 18
const indent = 22
const innerGap = 8
const gapY = 14

const groupHeight = (heights: Heights) => (group: ReadonlyArray<MapNode>): number =>
  group.reduce((sum, node, index) => sum + heights[node.kind] + (index === 0 ? 0 : innerGap), 0)
const mean = (values: ReadonlyArray<number>): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length

export const stackGroups = (heightsOf: ReadonlyArray<number>, targets: ReadonlyArray<number | null>): ReadonlyArray<number> => {
  let cursor = top
  return heightsOf.map((height, index) => {
    const y = Math.max(targets[index] ?? cursor, cursor)
    cursor = y + height + gapY
    return y
  })
}

export const curvePath = (from: Point, to: Point): string => {
  const bulge = Math.min(hug, Math.abs(to.y - from.y) * 0.4)
  return `M ${from.x} ${from.y} C ${from.x - bulge} ${from.y} ${to.x - bulge} ${to.y} ${to.x} ${to.y}`
}

const crossPath = (from: Point, to: Point): string => {
  const middle = (from.x + to.x) / 2
  return `M ${from.x} ${from.y} C ${middle} ${from.y} ${middle} ${to.y} ${to.x} ${to.y}`
}

const columnGroups = (map: PaperMap): ReadonlyArray<ReadonlyArray<ReadonlyArray<MapNode>>> => {
  const groups: Array<Array<Array<MapNode>>> = [[], [], []]
  for (const node of map.nodes) {
    const column = groups[columnOf[node.kind]]!
    const previous = column.at(-1)
    if (node.kind === "limit" && previous !== undefined) previous.push(node)
    else column.push([node])
  }
  return groups
}

const placeColumn = (
  groups: ReadonlyArray<ReadonlyArray<MapNode>>,
  height: (group: ReadonlyArray<MapNode>) => number,
  target: (group: ReadonlyArray<MapNode>) => number | null,
): ReadonlyArray<number> => {
  const targets = groups.map((group) => {
    const center = target(group)
    return center === null ? null : center - height(group) / 2
  })
  return stackGroups(groups.map(height), targets)
}

export const mapLayout = (map: PaperMap, availableWidth: number, rem = 16): MapLayout => {
  const heights = nodeHeights(rem)
  const height = groupHeight(heights)
  const width = Math.max(560, Math.round(availableWidth))
  const gap = Math.round(Math.min(120, Math.max(64, (width - arcRoom) * 0.1)))
  const columnWidth = Math.floor((width - arcRoom - gap * 2) / 3)
  const xs = [arcRoom, arcRoom + columnWidth + gap, arcRoom + (columnWidth + gap) * 2] as const
  const groups = columnGroups(map)
  const boxes = new Map<string, MapBox>()
  const centers = new Map<string, number>()
  const place = (column: Column, tops: ReadonlyArray<number>) => groups[column]!.forEach((group, groupIndex) => {
    let y = tops[groupIndex]!
    group.forEach((node, index) => {
      const nested = index > 0 ? indent : 0
      boxes.set(node.id, { x: xs[column] + nested, y, width: columnWidth - nested, height: heights[node.kind], column })
      centers.set(node.id, y + heights[node.kind] / 2)
      y += heights[node.kind] + innerGap
    })
  })
  place(1, stackGroups(groups[1]!.map(height), []))
  const linked = new Map<string, Array<number>>()
  for (const edge of map.edges) {
    const center = centers.get(edge.to)
    if (center !== undefined && edge.kind !== "next") linked.set(edge.from, [...linked.get(edge.from) ?? [], center])
  }
  const barycenter = (group: ReadonlyArray<MapNode>) => mean(group.flatMap((node) => linked.get(node.id) ?? []))
  place(0, placeColumn(groups[0]!, height, barycenter))
  place(2, placeColumn(groups[2]!, height, barycenter))

  const ports = new Map<string, Array<{ readonly edge: MapEdge; readonly other: number }>>()
  const centerY = (id: string) => centers.get(id) ?? 0
  const port = (id: string, side: "left" | "right", edge: MapEdge, other: string) => {
    const key = `${id}|${side}`
    ports.set(key, [...ports.get(key) ?? [], { edge, other: centerY(other) }])
  }
  const sideOf = (id: string, other: string): "left" | "right" =>
    (boxes.get(other)?.column ?? 0) > (boxes.get(id)?.column ?? 0) ? "right" : "left"
  for (const edge of map.edges) {
    if (edge.kind === "next" || edge.kind === "limits") continue
    port(edge.from, sideOf(edge.from, edge.to), edge, edge.to)
    port(edge.to, sideOf(edge.to, edge.from), edge, edge.from)
  }
  const anchor = (id: string, side: "left" | "right", edge: MapEdge): Point => {
    const box = boxes.get(id)!
    const attached = (ports.get(`${id}|${side}`) ?? []).toSorted((a, b) => a.other - b.other)
    const index = attached.findIndex((item) => item.edge === edge)
    const inner = box.height - 24
    const offset = attached.length === 1 ? inner / 2 : inner * index / (attached.length - 1)
    return { x: side === "left" ? box.x : box.x + box.width, y: box.y + 12 + offset }
  }
  const paths = map.edges.flatMap((edge) => {
    const from = boxes.get(edge.from)
    const to = boxes.get(edge.to)
    if (from === undefined || to === undefined) return []
    if (edge.kind === "next") return [{ edge, d: curvePath({ x: from.x, y: centerY(edge.from) }, { x: to.x, y: centerY(edge.to) }) }]
    if (edge.kind === "limits") return [{ edge, d: `M ${from.x + indent / 2} ${from.y + from.height} V ${centerY(edge.to)} H ${to.x}` }]
    const start = anchor(edge.from, sideOf(edge.from, edge.to), edge)
    const end = anchor(edge.to, sideOf(edge.to, edge.from), edge)
    return [{ edge, d: start.x < end.x ? crossPath(start, end) : crossPath(end, start) }]
  })
  const bottom = Math.ceil(Math.max(...[...boxes.values()].map((box) => box.y + box.height), top) + 8)
  const columns = columnLabels.map((label, index) => ({ label, x: xs[index as Column], width: columnWidth }))
  return { width, height: bottom, columns, boxes, paths }
}

export const mapNeighbor = (map: PaperMap, layout: MapLayout, id: string, direction: MapDirection): string | undefined => {
  const box = layout.boxes.get(id)
  if (box === undefined) return undefined
  const inColumn = (column: number) => map.nodes.filter((node) => layout.boxes.get(node.id)?.column === column)
  if (direction === "ArrowUp" || direction === "ArrowDown") {
    const column = inColumn(box.column)
    const index = column.findIndex((node) => node.id === id)
    return column[index + (direction === "ArrowUp" ? -1 : 1)]?.id
  }
  const center = box.y + box.height / 2
  const distance = (node: MapNode) => {
    const other = layout.boxes.get(node.id)!
    return Math.abs(other.y + other.height / 2 - center)
  }
  const step = direction === "ArrowLeft" ? -1 : 1
  for (let column = box.column + step; column >= 0 && column <= 2; column += step) {
    const nearest = inColumn(column).toSorted((a, b) => distance(a) - distance(b))[0]
    if (nearest !== undefined) return nearest.id
  }
  return undefined
}
