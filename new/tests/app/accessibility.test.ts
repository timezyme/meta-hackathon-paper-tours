import { Schema } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ProcessingReport } from "../../src/domain/index.ts"
import { GuideComplete, GuideOverview, GuidePath } from "../../src/app/guide/GuidePath.tsx"
import { GuideEvidence } from "../../src/app/guide/GuideSources.tsx"
import { ReportPanel } from "../../src/app/reader/Panels.tsx"
import { appGuide, guidedCanonical } from "./guide-fixture.ts"
import { appReaderFixture } from "./reader-fixture.ts"

const ignore = () => {}
const glyph = /[←→↗↓✓]/u
const announced = (html: string) => html
  .replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/gu, "")
  .replace(/<kbd>[^<]*<\/kbd>/gu, "")
const issue = {
  code: "table-uncertain", stage: "page-check", message: "Check the table against the PDF.",
  locations: [{ _tag: "page", pageId: "page-1", pageNumber: 1 }], blockIds: [], figureId: null,
}
const report = Schema.decodeUnknownSync(ProcessingReport)({ ...appReaderFixture.report, issues: [issue] })
const path = (mode: "walk" | "claims", number: number) => createElement(GuidePath, {
  canonical: guidedCanonical, guide: appGuide, mode, number, onSource: ignore, onTurn: ignore,
})
const complete = (claims: boolean) => createElement(GuideComplete, {
  guide: appGuide, claims, downloads: { zip: "/zip", text: "/text", textName: "amuseme-0123abcd.txt" },
  onOther: ignore, onMap: ignore, onChoices: ignore, onRead: ignore,
})

describe("decorative glyphs", () => {
  it("keeps arrows and check marks visible but out of every accessible name", () => {
    const screens = [
      path("walk", 1), path("walk", appGuide.steps.length), path("claims", 1), complete(false), complete(true),
      createElement(GuideOverview, { canonical: guidedCanonical, guide: appGuide, onSource: ignore, onWalk: ignore }),
      createElement(GuideEvidence, {
        canonical: guidedCanonical, source: appGuide.steps[0]!.explanation.sources[0]!, requestedPage: 1,
        original: false, onPage: ignore, onView: ignore,
      }),
      createElement(ReportPanel, {
        report, canonical: appReaderFixture.canonical, identity: appReaderFixture.canonical.scope, onPage: ignore,
        imageSummary: "No source images",
      }),
    ]
    for (const screen of screens) {
      const html = renderToStaticMarkup(screen)
      expect(html).toMatch(glyph)
      expect(announced(html)).not.toMatch(glyph)
    }
    expect(renderToStaticMarkup(path("walk", 1))).toContain('Next step <span aria-hidden="true">→</span>')
  })
})
