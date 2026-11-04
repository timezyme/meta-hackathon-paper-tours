import { Schema } from "effect"
import { CanonicalDocument, ProcessingReport } from "../../src/domain/index.ts"

const scope = { documentId: "reader-fixture", runId: "reader-run", revisionId: "reader-revision" }
const locations = [{ _tag: "page", pageId: "page-1", pageNumber: 1 }, { _tag: "page", pageId: "page-2", pageNumber: 2 }]
const sourceBlocks = locations.map((location, index) => ({ id: `block-${index + 1}`, kind: "paragraph", content: index === 0 ? "Beginning" : "and ending.", format: "text", readingOrder: index, locations: [location] }))
export const appReaderFixture = {
  canonical: Schema.decodeUnknownSync(CanonicalDocument)({ schemaVersion: "1", scope, sourceHash: "a".repeat(64), figures: [], headingDecisions: [], sourceBlocks, pages: locations.map((location) => ({ id: location.pageId, pageNumber: location.pageNumber, width: 612, height: 792, dpi: 72, sourceWidth: 612, sourceHeight: 792, sourceUnit: "pdf-points", sourceOrigin: "top-left", clockwiseRotation: 0, sourceToRendered: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, image: { path: `pages/${location.pageNumber}.png`, mediaType: "image/png", byteCount: 10, hash: "a".repeat(64) } })), blocks: [{ ...sourceBlocks[0], content: "Beginning and ending.", locations, sourceBlockIds: ["block-1", "block-2"], headingLevel: null }] }),
  report: Schema.decodeUnknownSync(ProcessingReport)({ schemaVersion: "1", scope, changes: { changedBlockIds: [], appliedJoinCount: 1, changedHeadingCount: 0 }, ambiguity: { _tag: "unavailable", reason: "Not measured" }, verifiedCorrectionCount: { _tag: "unavailable", reason: "Not measured" }, issues: [], checks: [{ stage: "page-check", checkedPageIds: ["page-1", "page-2"], result: "passed" }], receipts: [] }),
}
