import type { Extraction, SourceBlock } from "../../domain/index.ts"

export const headingMark = (content: string): string | null => /^(#{1,6})\s/u.exec(content)?.[1] ?? null
export const withoutHeadingMark = (content: string): string => content.replace(/^#{1,6}\s+/u, "")
export const oneHeadingLine = (content: string): boolean => content.trim().split(/\r?\n/u).length === 1
export const restoreHeadingMark = (original: string, replacement: string): string => {
  const mark = headingMark(original.trimStart())
  if (mark === null) return replacement
  const lines = replacement.split("\n")
  const index = lines.findIndex((line) => line.trim() !== "")
  const first = lines[index]?.trimStart()
  if (first === undefined || headingMark(first) === mark) return replacement
  lines[index] = `${mark} ${withoutHeadingMark(first)}`
  return lines.join("\n")
}
export const preservesOneBlock = (content: string): boolean => {
  let fenced = false
  let headings = 0
  let ordinary = 0
  for (const line of content.split(/\r?\n/u)) {
    if (/^\s*(?:```|~~~)/u.test(line)) fenced = !fenced
    if (!fenced && /^#{1,6}\s/u.test(line)) headings += 1
    else if (line.trim() !== "") ordinary += 1
  }
  return headings === 0 || (headings === 1 && ordinary === 0 && withoutHeadingMark(content.trimStart()).trim() !== "")
}

export const formatCorrectedText = (extraction: Extraction, blocks: ReadonlyArray<SourceBlock>): string => {
  const emitted = new Set<string>()
  const entries = blocks.map((block) => {
    const images = extraction.figures.filter((figure) => figure.sourceBlockIds.includes(block.id) && !emitted.has(figure.id)).map((figure) => {
      emitted.add(figure.id)
      const link = figure.asset._tag === "available" ? `![${figure.id}](${figure.asset.artifact.path})` : `[Image ${figure.id} unavailable: ${figure.asset.reason}]`
      const captionPresent = blocks.some((candidate) => figure.captionBlockIds.includes(candidate.id) && candidate.content.trim() !== "")
      return `${link}${figure.originalCaption === "" || captionPresent ? "" : `\nOriginal caption: ${figure.originalCaption}`}`
    })
    return [block.content, ...images].filter((content) => content !== "").join("\n\n")
  })
  for (const figure of extraction.figures.filter((item) => !emitted.has(item.id))) {
    entries.push(`${figure.asset._tag === "available" ? `![${figure.id}](${figure.asset.artifact.path})` : `[Image ${figure.id} unavailable: ${figure.asset.reason}]`}\nOriginal caption: ${figure.originalCaption}`)
  }
  return entries.join("\n\n")
}
