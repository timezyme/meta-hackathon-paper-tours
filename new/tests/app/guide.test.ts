import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { GoalChoices } from "../../src/app/guide/GoalChoices.tsx"
import { GuideComplete, GuidePath } from "../../src/app/guide/GuidePath.tsx"
import { GuideEvidence, QuotedSourceText, SourceLinks } from "../../src/app/guide/GuideSources.tsx"
import { boundedGuideStep, displayQuote, turnRoute, evidencePage, paperHeading, quotedParts, visibleGuideSources } from "../../src/app/guide/presentation.ts"
import { guideRouteFromLocation, selectedGoal } from "../../src/app/guide/navigation.ts"
import { QuoteText } from "../../src/app/guide/QuoteText.tsx"
import { guidedCanonical, appGuide } from "./guide-fixture.ts"

const ignore = () => {}

describe("goal selection and saved-guide reading", () => {
  it("opens with the document title, a selected walkthrough, and one start action", () => {
    const title = "Two pieces of one paragraph"
    const block = guidedCanonical.blocks[0]!
    const heading = paperHeading({ ...guidedCanonical, blocks: [
      { ...block, kind: "heading", headingLevel: 1, content: "# Later heading", locations: [guidedCanonical.sourceBlocks[1]!.locations[0]] },
      { ...block, kind: "heading", headingLevel: 1, content: `# ${title}` },
    ] })
    expect(heading).toBe(title)
    expect(paperHeading(guidedCanonical)).toBeUndefined()
    const html = renderToStaticMarkup(createElement(GoalChoices, { guide: appGuide, paperTitle: title, selected: null, processing: false, ready: true, onSelect: ignore, onOpen: ignore }))
    expect(html).toMatch(/<h1[^>]*>Two pieces of one paragraph<\/h1>/u)
    expect(html).toMatch(/<input(?=[^>]*value="walk")(?=[^>]*checked="")[^>]*>/u)
    expect(html.match(/class="button primary"/gu)).toHaveLength(1)
    expect(html).toContain("Start step 1")
    expect(html).toContain(appGuide.steps[0].title)
  })
  it("retains a selected processing goal without inventing content, counts, or progress", () => {
    const pending = renderToStaticMarkup(createElement(GoalChoices, { selected: "walk", processing: true, ready: false, onSelect: ignore, onOpen: ignore }))
    expect(pending).toMatch(/<input(?=[^>]*value="walk")(?=[^>]*checked="")[^>]*>/u)
    expect(pending).toContain("While AmuseMe reads")
    expect(pending).toContain('disabled=""')
    expect(pending).toContain("Your choice will stay selected")
    expect(pending).not.toContain(appGuide.steps[0].title)
    expect(pending).not.toContain("Saved with this document")
    const ready = renderToStaticMarkup(createElement(GoalChoices, { guide: appGuide, selected: "walk", processing: false, ready: true, onSelect: ignore, onOpen: ignore }))
    expect(ready).toMatch(/<input(?=[^>]*value="walk")(?=[^>]*checked="")[^>]*>/u)
    expect(ready).toContain(appGuide.steps[0].title)
    expect(ready).not.toContain('disabled=""')
  })
  it("explains historical missing guides while keeping original and full reader choices", () => {
    const unavailable = renderToStaticMarkup(createElement(GoalChoices, { selected: "claims", processing: false, ready: true, onSelect: ignore, onOpen: ignore }))
    expect(unavailable).toContain("No reading guide was saved with this document")
    expect(unavailable).toContain("Read the document")
    expect(unavailable).not.toContain("Ready when")
    const original = renderToStaticMarkup(createElement(GoalChoices, { selected: "read", processing: true, ready: false, onSelect: ignore, onOpen: ignore }))
    expect(original).toContain("Open the original")
    expect(original).not.toContain('disabled=""')
  })
  it("shows one step or claim per screen, with complete support and limits", () => {
    const step = renderToStaticMarkup(createElement(GuidePath, { canonical: guidedCanonical, guide: appGuide, mode: "walk", number: 2, onSource: ignore, onTurn: ignore }))
    expect(step).toContain(appGuide.steps[1]!.title)
    expect(step).toContain("Beginning")
    expect(step).not.toContain(appGuide.steps[2]!.title)
    expect(step).toContain("Next step")
    expect(step).toMatch(/<blockquote>“Beginning”<\/blockquote>.*?Source · page 1/u)
    expect(step).toMatch(/<summary>1 more excerpt<\/summary>.*?<blockquote>“and ending\.”<\/blockquote>.*?Source · page 2/u)
    const claim = renderToStaticMarkup(createElement(GuidePath, { canonical: guidedCanonical, guide: appGuide, mode: "claims", number: 2, onSource: ignore, onTurn: ignore }))
    expect(claim).toContain(appGuide.claims[1]!.claim.text)
    expect(claim).toContain("Partial support")
    expect(claim).toContain(appGuide.claims[1]!.limits[0]!.text)
    expect(claim).not.toContain(appGuide.claims[0].claim.text)
    expect(claim).toContain("Finish")
  })
  it("bounds a restored step to real guide content and exposes a complete return path", () => {
    const route = guideRouteFromLocation("/documents/example?mode=walk&n=99")
    expect(boundedGuideStep(route, appGuide)).toBe(3)
    expect(visibleGuideSources(appGuide, route)).toEqual(appGuide.steps[2]!.explanation.sources)
    const complete = renderToStaticMarkup(createElement(GuideComplete, { guide: appGuide, claims: false, downloads: { zip: "/zip", text: "/text" }, onOther: ignore, onMap: ignore, onChoices: ignore, onRead: ignore }))
    expect(complete).toContain("You finished the walk-through")
    expect(complete).toContain("Start claims and limits")
    expect(complete).toContain("Read the full document")
    expect(complete).toContain("Choose how to read")
    expect(complete).toContain('href="/zip"')
    expect(complete).toMatch(/rests on \d+ quoted passage/u)
  })
})

describe("evidence from immutable source blocks", () => {
  it("resolves the later source page of a joined block and highlights its exact source text", () => {
    const citation = appGuide.steps[1]!.explanation.sources[1]!
    expect(evidencePage(guidedCanonical, citation, 1)).toBe(2)
    const html = renderToStaticMarkup(createElement(GuideEvidence, { canonical: guidedCanonical, source: citation, requestedPage: 1, original: false, onPage: ignore, onView: ignore }))
    expect(html).toContain("Source text · page 2")
    expect(html).toContain("<mark>and ending.</mark>")
    expect(html).not.toContain("Beginning")
    expect(html).toContain("Original")
    expect(html).not.toContain("pixel")
  })
  it("uses stored page numbers for source buttons and the actual original preview route", () => {
    const citation = appGuide.steps[1]!.explanation.sources[1]!
    const links = renderToStaticMarkup(createElement(SourceLinks, { canonical: guidedCanonical, sources: [citation], onSource: ignore }))
    expect(links).toContain("Source · page 2")
    expect(links).toContain('aria-label="Source · page 2: “and ending.”"')
    expect(links).not.toContain("↗")
    const unknown = renderToStaticMarkup(createElement(SourceLinks, { canonical: { ...guidedCanonical, sourceBlocks: [] }, sources: [citation], onSource: ignore }))
    expect(unknown).toContain("</svg>Source</button>")
    const original = renderToStaticMarkup(createElement(GuideEvidence, { canonical: guidedCanonical, source: citation, requestedPage: 99, original: true, onPage: ignore, onView: ignore }))
    expect(original).toContain(`/api/documents/${guidedCanonical.scope.documentId}/preview?page=2`)
    expect(original).toContain("and ending.")
    expect(original).not.toContain("<mark>")
  })
  it("does not treat source markup as executable content or guess ambiguous highlights", () => {
    const content = 'Before <script>alert(1)</script> after\n[link](https://untrusted.example)'
    const html = renderToStaticMarkup(createElement(QuotedSourceText, { content, quote: "<script>alert(1)</script>" }))
    expect(html).toContain("<mark>&lt;script&gt;alert(1)&lt;/script&gt;</mark>")
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("href=")
    expect(quotedParts("repeat repeat", "repeat")).toBeNull()
    expect(quotedParts("The actual source", "invented")).toBeNull()
    expect(quotedParts("The actual source", "")).toBeNull()
  })
  it("hides a leading list marker from displayed quotes without changing the saved quote", () => {
    for (const marker of ["- ", "* ", "• ", "1. ", "12) "]) expect(displayQuote(`${marker}A modular and extensible API`)).toBe("A modular and extensible API")
    expect(displayQuote("-1 is negative")).toBe("-1 is negative")
    expect(displayQuote("2.5 times faster")).toBe("2.5 times faster")
    expect(displayQuote("- ")).toBe("- ")
    expect(displayQuote("<tr><td>Offices of Physicians</td><td>81.0%</td></tr><tr><td>Total &amp; other</td><td>41.7</td></tr>")).toBe("Offices of Physicians · 81.0% / Total & other · 41.7")
    expect(displayQuote("Physicians</td><td>81.0%")).toBe("Physicians · 81.0%")
    expect(displayQuote("a <b> b")).toBe("a <b> b")
    const quote = "- A modular API"
    const html = renderToStaticMarkup(createElement(GuideEvidence, { canonical: { ...guidedCanonical, sourceBlocks: guidedCanonical.sourceBlocks.map((block) => block.id === "block-2" ? { ...block, content: `Intro\n${quote}` } : block) }, source: { sourceBlockId: guidedCanonical.sourceBlocks[1]!.id, quote }, requestedPage: 2, original: false, onPage: ignore, onView: ignore }))
    expect(html).toContain(`<mark>${quote}</mark>`)
  })
  it("renders math in displayed quotes and leaves plain quotes and prices as text", () => {
    const math = renderToStaticMarkup(createElement(QuoteText, { quote: "an $\\epsilon$-Nash equilibrium" }))
    expect(math).toContain("katex")
    expect(math).not.toContain("$\\epsilon$")
    expect(renderToStaticMarkup(createElement(QuoteText, { quote: "- A modular *API*" }))).toBe("A modular *API*")
    expect(renderToStaticMarkup(createElement(QuoteText, { quote: "costs $ 5 and $ 10" }))).toBe("costs $ 5 and $ 10")
    const prices = "revenue grew from $1.2 trillion in 2002 to $3.1 trillion in 2022"
    expect(renderToStaticMarkup(createElement(QuoteText, { quote: prices }))).toBe(prices)
    expect(renderToStaticMarkup(createElement(QuoteText, { quote: "$5,$10 and $20" }))).toBe("$5,$10 and $20")
    const mixed = renderToStaticMarkup(createElement(QuoteText, { quote: "costs $2 per $x$ unit" }))
    expect(mixed).toContain("katex")
    expect(mixed).toContain("costs $2 per")
  })
})

describe("turning guide pages", () => {
  const walk = guideRouteFromLocation("/documents/doc?mode=walk&goal=walk&n=2&source=1")
  const claims = guideRouteFromLocation("/documents/doc?mode=claims&goal=claims&n=3&view=original")

  it("moves within a path and clears the open source", () => {
    expect(turnRoute(walk, 3, 5)).toEqual({ mode: "walk", goal: "walk", n: 3, source: null, node: null, view: "text" })
    expect(turnRoute(claims, 2, 3)).toEqual({ mode: "claims", goal: "claims", n: 2, source: null, node: null, view: "text" })
  })

  it("returns to the goal before the first page and finishes after the last", () => {
    expect(turnRoute(walk, 0, 5)).toMatchObject({ mode: "choices", goal: "walk" })
    expect(turnRoute(walk, 6, 5)).toMatchObject({ mode: "done-walk", goal: "walk" })
    expect(turnRoute(claims, 4, 3)).toMatchObject({ mode: "done-claims", goal: "claims" })
  })

  it("keeps the chosen goal, or infers it from the reading mode", () => {
    expect(selectedGoal({ mode: "choices", goal: "read" })).toBe("read")
    expect(selectedGoal({ mode: "map", goal: null })).toBe("map")
    expect(selectedGoal({ mode: "overview", goal: null })).toBeNull()
  })
})
