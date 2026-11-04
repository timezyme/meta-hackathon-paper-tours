import type { CanonicalDocument, ReadingGuide, SourceQuote } from "../../domain/index.ts"

export type Strength = ReadingGuide["claims"][number]["support"]["strength"]
export type MapNodeKind = "step" | "claim" | "limit" | "source"
export type MapEdgeKind = "next" | "cites" | "supports" | "limits"

export type MapNode = {
  readonly id: string
  readonly kind: MapNodeKind
  readonly label: string
  readonly title: string
  readonly text: string | null
  readonly strength: Strength | null
  readonly pages: ReadonlyArray<number>
  readonly sources: ReadonlyArray<SourceQuote>
  readonly support: ReadonlyArray<SourceQuote>
}
export type MapEdge = { readonly from: string; readonly to: string; readonly kind: MapEdgeKind; readonly strength: Strength | null }
export type PaperMap = { readonly nodes: ReadonlyArray<MapNode>; readonly edges: ReadonlyArray<MapEdge> }
export type MapConnection = { readonly edge: MapEdge; readonly node: MapNode; readonly outgoing: boolean }

export const sourceNodeId = (blockId: SourceQuote["sourceBlockId"]): string => `source:${blockId}`
export const sameQuote = (a: SourceQuote, b: SourceQuote): boolean => a.sourceBlockId === b.sourceBlockId && a.quote === b.quote
const distinct = (sources: ReadonlyArray<SourceQuote>): ReadonlyArray<SourceQuote> =>
  sources.filter((source, index) => sources.findIndex((item) => sameQuote(item, source)) === index)
type NodeFields = Pick<MapNode, "id" | "kind" | "label" | "title" | "sources"> & Partial<MapNode>
const mapNode = (fields: NodeFields): MapNode => ({ text: null, strength: null, pages: [], support: [], ...fields, sources: distinct(fields.sources) })
const pageLabel = (pages: ReadonlyArray<number>): string => pages.length === 1 ? `Page ${pages[0]}` : `Pages ${pages[0]}–${pages.at(-1)}`

export const citedBlockCount = (guide: ReadingGuide): number => new Set([
  ...guide.steps.flatMap((step) => step.explanation.sources),
  ...guide.claims.flatMap((item) => [...item.claim.sources, ...item.support.sources, ...item.limits.flatMap((limit) => limit.sources)]),
].map((source) => source.sourceBlockId)).size

export const paperMap = (canonical: CanonicalDocument): PaperMap | null => {
  const guide = canonical.guide
  if (guide === undefined) return null
  const blocks = new Map(canonical.sourceBlocks.map((block) => [block.id, block]))
  const quotes = new Map<SourceQuote["sourceBlockId"], Array<SourceQuote>>()
  const edges = new Map<string, MapEdge>()
  const link = (from: string, to: string, kind: MapEdgeKind, strength: Strength | null = null) => {
    const key = `${from}|${to}`
    if (edges.get(key)?.kind !== "supports") edges.set(key, { from, to, kind, strength })
  }
  const cite = (from: string, sources: ReadonlyArray<SourceQuote>, kind: "cites" | "supports" = "cites", strength: Strength | null = null) => {
    for (const source of sources) {
      if (!blocks.has(source.sourceBlockId)) continue
      const cited = quotes.get(source.sourceBlockId) ?? []
      if (!cited.some((item) => item.quote === source.quote)) cited.push(source)
      quotes.set(source.sourceBlockId, cited)
      link(from, sourceNodeId(source.sourceBlockId), kind, strength)
    }
  }
  const nodes: Array<MapNode> = []
  guide.steps.forEach((step, index) => {
    const id = `step:${index + 1}`
    nodes.push(mapNode({ id, kind: "step", label: `Step ${index + 1}`, title: step.title, text: step.explanation.text, sources: step.explanation.sources }))
    if (index > 0) link(`step:${index}`, id, "next")
    cite(id, step.explanation.sources)
  })
  guide.claims.forEach((item, index) => {
    const id = `claim:${index + 1}`
    nodes.push(mapNode({
      id, kind: "claim", label: `Claim ${index + 1}`, title: item.claim.text, text: item.support.text, strength: item.support.strength,
      sources: [...item.claim.sources, ...item.support.sources], support: item.support.sources,
    }))
    cite(id, item.claim.sources)
    cite(id, item.support.sources, "supports", item.support.strength)
    item.limits.forEach((limit, limitIndex) => {
      const limitId = `limit:${index + 1}.${limitIndex + 1}`
      nodes.push(mapNode({ id: limitId, kind: "limit", label: `Limit ${index + 1}.${limitIndex + 1}`, title: limit.text, sources: limit.sources }))
      link(id, limitId, "limits")
      cite(limitId, limit.sources)
    })
  })
  const sources = [...quotes.entries()].flatMap(([blockId, cited]) => {
    const block = blocks.get(blockId)
    return block === undefined ? [] : [{ block, cited }]
  }).toSorted((a, b) => a.block.locations[0].pageNumber - b.block.locations[0].pageNumber || a.block.readingOrder - b.block.readingOrder)
  for (const { block, cited } of sources) {
    const pages = [...new Set(block.locations.map((location) => location.pageNumber))].toSorted((a, b) => a - b)
    nodes.push(mapNode({ id: sourceNodeId(block.id), kind: "source", label: pageLabel(pages), title: cited[0]?.quote ?? "", pages, sources: cited }))
  }
  return { nodes, edges: [...edges.values()] }
}

export const mapNodeAt = (map: PaperMap, number: number | null): MapNode | undefined =>
  number === null ? undefined : map.nodes[number - 1]
export const mapNodeNumber = (map: PaperMap, id: string): number => map.nodes.findIndex((node) => node.id === id) + 1

export const mapConnections = (map: PaperMap, id: string): ReadonlyArray<MapConnection> => {
  const byId = new Map(map.nodes.map((node) => [node.id, node]))
  return map.edges.flatMap((edge) => {
    if (edge.from !== id && edge.to !== id) return []
    const other = byId.get(edge.from === id ? edge.to : edge.from)
    return other === undefined ? [] : [{ edge, node: other, outgoing: edge.from === id }]
  })
}
