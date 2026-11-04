import { Result, Schema } from "effect"
import { CheckedPage, Extraction, type PageCheck, type SourceBlock } from "../../src/domain/index.ts"
import { applyPageChecks, previousPageContext } from "../../src/paper/correction/index.ts"
import { contractFixture } from "../fixtures/contracts.ts"

export const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])
export const stageLimits = { maxOutputTokens: 8192, maxRequestBytes: 8_000_000, imageTokenUpperBound: 100_000 }
export const stageExtraction = (rows: ReadonlyArray<readonly [SourceBlock["kind"], string, number]>): Extraction => {
  const { extraction } = contractFixture("cross-page")
  return Schema.decodeUnknownSync(Extraction)({ ...extraction, sourceBlocks: rows.map(([kind, content, pageNumber], readingOrder) => ({ id: `block-${readingOrder + 1}`, kind, content, format: kind === "table" ? "html" : "text", readingOrder, locations: [{ _tag: "page", pageId: `page-${pageNumber}`, pageNumber }] })) })
}
export const pageChecks = (extraction: Extraction, results: Readonly<Record<string, PageCheck>> = {}): ReadonlyArray<CheckedPage> => extraction.pages.map((page) => Schema.decodeUnknownSync(CheckedPage)({ scope: extraction.scope, pageId: page.id, previousContextIds: previousPageContext(extraction, page.id).map((block) => block.id), result: results[page.id] ?? { fixes: [], joins: [] }, providerAttemptId: `attempt-${page.id}` }))
export const correctedFixture = (extraction: Extraction = contractFixture("normal").extraction) => Result.getOrThrow(applyPageChecks(extraction, pageChecks(extraction)))
