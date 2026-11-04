import { Schema } from "effect"
import { ArtifactManifest, CanonicalDocument, Document, Extraction, ImageManifest, ProcessingReport, Run, StageReceipt } from "../../src/domain/index.ts"
import sources from "./sources.json" with { type: "json" }

export const fixtureNames = Object.keys(sources) as Array<keyof typeof sources>
export const fixtureHash = "a".repeat(64)
export const fixtureTime = "2026-10-27T12:00:00.000Z"
export const fixtureModel = { provider: "fixture", model: "deterministic-fixture", reasoning: "high", promptName: "page-check", promptVersion: "1", maxOutputTokens: 1000 }

const rows = {
  normal: [["heading", "A synthetic document", 1], ["paragraph", "The result is 12 units.", 1]],
  scan: [["unclassified", "[Unclassified raster region]", 1]],
  empty: [],
  "ambiguous-math": [["equation", "The printed symbol is ambiguous: x1 or xl.", 1]],
  references: [["heading", "References", 1], ["reference", "[1] Example Author. A fictional source. 2026.", 1]],
  notes: [["paragraph", "Main text.", 1], ["note", "Note 1: Measurement uses invented data.", 1]],
  "cross-page": [["paragraph", "A paragraph starts on this", 1], ["paragraph", "page and finishes here.", 2]],
  table: [["table", "<table><tr><th>Name</th><th>Value</th></tr><tr><td>Alpha</td><td>12</td></tr><tr><td>Beta</td><td>9</td></tr></table>", 1]],
  "missing-description": [["figure", "", 1], ["caption", "Figure 1. A synthetic black square.", 1]],
} as const

export const contractFixture = (name: keyof typeof sources = "normal") => {
  const source = sources[name]
  const scope = { documentId: `document-${name}`, runId: `run-${name}`, sourceHash: source.sha256 }
  const outputScope = { documentId: scope.documentId, runId: scope.runId, revisionId: `revision-${name}` }
  const pages = Array.from({ length: source.pageCount }, (_, index) => ({
    id: `page-${index + 1}`, pageNumber: index + 1, width: 1224, height: 1584, dpi: 144,
    sourceWidth: 612, sourceHeight: 792, sourceUnit: "pdf-points", sourceOrigin: "top-left", clockwiseRotation: 0,
    sourceToRendered: { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 },
    image: { path: `pages/${index + 1}.png`, mediaType: "image/png", byteCount: 10, hash: fixtureHash },
  }))
  const sourceBlocks = rows[name].map(([kind, content, pageNumber], index) => ({
    id: `block-${index + 1}`, kind, readingOrder: index, content, format: kind === "table" ? "html" : "text",
    locations: [{ _tag: "page", pageId: `page-${pageNumber}`, pageNumber }],
  }))
  const figures = name === "missing-description" ? [{
    id: "figure-1", sourceBlockIds: ["block-1"], captionBlockIds: ["block-2"],
    locations: [{ _tag: "page", pageId: "page-1", pageNumber: 1 }],
    originalCaption: "Figure 1. A synthetic black square.",
    asset: { _tag: "available", artifact: { path: "images/figure-1.png", mediaType: "image/png", byteCount: 10, hash: fixtureHash } },
    description: { _tag: "unavailable", reason: "Fixture description failed" },
  }] : []
  const blocks = name === "cross-page" ? [{
    id: "block-1", kind: "paragraph", readingOrder: 0, format: "text", content: "A paragraph starts on this page and finishes here.",
    sourceBlockIds: ["block-1", "block-2"], headingLevel: null,
    locations: [{ _tag: "page", pageId: "page-1", pageNumber: 1 }, { _tag: "page", pageId: "page-2", pageNumber: 2 }],
  }] : sourceBlocks.map((block) => ({ ...block, sourceBlockIds: [block.id], headingLevel: block.kind === "heading" ? 1 : null }))
  const document = Schema.decodeUnknownSync(Document)({ schemaVersion: "1", id: scope.documentId, ownerId: "user-one", originalFilename: `${name}.pdf`, mediaType: "application/pdf", byteCount: source.byteCount, sourceHash: source.sha256, pageCount: source.pageCount, sourceArtifact: "source.pdf", createdAt: fixtureTime, expiresAt: "2026-11-03T12:00:00.000Z", lifecycle: { _tag: "active" } })
  const extraction = Schema.decodeUnknownSync(Extraction)({ schemaVersion: "1", scope, pages, sourceBlocks, figures })
  const canonical = Schema.decodeUnknownSync(CanonicalDocument)({ schemaVersion: "1", scope: outputScope, sourceHash: source.sha256, pages, sourceBlocks, blocks, figures, headingDecisions: sourceBlocks.filter((block) => block.kind === "heading").map((block) => ({ blockId: block.id, level: 1 })) })
  const receipts = pages.map((page) => Schema.decodeUnknownSync(StageReceipt)({
    id: `attempt-${page.id}`, ownerId: "user-one", scope, stage: "page-check", pageIds: [page.id], figureId: null, requestFingerprint: fixtureHash,
    inputHashes: [fixtureHash], pipelineVersion: "1", schemaVersion: "1", configuration: { _tag: "model", ...fixtureModel }, preparedAt: fixtureTime,
    state: { _tag: "completed", finishedAt: fixtureTime, providerRequestId: null, responseHash: fixtureHash, durationMilliseconds: 10, usage: { _tag: "unavailable", reason: "Fixture usage is not measured" }, validation: { _tag: "accepted" } },
  }))
  const issues = name === "missing-description" ? [{ code: "figure-description-unavailable", message: "Description is unavailable", stage: "figures", locations: [{ _tag: "page", pageId: "page-1", pageNumber: 1 }], blockIds: ["block-1"], figureId: "figure-1" }]
    : name === "scan" ? [{ code: "unclassified-content", message: "Raster region is preserved without recognized text", stage: "extraction", locations: [{ _tag: "page", pageId: "page-1", pageNumber: 1 }], blockIds: ["block-1"], figureId: null }] : []
  const report = Schema.decodeUnknownSync(ProcessingReport)({ schemaVersion: "1", scope: outputScope, changes: { changedBlockIds: [], appliedJoinCount: name === "cross-page" ? 1 : 0, changedHeadingCount: 0 }, ambiguity: { _tag: "unavailable", reason: "PageCheck does not inventory ambiguity" }, verifiedCorrectionCount: { _tag: "unavailable", reason: "Recorded edits are not verified corrections" }, issues, checks: [{ stage: "page-check", checkedPageIds: pages.map((page) => page.id), result: "passed" }], receipts: receipts.map((receipt) => ({ delivery: "performed", receipt })) })
  const run = Schema.decodeUnknownSync(Run)({ id: scope.runId, documentId: scope.documentId, ownerId: "user-one", pipelineVersion: "1", schemaVersion: "1", createdAt: fixtureTime, mastraRunId: "mastra-fixture", configuration: { extractionProvider: "fixture", extractionVersion: "1", pageCheck: fixtureModel, headings: fixtureModel, figures: fixtureModel, maxProviderAttempts: 1, deadlineMilliseconds: 60000, spendingCapUsd: 0 }, state: { _tag: issues.length > 0 ? "succeeded-with-issues" : "succeeded", startedAt: fixtureTime, finishedAt: fixtureTime, revisionId: outputScope.revisionId } })
  const manifest = Schema.decodeUnknownSync(ArtifactManifest)({ schemaVersion: "1", scope: outputScope, entries: [
    { path: "normalized.txt", mediaType: "text/plain; charset=utf-8", byteCount: 10, hash: fixtureHash },
    ...["document.json", "images.json", "processing-report.json"].map((path) => ({ path, mediaType: "application/json", byteCount: 10, hash: fixtureHash })),
    ...canonical.figures.flatMap((figure) => figure.asset._tag === "available" ? [figure.asset.artifact] : []),
  ] })
  const images = Schema.decodeUnknownSync(ImageManifest)({ schemaVersion: "1", scope: outputScope, figures })
  return { document, run, extraction, canonical, images, manifest, report }
}
