import type { SourceBlock } from "../../src/domain/index.ts"
import { contractFixture } from "./contracts.ts"

const html = '<table><tr><th rowspan="2">Paramter</th><th>Value</th></tr><tr><td>λ₁</td><td>12</td></tr></table>'
export const tableCorrections: ReadonlyArray<{ readonly name: string; readonly format: SourceBlock["format"]; readonly original: string; readonly replacement: string }> = [
  { name: "words", format: "html", original: html, replacement: html.replace("Paramter", "Parameter") },
  { name: "symbols", format: "html", original: html, replacement: html.replace("λ₁", "λⱼ ± σ") },
  { name: "cell line breaks", format: "html", original: html, replacement: html.replace("Paramter", "Parameter<br>name\n# samples") },
  { name: "number", format: "html", original: html, replacement: html.replace("12", "99") },
  { name: "row", format: "html", original: html, replacement: html.replace("</table>", "<tr><td>Extra</td><td>21</td></tr></table>") },
  { name: "cell", format: "html", original: html, replacement: html.replace("<td>12</td>", "") },
  { name: "column", format: "html", original: html, replacement: html.replaceAll("</tr>", "<td>Extra</td></tr>") },
  { name: "span", format: "html", original: html, replacement: html.replace('rowspan="2"', 'rowspan="3" colspan="2"') },
  { name: "text table", format: "text", original: "Paramter\tValue\nλ₁\t12", replacement: "  Parameter\tValue\nλⱼ ± σ\t99\nExtra\t21  \n" },
  { name: "text table with a source heading-like prefix", format: "text", original: "# Paramter\tValue\nλ₁\t12", replacement: "Parameter\tValue\nλⱼ\t12\n" },
  { name: "literal heading-like cell text", format: "text", original: "# Paramter\tValue\nλ₁\t12", replacement: "# Parameter\tValue\nλ₁\t12" },
]

export const tableCorrectionFixture = (format: SourceBlock["format"], content: string) => {
  const base = contractFixture("table")
  return { ...base, extraction: { ...base.extraction, sourceBlocks: base.extraction.sourceBlocks.map((block) => ({ ...block, content, format })) } }
}
