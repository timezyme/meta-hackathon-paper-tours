import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { GoalChoices } from "../../src/app/guide/GoalChoices.tsx"
import { GuideComplete, GuidePath } from "../../src/app/guide/GuidePath.tsx"
import { GuideEvidence, QuotedSourceText, SourceLinks } from "../../src/app/guide/GuideSources.tsx"
import { boundedGuideStep, evidencePage, paperHeading, quotedParts, visibleGuideSources } from "../../src/app/guide/presentation.ts"
import { guideRouteFromLocation } from "../../src/app/guide/navigation.ts"
import { guidedCanonical, readerGuide } from "./guide-fixture.ts"

const ignore = () => {}

describe("goal selection and saved-guide reading", () => {
  it("opens with the paper title, a selected walkthrough, and one start action", () => {
    const title = "Two pieces of one paragraph"
    const block = guidedCanonical.blocks[0]!
    const heading = paperHeading({ ...guidedCanonical, blocks: [
      { ...block, kind: "heading", headingLevel: 1, content: "# Later heading", locations: [guidedCanonical.sourceBlocks[1]!.locations[0]] },
      { ...block, kind: "heading", headingLevel: 1, content: `# ${title}` },
    ] })
    expect(heading).toBe(title)
    expect(paperHeading(guidedCanonical)).toBeUndefined()
    const html = renderToStaticMarkup(createElement(GoalChoices, { guide: readerGuide, paperTitle: title, selected: null, processing: false, ready: true, onSelect: ignore, onOpen: ignore }))
    expect(html).toMatch(/<h1[^>]*>Two pieces of one paragraph<\/h1>/u)
    expect(html).toMatch(/<input(?=[^>]*value="walk")(?=[^>]*checked="")[^>]*>/u)
    expect(html.match(/class="button primary"/gu)).toHaveLength(1)
    expect(html).toContain("Start step 1")
    expect(html).toContain(readerGuide.steps[0].title)
  })
  it("retains a selected processing goal without inventing content, counts, or progress", () => {
    const pending = renderToStaticMarkup(createElement(GoalChoices, { selected: "walk", processing: true, ready: false, onSelect: ignore, onOpen: ignore }))
    expect(pending).toMatch(/<input(?=[^>]*value="walk")(?=[^>]*checked="")[^>]*>/u)
    expect(pending).toContain("While AmuseMe reads")
    expect(pending).toContain('disabled=""')
    expect(pending).toContain("Your choice will stay selected")
    expect(pending).not.toContain(readerGuide.steps[0].title)
    expect(pending).not.toContain("Saved with this document")
    const ready = renderToStaticMarkup(createElement(GoalChoices, { guide: readerGuide, selected: "walk", processing: false, ready: true, onSelect: ignore, onOpen: ignore }))
    expect(ready).toMatch(/<input(?=[^>]*value="walk")(?=[^>]*checked="")[^>]*>/u)
    expect(ready).toContain(readerGuide.steps[0].title)
    expect(ready).not.toContain('disabled=""')
  })
  it("explains historical missing guides while keeping original and full reader choices", () => {
    const unavailable = renderToStaticMarkup(createElement(GoalChoices, { selected: "claims", processing: false, ready: true, onSelect: ignore, onOpen: ignore }))
    expect(unavailable).toContain("No reading guide was saved with this document")
    expect(unavailable).toContain("Read the paper")
    expect(unavailable).not.toContain("Ready when")
    const original = renderToStaticMarkup(createElement(GoalChoices, { selected: "read", processing: true, ready: false, onSelect: ignore, onOpen: ignore }))
    expect(original).toContain("Open the original")
    expect(original).not.toContain('disabled=""')
  })
  it("shows one step or claim per screen, with complete support and limits", () => {
    const step = renderToStaticMarkup(createElement(GuidePath, { canonical: guidedCanonical, guide: readerGuide, mode: "walk", number: 2, onSource: ignore, onTurn: ignore }))
    expect(step).toContain(readerGuide.steps[1]!.title)
    expect(step).toContain("Beginning")
    expect(step).not.toContain(readerGuide.steps[2]!.title)
    expect(step).toContain("Next step")
    expect(step).toMatch(/<blockquote>“Beginning”<\/blockquote>.*?Source · page 1/u)
    expect(step).toMatch(/<summary>1 more excerpt<\/summary>.*?<blockquote>“and ending\.”<\/blockquote>.*?Source · page 2/u)
    const claim = renderToStaticMarkup(createElement(GuidePath, { canonical: guidedCanonical, guide: readerGuide, mode: "claims", number: 2, onSource: ignore, onTurn: ignore }))
    expect(claim).toContain(readerGuide.claims[1]!.claim.text)
    expect(claim).toContain("Partial support")
    expect(claim).toContain(readerGuide.claims[1]!.limits[0]!.text)
    expect(claim).not.toContain(readerGuide.claims[0].claim.text)
    expect(claim).toContain("Finish")
  })
  it("bounds a restored step to real guide content and exposes a complete return path", () => {
    const route = guideRouteFromLocation("/documents/example?mode=walk&n=99")
    expect(boundedGuideStep(route, readerGuide)).toBe(3)
    expect(visibleGuideSources(readerGuide, route)).toEqual(readerGuide.steps[2]!.explanation.sources)
    const complete = renderToStaticMarkup(createElement(GuideComplete, { guide: readerGuide, claims: false, onOther: ignore, onChoices: ignore, onRead: ignore }))
    expect(complete).toContain("You finished the walk-through")
    expect(complete).toContain("Start claims and limits")
    expect(complete).toContain("Read the full paper")
    expect(complete).toContain("Choose how to read")
  })
})

describe("evidence from immutable source blocks", () => {
  it("resolves the later source page of a joined block and highlights its exact source text", () => {
    const citation = readerGuide.steps[1]!.explanation.sources[1]!
    expect(evidencePage(guidedCanonical, citation, 1)).toBe(2)
    const html = renderToStaticMarkup(createElement(GuideEvidence, { canonical: guidedCanonical, source: citation, requestedPage: 1, original: false, onPage: ignore, onView: ignore }))
    expect(html).toContain("Source text · page 2")
    expect(html).toContain("<mark>and ending.</mark>")
    expect(html).not.toContain("Beginning")
    expect(html).toContain("Original")
    expect(html).not.toContain("pixel")
  })
  it("uses stored page numbers for source buttons and the actual original preview route", () => {
    const citation = readerGuide.steps[1]!.explanation.sources[1]!
    const links = renderToStaticMarkup(createElement(SourceLinks, { canonical: guidedCanonical, sources: [citation], onSource: ignore }))
    expect(links).toContain("Source · page 2")
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
})
