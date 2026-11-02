import { Schema } from "effect"
import { CanonicalDocument, DocumentDetail, ReadingGuide } from "../../src/domain/index.ts"
import { appReaderFixture } from "./reader-fixture.ts"

const base = appReaderFixture.canonical
const page = (number: 1 | 2) => base.sourceBlocks[number - 1]!.locations
const block = (id: string, content: string, readingOrder: number, number: 1 | 2) => ({ id, kind: "paragraph", content, format: "text", readingOrder, locations: page(number) })
const cite = (sourceBlockId: string, quote: string) => ({ sourceBlockId, quote })
const opening = cite("block-1", "Beginning")
const ending = cite("block-2", "and ending.")
const method = cite("block-3", "A shared method.")
const simple = cite("block-3", "It is simple.")
const result = cite("block-4", "Results improve twofold.")

export const mapGuide = Schema.decodeUnknownSync(ReadingGuide)({
  title: "A synthetic map guide",
  providerAttemptId: "map-guide-attempt",
  overview: { text: "A short synthetic document.", sources: [opening, ending] },
  steps: [
    { title: "Open the document", explanation: { text: "It begins.", sources: [opening] } },
    { title: "Describe the method", explanation: { text: "The method is shared.", sources: [method, ending] } },
    { title: "Report the result", explanation: { text: "The result follows.", sources: [result] } },
  ],
  claims: [
    { claim: { text: "The method works.", sources: [method] }, support: { text: "The result improves.", strength: "strong", sources: [result, method] }, limits: [{ text: "Only one ending is shown.", sources: [ending] }] },
    { claim: { text: "The result doubles.", sources: [result] }, support: { text: "Stated once.", strength: "partial", sources: [result] }, limits: [{ text: "The method is simple.", sources: [simple] }, { text: "Only the opening frames it.", sources: [opening] }] },
  ],
})

export const mapCanonical = Schema.decodeUnknownSync(CanonicalDocument)({
  ...base,
  sourceBlocks: [...base.sourceBlocks, block("block-3", "A shared method. It is simple.", 2, 1), block("block-4", "Results improve twofold.", 3, 2)],
  guide: mapGuide,
})

const at = "2026-11-01T00:00:00.000Z"
const model = { provider: "fixture", model: "fixture", reasoning: "high", promptName: "fixture", promptVersion: "1", maxOutputTokens: 100 }
export const mapRecord = Schema.decodeUnknownSync(DocumentDetail)({
  document: {
    schemaVersion: "1", id: base.scope.documentId, ownerId: "reader-owner", originalFilename: "map-source.pdf",
    mediaType: "application/pdf", byteCount: 1024, sourceHash: base.sourceHash, pageCount: 2, sourceArtifact: "source.pdf",
    createdAt: at, expiresAt: "2026-11-08T00:00:00.000Z", lifecycle: { _tag: "active" },
  },
  latestRun: {
    id: base.scope.runId, documentId: base.scope.documentId, ownerId: "reader-owner", pipelineVersion: "test", schemaVersion: "1",
    configuration: { extractionProvider: "fixture", extractionVersion: "1", pageCheck: model, headings: model, figures: model, guide: model, maxProviderAttempts: 1, deadlineMilliseconds: 1000, spendingCapUsd: 0 },
    createdAt: at, mastraRunId: null, state: { _tag: "succeeded", startedAt: at, finishedAt: at, revisionId: base.scope.revisionId },
  },
  currentRevisionId: base.scope.revisionId,
})
