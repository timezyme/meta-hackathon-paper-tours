import { describe, expect, it } from "@effect/vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Schema } from "effect"
import { Block } from "../../src/domain/index.ts"
import { publicPrompt } from "../../src/domain/prompt-templates.ts"
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
    expect(publicPrompt("page-check", "future-version")).toBeNull()
    expect(publicPrompt("private-reasoning", "amuseme-1")).toBeNull()
  })
})
