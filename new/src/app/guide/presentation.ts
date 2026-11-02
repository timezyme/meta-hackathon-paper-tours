import type { CanonicalDocument, ReadingGuide, SourceBlock, SourceQuote } from "../../domain/index.ts"
import type { GuideRoute } from "./navigation.ts"

export const paperHeading = (canonical: CanonicalDocument): string | undefined => {
  const title = canonical.blocks.find((block) => block.kind === "heading" && block.headingLevel === 1 && block.locations[0].pageNumber === canonical.pages[0].pageNumber)
  return title?.content.replace(/^#{1,6}\s+/u, "").trim() || undefined
}

export const boundedGuideStep = (route: GuideRoute, guide: ReadingGuide): number => Math.min(route.n, route.mode === "claims" ? guide.claims.length : guide.steps.length)

export const visibleGuideSources = (guide: ReadingGuide, route: GuideRoute): ReadonlyArray<SourceQuote> => {
  const index = boundedGuideStep(route, guide) - 1
  if (route.mode === "walk") return guide.steps[index]?.explanation.sources ?? []
  if (route.mode === "claims") {
    const item = guide.claims[index]
    return item === undefined ? [] : [...item.claim.sources, ...item.support.sources, ...item.limits.flatMap((limit) => limit.sources)]
  }
  return route.mode === "overview" ? guide.overview.sources : []
}

export const sourceForQuote = (canonical: CanonicalDocument, source: SourceQuote): SourceBlock | undefined => canonical.sourceBlocks.find((block) => block.id === source.sourceBlockId)
export const sourcePages = (block: SourceBlock): ReadonlyArray<number> => [...new Set(block.locations.map((location) => location.pageNumber))]
export const evidencePage = (canonical: CanonicalDocument, source: SourceQuote, requested: number): number => {
  const block = sourceForQuote(canonical, source)
  if (block === undefined) return canonical.pages[0].pageNumber
  const pages = sourcePages(block)
  return pages.includes(requested) ? requested : block.locations[0].pageNumber
}
export const quotedParts = (content: string, quote: string): { readonly before: string; readonly quote: string; readonly after: string } | null => {
  const start = content.indexOf(quote)
  if (quote.length === 0 || start === -1 || content.indexOf(quote, start + 1) !== -1) return null
  return { before: content.slice(0, start), quote, after: content.slice(start + quote.length) }
}
