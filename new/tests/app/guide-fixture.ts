import { Schema } from "effect"
import { CanonicalDocument, ProcessingReport, ReadingGuide } from "../../src/domain/index.ts"
import { appReaderFixture } from "./reader-fixture.ts"

const start = { sourceBlockId: "block-1", quote: "Beginning" }
const end = { sourceBlockId: "block-2", quote: "and ending." }
export const appGuide = Schema.decodeUnknownSync(ReadingGuide)({
  title: "A guide to a joined paragraph",
  providerAttemptId: "app-guide-attempt",
  overview: { text: "This synthetic paragraph spans two pages.", sources: [start, end] },
  steps: [
    { title: "Start at the beginning", explanation: { text: "The first source piece opens the paragraph.", sources: [start] } },
    { title: "Follow the paragraph across pages", explanation: { text: "The two source pieces become one paragraph in the clean copy.", sources: [start, end] } },
    { title: "Reach the ending", explanation: { text: "The later page holds the end of the paragraph.", sources: [end] } },
  ],
  claims: [
    { claim: { text: "The paragraph has an opening.", sources: [start] }, support: { text: "The source explicitly begins with this word.", sources: [start], strength: "strong" }, limits: [{ text: "An opening alone does not show the complete paragraph.", sources: [end] }] },
    { claim: { text: "The ending follows the beginning.", sources: [end] }, support: { text: "The conjunction connects the later source piece.", sources: [end], strength: "partial" }, limits: [{ text: "The short sample does not establish wider document accuracy.", sources: [start] }] },
  ],
})
export const guidedCanonical = Schema.decodeUnknownSync(CanonicalDocument)({ ...appReaderFixture.canonical, guide: appGuide })
export const guidedReport = Schema.decodeUnknownSync(ProcessingReport)({ ...appReaderFixture.report, receipts: [{ delivery: "performed", receipt: {
  id: appGuide.providerAttemptId,
  ownerId: "reader-owner",
  scope: { documentId: guidedCanonical.scope.documentId, runId: guidedCanonical.scope.runId, sourceHash: guidedCanonical.sourceHash },
  stage: "guide",
  pageIds: ["page-1", "page-2"],
  figureId: null,
  requestFingerprint: "b".repeat(64),
  inputHashes: ["c".repeat(64)],
  pipelineVersion: "reader-fixture",
  schemaVersion: "1",
  configuration: { _tag: "model", provider: "meta", model: "muse-spark-1.3", reasoning: "high", promptName: "reading-guide", promptVersion: "amuseme-1", maxOutputTokens: 16384 },
  preparedAt: "2026-11-01T00:00:00.000Z",
  state: { _tag: "completed", finishedAt: "2026-11-01T00:00:01.000Z", providerRequestId: null, responseHash: "d".repeat(64), durationMilliseconds: 1000, usage: { _tag: "unavailable", reason: "Synthetic fixture" }, validation: { _tag: "accepted" } },
} }] })
