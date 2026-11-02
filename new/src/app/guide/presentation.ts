import type { CanonicalDocument, ReadingGuide, SourceBlock, SourceQuote } from "../../domain/index.ts"
import { headingText } from "../text.ts"
import type { GuideRoute } from "./navigation.ts"

export const paperHeading = (canonical: CanonicalDocument): string | undefined => {
  const firstPage = canonical.pages[0].pageNumber
  const title = canonical.blocks.find((block) => block.kind === "heading" && block.headingLevel === 1 && block.locations[0].pageNumber === firstPage)
  return title === undefined ? undefined : headingText(title.content) || undefined
}

export const boundedGuideStep = (route: GuideRoute, guide: ReadingGuide): number =>
  Math.min(route.n, route.mode === "claims" ? guide.claims.length : guide.steps.length)

const finished = { walk: "done-walk", claims: "done-claims" } as const

export const turnRoute = (route: GuideRoute, n: number, total: number): GuideRoute => {
  const path = route.mode === "claims" ? "claims" : "walk"
  const mode = n < 1 ? "choices" : n > total ? finished[path] : path
  return { mode, goal: path, n, source: null, node: null, view: "text" }
}

export const visibleGuideSources = (guide: ReadingGuide, route: GuideRoute): ReadonlyArray<SourceQuote> => {
  const index = boundedGuideStep(route, guide) - 1
  if (route.mode === "walk") return guide.steps[index]?.explanation.sources ?? []
  if (route.mode === "claims") {
    const item = guide.claims[index]
    if (item === undefined) return []
    return [...item.claim.sources, ...item.support.sources, ...item.limits.flatMap((limit) => limit.sources)]
  }
  return route.mode === "overview" ? guide.overview.sources : []
}

export const sourceForQuote = (canonical: CanonicalDocument, source: SourceQuote): SourceBlock | undefined =>
  canonical.sourceBlocks.find((block) => block.id === source.sourceBlockId)
export const sourcePages = (block: SourceBlock): ReadonlyArray<number> =>
  [...new Set(block.locations.map((location) => location.pageNumber))]
export const evidencePage = (canonical: CanonicalDocument, source: SourceQuote, requested: number): number => {
  const block = sourceForQuote(canonical, source)
  if (block === undefined) return canonical.pages[0].pageNumber
  const pages = sourcePages(block)
  return pages.includes(requested) ? requested : block.locations[0].pageNumber
}
type QuotedParts = { readonly before: string; readonly quote: string; readonly after: string }
export const quotedParts = (content: string, quote: string): QuotedParts | null => {
  const start = content.indexOf(quote)
  if (quote.length === 0 || start === -1 || content.indexOf(quote, start + 1) !== -1) return null
  return { before: content.slice(0, start), quote, after: content.slice(start + quote.length) }
}
const entities: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", nbsp: " " }
const tableText = (quote: string): string => /<\/?t[rdh](?:\s[^>]*)?>/iu.test(quote)
  ? quote.replace(/<\/t[dh]>\s*(?=<t[dh][\s>])/giu, " · ").replace(/<\/tr>\s*/giu, " / ").replace(/<[^>]*>/gu, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/gu, (_, name: string) => entities[name] ?? "").replace(/\s+/gu, " ").replace(/(?:\s*[/·]\s*)+$/u, "").trim()
  : quote
export const displayQuote = (quote: string): string => {
  const stripped = tableText(quote).replace(/^\s*(?:[-*•]|\d{1,3}[.)])\s+/u, "")
  return stripped.length === 0 ? quote : stripped
}
