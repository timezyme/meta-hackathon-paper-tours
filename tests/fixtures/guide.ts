import { Schema } from "effect"
import { CanonicalDocument, ProcessingReport, ReadingGuide } from "../../src/domain/index.ts"
import { readerCanonical, readerReport } from "./reader.ts"

// Synthetic UI content only. This is never imported into the application.
export const readerGuide = Schema.decodeUnknownSync(ReadingGuide)({
  title: "Reading equations, evidence, and edge cases",
  providerAttemptId: "guide-fixture-attempt",
  overview: {
    text: "This short sample checks whether a reader preserves mathematical text, source evidence, and complete downloads. Its examples are synthetic, not research findings.",
    sources: [{ sourceBlockId: "block-2", quote: "UI verification fixture · Synthetic content, not a processed research paper." }],
  },
  steps: [
    { title: "Start with what this document is", explanation: { text: "The document identifies itself as a UI test. Treat its examples as checks of the reading experience, rather than measured scientific results.", sources: [{ sourceBlockId: "block-2", quote: "UI verification fixture · Synthetic content, not a processed research paper." }] } },
    { title: "Follow a thought across two pages", explanation: { text: "A paragraph starts on the first page and continues on the second. Its original pieces remain available even when the clean copy joins them.", sources: [{ sourceBlockId: "block-8", quote: "A paragraph begins on page one" }, { sourceBlockId: "block-9", quote: "and ends on page two." }] } },
    { title: "Keep the final paragraph in the download", explanation: { text: "The final page states that copying the entire document includes its last paragraph. The complete text download should preserve it too.", sources: [{ sourceBlockId: "block-17", quote: "The complete final paragraph is included when you copy the entire normalized document." }] } },
  ],
  claims: [
    {
      claim: { text: "A missing measurement should stay unavailable.", sources: [{ sourceBlockId: "block-12", quote: "Missing values are unavailable, not zero." }] },
      support: { text: "The note states this rule directly.", strength: "strong", sources: [{ sourceBlockId: "block-12", quote: "Note 1: Missing values are unavailable, not zero." }] },
      limits: [{ text: "This is a rule in a synthetic sample, not an empirical result.", sources: [{ sourceBlockId: "block-2", quote: "Synthetic content, not a processed research paper." }] }],
    },
    {
      claim: { text: "The copy action should include the end of the document.", sources: [{ sourceBlockId: "block-17", quote: "The complete final paragraph is included when you copy the entire normalized document." }] },
      support: { text: "The final paragraph states the intended behavior; a saved file still needs to be checked.", strength: "partial", sources: [{ sourceBlockId: "block-17", quote: "The complete final paragraph is included when you copy the entire normalized document." }] },
      limits: [{ text: "The statement does not establish broad accuracy on research papers.", sources: [{ sourceBlockId: "block-2", quote: "Synthetic content, not a processed research paper." }] }],
    },
  ],
})

export const guidedCanonical = Schema.decodeUnknownSync(CanonicalDocument)({ ...readerCanonical, guide: readerGuide })
export const guidedReport = Schema.decodeUnknownSync(ProcessingReport)({
  ...readerReport,
  receipts: [...readerReport.receipts, {
    delivery: "performed",
    receipt: {
      ...readerReport.receipts[0]!.receipt,
      id: readerGuide.providerAttemptId,
      scope: { documentId: guidedCanonical.scope.documentId, runId: guidedCanonical.scope.runId, sourceHash: guidedCanonical.sourceHash },
      stage: "guide",
      pageIds: guidedCanonical.pages.map((page) => page.id),
      figureId: null,
      configuration: { _tag: "model", provider: "meta", model: "muse-spark-1.3", reasoning: "high", promptName: "reading-guide", promptVersion: "amuseme-1", maxOutputTokens: 16384 },
    },
  }],
  checks: [...readerReport.checks, { stage: "guide", checkedPageIds: guidedCanonical.pages.map((page) => page.id), result: "passed" }],
})
