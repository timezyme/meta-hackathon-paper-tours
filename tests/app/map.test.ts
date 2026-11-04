import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { GoalChoices } from "../../src/app/guide/GoalChoices.tsx"
import { GuideWorkspace } from "../../src/app/guide/GuideWorkspace.tsx"
import { guideRouteFromLocation } from "../../src/app/guide/navigation.ts"
import { citedBlockCount, mapConnections, mapNodeAt, mapNodeNumber, paperMap } from "../../src/app/map/graph.ts"
import { mapLayout, mapNeighbor, stackGroups } from "../../src/app/map/layout.ts"
import { PaperMapView } from "../../src/app/map/PaperMapView.tsx"
import { mapCanonical, mapGuide, mapRecord } from "./map-fixture.ts"
import { appReaderFixture } from "./reader-fixture.ts"

const ignore = () => {}
const map = paperMap(mapCanonical)!
const path = (query: string) => `/documents/${mapRecord.document.id}?${query}`

describe("document map derived from the saved guide", () => {
  it("offers no map for a document without a saved guide", () => {
    expect(paperMap(appReaderFixture.canonical)).toBeNull()
  })

  it("creates one node per step, claim, limit and distinct cited passage, ordered by page", () => {
    expect(map.nodes.map((node) => node.id)).toEqual([
      "step:1", "step:2", "step:3",
      "claim:1", "limit:1.1", "claim:2", "limit:2.1", "limit:2.2",
      "source:block-1", "source:block-3", "source:block-2", "source:block-4",
    ])
    expect(citedBlockCount(mapGuide)).toBe(4)
    const shared = map.nodes.find((node) => node.id === "source:block-3")!
    expect(shared.label).toBe("Page 1")
    expect(shared.sources.map((source) => source.quote)).toEqual(["A shared method.", "It is simple."])
    expect(map.nodes.find((node) => node.id === "claim:2")!.sources).toHaveLength(1)
    expect(map.nodes.find((node) => node.id === "claim:1")!.sources.map((source) => source.quote)).toEqual(["A shared method.", "Results improve twofold."])
  })

  it("types each connection and keeps supporting evidence over a plain citation", () => {
    const kinds = map.edges.map((edge) => `${edge.from}>${edge.to}:${edge.kind}${edge.strength === null ? "" : `:${edge.strength}`}`)
    expect(kinds.toSorted()).toEqual([
      "claim:1>limit:1.1:limits", "claim:1>source:block-3:supports:strong", "claim:1>source:block-4:supports:strong",
      "claim:2>limit:2.1:limits", "claim:2>limit:2.2:limits", "claim:2>source:block-4:supports:partial",
      "limit:1.1>source:block-2:cites", "limit:2.1>source:block-3:cites", "limit:2.2>source:block-1:cites",
      "step:1>source:block-1:cites", "step:1>step:2:next", "step:2>source:block-2:cites", "step:2>source:block-3:cites", "step:2>step:3:next", "step:3>source:block-4:cites",
    ])
    expect(mapConnections(map, "source:block-3").map((item) => item.node.id).toSorted()).toEqual(["claim:1", "limit:2.1", "step:2"])
  })

  it("lays out steps, passages and claims in fixed, non-overlapping columns", () => {
    const layout = mapLayout(map, 960)
    expect(mapLayout(map, 960)).toEqual(layout)
    expect(map.nodes.map((node) => layout.boxes.get(node.id)!.column)).toEqual([0, 0, 0, 2, 2, 2, 2, 2, 1, 1, 1, 1])
    for (const index of [0, 1, 2]) {
      const boxes = [...layout.boxes.values()].filter((box) => box.column === index).toSorted((a, b) => a.y - b.y)
      boxes.slice(1).forEach((box, position) => expect(box.y).toBeGreaterThanOrEqual(boxes[position]!.y + boxes[position]!.height))
    }
    expect(layout.paths).toHaveLength(map.edges.length)
    expect(layout.boxes.get("limit:1.1")!.x).toBeGreaterThan(layout.boxes.get("claim:1")!.x)
    expect(mapNeighbor(map, layout, "step:1", "ArrowDown")).toBe("step:2")
    expect(mapNeighbor(map, layout, "step:1", "ArrowUp")).toBeUndefined()
    expect(mapNeighbor(map, layout, "step:1", "ArrowRight")).toMatch(/^source:/u)
    expect(mapNeighbor(map, layout, "source:block-1", "ArrowRight")).toMatch(/^(claim|limit):/u)
    expect(mapNeighbor(map, layout, "claim:1", "ArrowRight")).toBeUndefined()
  })

  it("grows node heights with the root font size so larger text is not clipped", () => {
    const base = mapLayout(map, 960)
    const large = mapLayout(map, 960, 32)
    for (const node of map.nodes) expect(large.boxes.get(node.id)!.height).toBeGreaterThan(base.boxes.get(node.id)!.height)
    for (const index of [0, 1, 2]) {
      const boxes = [...large.boxes.values()].filter((box) => box.column === index).toSorted((a, b) => a.y - b.y)
      boxes.slice(1).forEach((box, position) => expect(box.y).toBeGreaterThanOrEqual(boxes[position]!.y + boxes[position]!.height))
    }
  })
})

describe("document map placement", () => {
  const layout = mapLayout(map, 960)
  const center = (id: string) => {
    const box = layout.boxes.get(id)!
    return box.y + box.height / 2
  }

  it("stacks groups at their targets in reading order, never overlapping or rising above the top", () => {
    expect(stackGroups([50, 50, 50], [null, null, null])).toEqual([44, 108, 172])
    expect(stackGroups([50, 50, 50], [300, 290, null])).toEqual([300, 364, 428])
    expect(stackGroups([50], [0])).toEqual([44])
  })

  it("places each step beside the mean of the passages it cites when there is room", () => {
    expect(center("step:1")).toBe(center("source:block-1"))
    expect(center("step:2")).toBeGreaterThanOrEqual((center("source:block-2") + center("source:block-3")) / 2)
    const [step1, step2, step3] = ["step:1", "step:2", "step:3"].map((id) => layout.boxes.get(id)!)
    expect(step2!.y).toBeGreaterThan(step1!.y + step1!.height)
    expect(step3!.y).toBeGreaterThan(step2!.y + step2!.height)
  })

  it("keeps reading-order curves close to the left edge of the step column", () => {
    const stepX = layout.boxes.get("step:1")!.x
    for (const { edge, d } of layout.paths.filter((item) => item.edge.kind === "next")) {
      const xs = [...d.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/gu)].map((match) => Number(match[1]))
      expect(Math.min(...xs), edge.to).toBeGreaterThanOrEqual(stepX - 18)
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(0)
    }
  })

  it("names every line style in the legend, with support strength shown by weight rather than dashes", () => {
    const html = renderToStaticMarkup(createElement(PaperMapView, { canonical: mapCanonical, map, selected: null, onSelect: ignore, onSource: ignore }))
    const legend = html.slice(html.indexOf('class="map-legend"'), html.indexOf("</ul>", html.indexOf('class="map-legend"')))
    for (const label of ["Reading order", "Cites a passage", "Strong support", "Partial support", "Limited support", "Limit of a claim"]) {
      expect(legend).toContain(label)
    }
    for (const strength of ["strong", "partial", "limited"]) expect(legend).toContain(`map-edge map-edge-supports map-strength-${strength}`)
  })
})

describe("document map reading view", () => {
  it("shows the legend, disclosure and the selected passage's connections and source", () => {
    const html = renderToStaticMarkup(createElement(PaperMapView, { canonical: mapCanonical, map, selected: mapNodeNumber(map, "source:block-3"), onSelect: ignore, onSource: ignore }))
    expect(html).toContain("How the ideas connect")
    expect(html).toContain("not measured relationships")
    expect(html.match(/class="map-node /gu)).toHaveLength(map.nodes.length)
    expect(html.match(/class="map-node [^"]*is-selected/gu)).toHaveLength(1)
    expect(html.match(/tabindex="0"/gu)).toHaveLength(1)
    expect(html.match(/aria-current="true"/gu)).toHaveLength(2)
    expect(html).not.toContain("aria-pressed")
    expect(html).toContain("Ideas that cite this passage")
    expect(html).toContain("Cited by step 2")
    expect(html).toContain("Supports claim 1 · strong")
    expect(html).toContain("Source · page 1")
  })

  it("labels each claim citation by whether it states or supports the claim", () => {
    const claimMap = paperMap({ ...mapCanonical, guide: { ...mapGuide, claims: [{ ...mapGuide.claims[0], support: { ...mapGuide.claims[0].support, sources: [mapGuide.steps[2]!.explanation.sources[0]] } }] } })!
    expect(claimMap.edges.filter((edge) => edge.from === "claim:1").map((edge) => `${edge.to}:${edge.kind}`).toSorted()).toEqual(["limit:1.1:limits", "source:block-3:cites", "source:block-4:supports"])
    const html = renderToStaticMarkup(createElement(PaperMapView, { canonical: mapCanonical, map: claimMap, selected: mapNodeNumber(claimMap, "claim:1"), onSelect: ignore, onSource: ignore }))
    expect(html).toMatch(/States the claim<\/span><blockquote>“A shared method\.”/u)
    expect(html).toMatch(/Supporting evidence · strong support<\/span><blockquote>“Results improve twofold\.”/u)
    expect(html).toContain("Show on map")
    expect(html).toContain('title="Claim 1 · strong support">Claim 1 · strong</span>')
    expect(html).toContain('<p class="guide-kicker">Claim 1 · strong support</p>')
  })

  it("renders math in map titles while keeping plain-text labels", () => {
    const [first, ...rest] = mapGuide.steps
    const mathMap = paperMap({ ...mapCanonical, guide: { ...mapGuide, steps: [{ ...first, title: "Bound $\\epsilon$ first" }, ...rest] } })!
    const html = renderToStaticMarkup(createElement(PaperMapView, { canonical: mapCanonical, map: mathMap, selected: 1, onSelect: ignore, onSource: ignore }))
    expect(html).toContain('class="katex"')
    expect(html).not.toContain("$\\epsilon$")
  })

  it("offers the map only with a saved guide", () => {
    const choices = renderToStaticMarkup(createElement(GoalChoices, { guide: mapGuide, selected: "map", processing: false, ready: true, onSelect: ignore, onOpen: ignore }))
    expect(choices).toContain("See the document map")
    expect(choices).toContain("4 passages")
    expect(choices).toContain("Open the map")
    expect(renderToStaticMarkup(createElement(GoalChoices, { selected: "map", processing: false, ready: true, onSelect: ignore, onOpen: ignore }))).not.toContain("See the document map")
    const route = guideRouteFromLocation(path("mode=map&node=10"))
    expect(mapNodeAt(map, route.node)?.id).toBe("source:block-3")
    expect(renderToStaticMarkup(createElement(GuideWorkspace, { record: mapRecord, canonical: mapCanonical, route, page: 1 }))).toContain("How the ideas connect")
    const withoutGuide = renderToStaticMarkup(createElement(GuideWorkspace, { record: mapRecord, canonical: appReaderFixture.canonical, route, page: 1 }))
    expect(withoutGuide).not.toContain("How the ideas connect")
    expect(withoutGuide).toContain("No reading guide was saved")
  })

  it("follows a selected node's citation to its highlighted source text", () => {
    const route = guideRouteFromLocation(path("mode=map&node=10&source=2"))
    const html = renderToStaticMarkup(createElement(GuideWorkspace, { record: mapRecord, canonical: mapCanonical, route, page: 1 }))
    expect(html).toContain("Evidence in the document")
    expect(html).toContain("A shared method. <mark>It is simple.</mark>")
  })
})
