export const countLabel = (count: number, singular: string, plural = `${singular}s`): string => `${count} ${count === 1 ? singular : plural}`

const bold = /(?<=^|[\s(])\*\*(?!\*)([^\s*](?:[^\n]*?[^\s*\\])?)\*\*(?!\*)(?=$|[\s.,;:!?)\]"'’”-])/gu

export type TextSpan = { readonly text: string; readonly bold: boolean }
export const boldSpans = (text: string): ReadonlyArray<TextSpan> => {
  const spans: Array<TextSpan> = []
  let last = 0
  for (const match of text.matchAll(bold)) {
    if (match.index > last) spans.push({ text: text.slice(last, match.index), bold: false })
    spans.push({ text: match[1] ?? "", bold: true })
    last = match.index + match[0].length
  }
  if (last < text.length || spans.length === 0) spans.push({ text: text.slice(last), bold: false })
  return spans
}
export const withoutBold = (text: string): string => text.replace(bold, "$1")

export const headingText = (content: string): string => withoutBold(content.replace(/^#{1,6}\s+/u, "")).trim()
