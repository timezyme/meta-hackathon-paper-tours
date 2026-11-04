import { Schema } from "effect"
import { BlockId, NonBlank, ProviderAttemptId } from "./identity.ts"

export const SourceQuote = Schema.Struct({ sourceBlockId: BlockId, quote: NonBlank.check(Schema.isMaxLength(800)) })
export type SourceQuote = typeof SourceQuote.Type
export const GuidePassage = Schema.Struct({
  text: NonBlank.check(Schema.isMaxLength(4000)),
  sources: Schema.NonEmptyArray(SourceQuote).check(Schema.isMaxLength(4)),
})
export type GuidePassage = typeof GuidePassage.Type
export const GuideContent = Schema.Struct({
  title: NonBlank.check(Schema.isMaxLength(200)),
  overview: GuidePassage,
  steps: Schema.NonEmptyArray(Schema.Struct({ title: NonBlank.check(Schema.isMaxLength(160)), explanation: GuidePassage })).check(Schema.isMaxLength(10)),
  claims: Schema.NonEmptyArray(Schema.Struct({
    claim: GuidePassage,
    support: Schema.Struct({ ...GuidePassage.fields, strength: Schema.Literals(["strong", "partial", "limited"]) }),
    limits: Schema.NonEmptyArray(GuidePassage).check(Schema.isMaxLength(3)),
  })).check(Schema.isMaxLength(6)),
})
export type GuideContent = typeof GuideContent.Type
export const ReadingGuide = Schema.Struct({ ...GuideContent.fields, providerAttemptId: ProviderAttemptId })
export type ReadingGuide = typeof ReadingGuide.Type

const guideSources = (guide: GuideContent): ReadonlyArray<SourceQuote> => [
  ...guide.overview.sources,
  ...guide.steps.flatMap((step) => step.explanation.sources),
  ...guide.claims.flatMap((item) => [...item.claim.sources, ...item.support.sources, ...item.limits.flatMap((limit) => limit.sources)]),
]

export const guideSourceProblems = (guide: GuideContent, blocks: ReadonlyArray<{ readonly id: BlockId; readonly content: string }>): ReadonlyArray<string> => {
  const source = new Map(blocks.map((block) => [block.id, block.content]))
  return guideSources(guide).flatMap(({ sourceBlockId, quote }) => {
    const content = source.get(sourceBlockId)
    if (content === undefined) return [`Quote "${quote}" cites block ${sourceBlockId}, which is not a source block`]
    const start = content.indexOf(quote)
    if (start === -1) return [`Quote "${quote}" is not an exact substring of block ${sourceBlockId}`]
    return content.indexOf(quote, start + 1) === -1 ? [] : [`Quote "${quote}" occurs more than once in block ${sourceBlockId}; quote a longer unique passage`]
  })
}
export const validGuideSources = (guide: GuideContent, blocks: ReadonlyArray<{ readonly id: BlockId; readonly content: string }>): boolean => guideSourceProblems(guide, blocks).length === 0
