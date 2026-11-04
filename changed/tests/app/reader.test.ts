import { describe, expect, it } from "@effect/vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Schema } from "effect"
import { Block, ProcessingReport } from "../../src/domain/index.ts"
import { publicPrompt } from "../../src/domain/prompt-templates.ts"
import { DocumentReadError } from "../../src/app/DocumentReadError.tsx"
import { ReportPanel } from "../../src/app/reader/Panels.tsx"
import { DocumentMarkup, ReaderBlock } from "../../src/app/reader/ReaderBlock.tsx"
import { blocksOnPage, continuationsOnPage, pageFromLocation, safeDocumentHref } from "../../src/app/reader/presentation.ts"
import { normalizeMathDelimiters } from "../../src/app/reader/math.ts"
import { appReaderFixture } from "./reader-fixture.ts"

const renderBlock = (values: Partial<Block>) => renderToStaticMarkup(createElement(ReaderBlock, { block: Schema.decodeUnknownSync(Block)({ ...appReaderFixture.canonical.blocks[0], ...values }), canonical: appReaderFixture.canonical, identity: appReaderFixture.canonical.scope }))

describe("reader content and navigation", () => {
  it("renders text format literally without interpreting code, HTML, or math syntax", () => {
    const content = '# Compute traces\n_, score, _ = solve(**kwargs)\n\nfor item in items:\n    render(item)\n<script>unsafe()</script>\n$literal_math$'
    const html = renderBlock({ kind: "unclassified", format: "text", content })
    expect(html).toContain('<p class="reader-plain-text"># Compute traces\n_, score, _ = solve(**kwargs)\n\nfor item in items:\n    render(item)\n&lt;script&gt;unsafe()&lt;/script&gt;\n$literal_math$</p>')
    expect(html).not.toMatch(/<(?:h1|em|strong|code|script)(?:\s|>)/u)
    expect(html).not.toContain('class="katex"')
  })
  it("uses canonical heading level while keeping text-format heading content literal", () => {
    const html = renderBlock({ kind: "heading", format: "text", headingLevel: 3, content: "### A _literal_ heading" })
    expect(html).toContain('<h3 class="reader-plain-text">A _literal_ heading</h3>')
    expect(html).not.toContain("<em>")
  })
  it("shows bounded bold spans in text-format blocks as bold and nothing else", () => {
    const doi = renderBlock({ kind: "paragraph", format: "text", content: "**DOI:** 10.21105/joss.07793" })
    expect(doi).toContain('<p class="reader-plain-text"><strong>DOI:</strong> 10.21105/joss.07793</p>')
    const dates = renderBlock({ kind: "paragraph", format: "text", content: "**Submitted:** 10 September 2024\n**Published:** 29 May 2025" })
    expect(dates).toContain("<strong>Submitted:</strong> 10 September 2024\n<strong>Published:</strong> 29 May 2025")
    for (const kind of ["list", "caption", "unclassified"] as const) {
      const html = renderBlock({ kind, format: "text", content: "**Reviewers:**\n• @abougouffa" })
      expect(html).toContain("<strong>Reviewers:</strong>\n• @abougouffa")
      expect(html).not.toContain("**")
    }
    const heading = renderBlock({ kind: "heading", format: "text", headingLevel: 2, content: "## **Software**" })
    expect(heading).toContain('<h2 class="reader-plain-text"><strong>Software</strong></h2>')
  })
  it("keeps asterisks that are not bold markers literal in text-format blocks", () => {
    for (const content of ["solve(**kwargs)", "f(**left), g(**right)", "2 ** 3 ** 4", "a ** b", "**unclosed", "x*y*z", "***x***", "\\*\\*x\\*\\*", "result = solve(**solve_kwargs)"]) {
      const html = renderBlock({ kind: "paragraph", format: "text", content })
      expect(html).toContain(`<p class="reader-plain-text">${content}</p>`)
    }
  })
  it("retains declared Markdown styling and inline mathematics", () => {
    const html = renderBlock({ kind: "paragraph", format: "markdown", content: "**Named algorithm** with $x_1$." })
    expect(html).toContain("<strong>Named algorithm</strong>")
    expect(html).toContain('class="katex"')
  })
  it("retains declared LaTeX equations and sanitized HTML tables", () => {
    expect(renderBlock({ kind: "equation", format: "latex", content: "x_1^2" })).toContain('class="katex-display"')
    const html = renderBlock({ kind: "table", format: "html", content: '<table><tr><td onclick="unsafe()">$x_1$</td></tr></table>' })
    expect(html).toContain("<table>")
    expect(html).toContain('class="katex"')
    expect(html).not.toContain("onclick")
  })
  it("bounds source page links and renders joined text once with a continuation", () => {
    const { canonical } = appReaderFixture
    expect(pageFromLocation("/documents/example?p=999", canonical.pages)).toBe(2)
    expect(pageFromLocation("/documents/example?p=-3", canonical.pages)).toBe(1)
    expect(pageFromLocation("/documents/example?p=1.5", canonical.pages)).toBe(1)
    expect(blocksOnPage(canonical, 1)).toHaveLength(1)
    expect(blocksOnPage(canonical, 2)).toHaveLength(0)
    expect(continuationsOnPage(canonical, 2)[0]?.sourceBlockIds).toEqual(["block-1", "block-2"])
  })
  it("supports math delimiters without rewriting code examples", () => {
    expect(normalizeMathDelimiters("Inline \\(x_1\\), `\\(literal\\)`, and \\[y^2\\]")).toBe("Inline $x_1$, `\\(literal\\)`, and \n$$\ny^2\n$$\n")
    expect(normalizeMathDelimiters("```tex\n\\[literal\\]\n```")).toBe("```tex\n\\[literal\\]\n```")
  })
  it("sanitizes active markup and remote images while preserving table spans, math and Unicode", () => {
    const html = renderToStaticMarkup(createElement(DocumentMarkup, { content: '<script>alert(1)</script><img src="https://example.invalid/a"><table><tr><td colspan="2" style="background:url(https://example.invalid/b)" onclick="alert(2)">François \\(x_1\\)</td></tr></table>\n\n[bad](javascript:alert(3))' }))
    expect(html).toContain('colSpan="2"')
    expect(html).toContain("François")
    expect(html).toContain('class="katex"')
    expect(html).not.toContain("<script")
    expect(html).not.toContain("<img")
    expect(html).not.toContain("onclick")
    expect(html).not.toContain("example.invalid")
    expect(html).not.toContain("javascript:")
  })
  it("does not permit trusted KaTeX URL or HTML commands", () => {
    const html = renderToStaticMarkup(createElement(DocumentMarkup, { content: '$\\href{javascript:alert(1)}{unsafe}$ $\\includegraphics{https://example.invalid/image}$' }))
    expect(html).not.toMatch(/<a(?:\s|>)/u)
    expect(html).not.toContain("<img")
  })
  it("allows explicit ordinary links and selects only the exact public prompt version", () => {
    expect(safeDocumentHref("javascript:alert(1)")).toBeUndefined()
    expect(safeDocumentHref("//example.invalid/a")).toBeUndefined()
    expect(safeDocumentHref("https://example.com/paper")).toBe("https://example.com/paper")
    expect(publicPrompt("page-check", "amuseme-1")).toContain("Table blocks are final and never get a fix.")
    expect(publicPrompt("page-check", "amuseme-2")).toContain("fix only words, symbols and line breaks")
    expect(publicPrompt("headings", "amuseme-1")).toContain("exact source blockId")
    expect(publicPrompt("figures", "amuseme-1")).toContain("replacement text")
    expect(publicPrompt("page-extraction", "1")).toBeNull()
    expect(publicPrompt("page-extraction", "2")).toContain("page-png-integer-crop-1")
    expect(publicPrompt("page-check", "future-version")).toBeNull()
    expect(publicPrompt("private-reasoning", "amuseme-1")).toBeNull()
  })
})

describe("reader recovery and report disclosures", () => {
  it("offers re-upload guidance only for expiry and retains retry for ambiguous or temporary failures", () => {
    const expired = renderToStaticMarkup(createElement(DocumentReadError, { error: { kind: "rejected", status: 410, message: "Expired" }, onRetry: () => {} }))
    expect(expired).toContain("Upload the PDF again")
    expect(expired).toContain('href="/"')
    expect(expired).toContain("Return to documents")
    expect(expired).not.toContain("Try again")
    for (const error of [{ kind: "rejected", status: 404, message: "Unavailable" }, { kind: "transport", message: "Connection failed" }] as const) {
      const html = renderToStaticMarkup(createElement(DocumentReadError, { error, onRetry: () => {} }))
      expect(html).toContain(error.message)
      expect(html).toContain("Try again")
      expect(html).not.toContain("expired")
    }
  })
  it("states issue counts beside output actions and offers review only when issues exist", () => {
    const expected = [
      { count: 0, summary: "Ready to read and use.", review: null },
      { count: 1, summary: "Ready with 1 issue.", review: "Review issue" },
      { count: 2, summary: "Ready with 2 issues.", review: "Review issues" },
    ] as const
    for (const { count, summary, review } of expected) {
      const report = Schema.decodeUnknownSync(ProcessingReport)({ ...appReaderFixture.report, issues: Array.from({ length: count }, () => ({ code: "table-uncertain", stage: "page-check", message: "Check the table against the PDF.", locations: [{ _tag: "page", pageId: "page-1", pageNumber: 1 }], blockIds: [], figureId: null })) })
      const html = renderToStaticMarkup(createElement(ReportPanel, { report, identity: appReaderFixture.canonical.scope, onPage: () => {}, imageSummary: "No source images" }, createElement("a", { href: "/download" }, "Download ZIP")))
      expect(html).toContain("Download ZIP")
      expect(html).toContain("Processing report")
      expect(html).not.toContain('<details class="reader-details" open')
      expect(html).toContain(summary)
      if (review === null) {
        expect(html).not.toContain("Review issue")
      } else {
        expect(html).toContain(review)
        expect(html).toContain("Compare page 1")
      }
    }
  })
  it("explains Muse reviews in plain words and frames a fallback as kept original text", () => {
    const review = { stage: "page-check", agent: "page-check-review", pageIds: ["page-2"], figureId: null, problems: ["Join reused"], rounds: 2, attemptIds: ["attempt-1"] }
    const report = Schema.decodeUnknownSync(ProcessingReport)({ ...appReaderFixture.report,
      museReviews: [{ ...review, outcome: "fallback", fallback: "Kept passing fixes only" }, { ...review, pageIds: ["page-1"], outcome: "corrected", fallback: null }],
      issues: [{ code: "provider-failure", stage: "page-check", message: "Page check fell back.", locations: [{ _tag: "page", pageId: "page-2", pageNumber: 2 }], blockIds: [], figureId: null }] })
    const html = renderToStaticMarkup(createElement(ReportPanel, { report, canonical: appReaderFixture.canonical, identity: appReaderFixture.canonical.scope, onPage: () => {}, imageSummary: "No source images" }))
    expect(html).toContain("What Muse double-checked")
    expect(html).toContain("Muse checked this and kept the original text. (page 2)")
    expect(html).toContain("caught a problem on page 1 and a second review fixed it")
    expect(html.match(/kept the original text/gu)?.length).toBe(2)
  })
})
