export const normalizeMathDelimiters = (source: string): string => source.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`]*`)/gu).map((part) => part.startsWith("`") || part.startsWith("~~~") ? part : part.replace(/\\\[([\s\S]*?)\\\]/gu, (_match: string, math: string) => `\n$$\n${math}\n$$\n`).replace(/\\\(([\s\S]*?)\\\)/gu, (_match: string, math: string) => `$${math}$`)).join("")

export const escapeCurrency = (text: string): string => text.replace(/\\[\s\S]|\$\$[\s\S]*?\$\$|\$(?=[^\s$])[^$\n]*?[^\s$\\]\$(?!\d)|\$(?=[^\s$])[^$\n]?\$(?!\d)|\$/gu,
  (match) => match === "$" ? "\\$" : match)

interface HtmlNode {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: Array<HtmlNode>
}

export const tableMath = () => (tree: HtmlNode): void => {
  const visit = (node: HtmlNode, inTable: boolean): void => {
    if (node.children === undefined || node.tagName === "code" || node.tagName === "pre") return
    const table = inTable || node.tagName === "table"
    node.children = node.children.flatMap((child): Array<HtmlNode> => {
      if (!table || child.type !== "text" || child.value === undefined) { visit(child, table); return [child] }
      const parts: Array<HtmlNode> = []
      let end = 0
      for (const match of child.value.matchAll(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/gu)) {
        const start = match.index
        if (start > end) parts.push({ type: "text", value: child.value.slice(end, start) })
        parts.push({ type: "element", tagName: "code", properties: { className: ["language-math", match[1] === undefined ? "math-inline" : "math-display"] }, children: [{ type: "text", value: match[1] ?? match[2] ?? "" }] })
        end = start + match[0].length
      }
      if (end < child.value.length) parts.push({ type: "text", value: child.value.slice(end) })
      return parts.length === 0 ? [child] : parts
    })
  }
  visit(tree, false)
}
