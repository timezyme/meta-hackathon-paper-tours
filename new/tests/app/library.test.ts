import { Schema } from "effect"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { DocumentDetail } from "../../src/domain/index.ts"
import type { DocumentRecord } from "../../src/app/documents.ts"
import { FeaturedPaperContent, PaperLibrary } from "../../src/app/library/PaperLibrary.tsx"
import { featuredPaper, paperPreview, uploadUnavailableMessage } from "../../src/app/library/presentation.ts"
import { guidedCanonical, readerGuide } from "./guide-fixture.ts"
import { appReaderFixture } from "./reader-fixture.ts"

const { scope, sourceHash } = guidedCanonical
const at = "2026-11-01T00:00:00.000Z"
const model = { provider: "fixture", model: "fixture", reasoning: "high", promptName: "fixture", promptVersion: "1", maxOutputTokens: 100 }
const configuration = {
  extractionProvider: "fixture", extractionVersion: "1", pageCheck: model, headings: model, figures: model,
  maxProviderAttempts: 1, deadlineMilliseconds: 1000, spendingCapUsd: 0,
}
const record = Schema.decodeUnknownSync(DocumentDetail)({
  document: {
    schemaVersion: "1", id: scope.documentId, ownerId: "reader-owner", originalFilename: "source-file.pdf",
    mediaType: "application/pdf", byteCount: 1024, sourceHash, pageCount: 2, sourceArtifact: "source.pdf",
    createdAt: at, expiresAt: "2026-11-08T00:00:00.000Z", lifecycle: { _tag: "active" },
  },
  latestRun: {
    id: scope.runId, documentId: scope.documentId, ownerId: "reader-owner", pipelineVersion: "test", schemaVersion: "1",
    configuration: { ...configuration, guide: model }, createdAt: at, mastraRunId: null,
    state: { _tag: "succeeded", startedAt: at, finishedAt: at, revisionId: scope.revisionId },
  },
  currentRevisionId: scope.revisionId,
})
const pending: DocumentRecord = { ...record, currentRevisionId: null, latestRun: { ...record.latestRun, state: { _tag: "queued" } } }
const ignore = () => {}
const controls = { retryEnabled: false, onDeleted: ignore, onRefresh: ignore, onUnauthenticated: ignore }
const feature = (content: ReturnType<typeof paperPreview> | null, error: string | null = null) =>
  renderToStaticMarkup(createElement(FeaturedPaperContent, { record, content, error, controls }))
const excerpt = (text: string) => paperPreview({
  ...guidedCanonical, guide: { ...readerGuide, overview: { ...readerGuide.overview, text } },
}).guide?.excerpt

describe("signed-in paper library", () => {
  it("features the current published guide ahead of a queued upload or a historical publication", () => {
    const historical = Schema.decodeUnknownSync(DocumentDetail)({ ...record, latestRun: { ...record.latestRun, configuration } })
    const changedRevision = Schema.decodeUnknownSync(DocumentDetail)({ ...record, currentRevisionId: "older-revision" })
    expect(featuredPaper([pending, changedRevision, historical, record])).toBe(record)
    expect(featuredPaper([pending, historical])).toBe(historical)
    expect(featuredPaper([pending])).toBeUndefined()
  })

  it("opens the validated guide at goal selection and preserves direct reading, original page and download links", () => {
    const page = feature(paperPreview(guidedCanonical))
    expect(page).toContain(readerGuide.title)
    expect(page).toContain(readerGuide.overview.text)
    expect(page).toContain("3 steps")
    expect(page).toContain("2 claims")
    expect(page).toContain(`href="/documents/${scope.documentId}?mode=choices&amp;goal=walk">Open reading guide`)
    expect(page).toContain(`href="/documents/${scope.documentId}?mode=read">Read full paper`)
    expect(page).toContain(`src="/api/documents/${scope.documentId}/preview?page=1"`)
    expect(page).toContain(`href="/documents/${scope.documentId}?mode=read&amp;view=original&amp;p=1"`)
    expect(page).toContain(`href="/api/documents/${scope.documentId}/outputs/${scope.revisionId}/text"`)
    expect(page).toContain(`href="/api/documents/${scope.documentId}/original"`)
    expect(page).toContain("Delete document")
  })

  it("keeps the original and reader accessible without advertising an absent or unreadable guide", () => {
    const legacy = feature(paperPreview(appReaderFixture.canonical))
    expect(legacy).toContain("This paper has no saved guide.")
    expect(legacy).toContain("source-file")
    const unreadable = feature(null, "The saved output could not be read.")
    expect(unreadable).toContain("The saved output could not be read.")
    for (const page of [legacy, unreadable]) {
      expect(page).not.toContain("Open reading guide")
      expect(page).toContain(`href="/documents/${scope.documentId}?mode=read">Open paper`)
      expect(page).toContain("Download original PDF")
    }
  })

  it("shows pending uploads with real progress access before a publication exists", () => {
    const page = renderToStaticMarkup(createElement(PaperLibrary, { records: [pending], controls }))
    expect(page).toContain("Queued")
    expect(page).toContain("View progress")
    expect(page).toContain("Available when processing has stopped.")
    expect(page).not.toContain("Open reading guide")
    expect(page).not.toContain("Download text")
  })

  it("takes an extract from the saved overview, ending at a sentence or a clean word boundary", () => {
    const explanation = "The result spans two source pages."
    const detail = "Their text was joined."
    const longSentence = "This sample ".repeat(21).trim() + "."
    expect(excerpt(`${explanation} ${detail} One more detail.`)).toBe(`${explanation} ${detail}`)
    expect(excerpt(`${explanation} ${longSentence}`)).toBe(explanation)
    expect(excerpt(longSentence)).toBe(`${"This sample ".repeat(20).trim()}…`)
  })

  it("simplifies only the known configuration message and preserves actionable server explanations", () => {
    const known = "Document processing is not configured. Uploads will open when the processing pipeline, provider access, and budget are ready."
    expect(uploadUnavailableMessage(known, true)).toContain("read and download")
    expect(uploadUnavailableMessage(known, false)).toContain("isn’t accepting new PDFs")
    const capacity = "All processing slots are in use. Try again in five minutes."
    expect(uploadUnavailableMessage(capacity, true)).toBe(capacity)
  })
})
