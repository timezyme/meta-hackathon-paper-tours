import { Result, Schema } from "effect"
import { Block, CanonicalDocument, checkedExtraction, checkedFurniture, Count, cropReviewEvidence, Document, Extraction, Figure, FigureCropReview, HeadingDecision, ImageManifest, Issue, museFallback, MuseReview, OutputRevisionId, ProcessingReport, ReceiptUse, Run, validateCanonicalDocument } from "../../domain/index.ts"
import { executionFailure, type ExecutionFailure } from "../../processing/index.ts"
import { CorrectedText } from "../correction/index.ts"
import { applyHeadingDecisions } from "../headings/index.ts"

const HeadingResolution = Schema.Struct({ blocks: Schema.Array(Block), headingDecisions: Schema.Array(HeadingDecision), appliedJoinCount: Count, changedHeadingCount: Count })
const AssemblyInput = Schema.Struct({ document: Document, run: Run, revisionId: OutputRevisionId, extraction: Extraction, corrected: CorrectedText, headings: HeadingResolution, figures: Schema.Array(Figure), issues: Schema.Array(Issue), receiptUses: Schema.Array(ReceiptUse), museReviews: Schema.optionalKey(Schema.Array(MuseReview)), figureCrops: Schema.optionalKey(Schema.Array(FigureCropReview)) })
export type AssembleDocumentInput = typeof AssemblyInput.Type
export const AssembledDocument = Schema.Struct({ extraction: Extraction, canonical: CanonicalDocument, images: ImageManifest, report: ProcessingReport })
export type AssembledDocument = typeof AssembledDocument.Type
const sameHeadings = Schema.toEquivalence(HeadingResolution)
const sameReceipt = Schema.toEquivalence(ReceiptUse.fields.receipt)
const sameIssue = Schema.toEquivalence(Issue)
const failed = (message: string) => executionFailure("invalid-provider-response", message)

export const assembleDocument = (raw: AssembleDocumentInput): Result.Result<AssembledDocument, ExecutionFailure> => {
  const decoded = Schema.decodeUnknownResult(AssemblyInput)(raw, { onExcessProperty: "error" })
  if (Result.isFailure(decoded)) return Result.fail(failed("Assembly input does not match its contract"))
  const { document, run, revisionId, corrected, headings } = decoded.success
  const original = decoded.success.extraction
  if (document.lifecycle._tag !== "active" || run.state._tag !== "running" || run.ownerId !== document.ownerId || run.documentId !== document.id || original.scope.runId !== run.id) return Result.fail(failed("Assembly requires the active matching document and run"))
  const expected = applyHeadingDecisions(original, corrected, { headings: headings.headingDecisions })
  if (Result.isFailure(expected)) return Result.fail(expected.failure)
  if (!sameHeadings(expected.success, headings)) return Result.fail(failed("Resolved blocks and counts differ from their checked heading and join decisions"))
  const scope = { documentId: document.id, runId: run.id, revisionId }
  const extraction = checkedExtraction(original, corrected.checkedPages)
  const pageCheckFurniture = checkedFurniture(original, corrected.checkedPages)
  const figures = decoded.success.figures.map((figure): Figure => figure.description._tag === "pending" ? { ...figure, description: { _tag: "unavailable", reason: "No figure description was generated" } } : figure)
  const canonical: CanonicalDocument = { schemaVersion: "1", scope, sourceHash: document.sourceHash, pages: extraction.pages, sourceBlocks: extraction.sourceBlocks, ...(extraction.pageFurniture === undefined ? {} : { pageFurniture: extraction.pageFurniture }), blocks: headings.blocks, headingDecisions: headings.headingDecisions, figures }
  if (validateCanonicalDocument(document, extraction, canonical).length > 0) return Result.fail(failed("Assembly must retain every original page, source block, figure, and location"))
  const issues: Array<Issue> = []
  for (const issue of decoded.success.issues) if (!issues.some((existing) => sameIssue(existing, issue))) issues.push(issue)
  for (const figure of figures) {
    for (const kind of ["asset", "description"] as const) {
      const state = figure[kind]
      const code = kind === "asset" ? "figure-asset-unavailable" : "figure-description-unavailable"
      if (state._tag === "unavailable" && !issues.some((issue) => issue.code === code && issue.figureId === figure.id)) issues.push({ code, message: state.reason, stage: kind === "asset" ? "extraction" : "figures", locations: figure.locations, blockIds: figure.sourceBlockIds, figureId: figure.id })
    }
  }
  for (const block of extraction.sourceBlocks) if (block.kind === "unclassified" && !extraction.pageFurniture?.some((item) => item.blockId === block.id) && !issues.some((issue) => issue.code === "unclassified-content" && issue.blockIds.includes(block.id))) issues.push({ code: "unclassified-content", message: "Unclassified source content is retained without a semantic interpretation", stage: "extraction", locations: block.locations, blockIds: [block.id], figureId: null })
  if (issues.some((issue) => issue.locations.some((location) => {
    const page = extraction.pages.find((item) => item.id === location.pageId)
    return page === undefined || page.pageNumber !== location.pageNumber || location._tag === "box" && (location.box.x + location.box.width > page.width || location.box.y + location.box.height > page.height)
  }) || issue.blockIds.some((id) => !extraction.sourceBlocks.some((block) => block.id === id)) || issue.figureId !== null && !figures.some((figure) => figure.id === issue.figureId))) return Result.fail(failed("Issues must identify retained source locations and content"))
  const receipts: Array<ReceiptUse> = []
  for (const { receipt } of decoded.success.receiptUses) {
    const previous = receipts.find((use) => use.receipt.id === receipt.id)
    if (previous !== undefined) {
      if (!sameReceipt(previous.receipt, receipt)) return Result.fail(failed("Conflicting versions of one provider receipt cannot be published"))
      continue
    }
    const delivery = receipt.scope.runId === run.id ? "performed" : "reused"
    if (receipt.ownerId !== document.ownerId || receipt.scope.documentId !== document.id || receipt.scope.sourceHash !== document.sourceHash || receipt.pipelineVersion !== run.pipelineVersion || receipt.schemaVersion !== run.schemaVersion || (receipt.stage === "extraction") !== (receipt.configuration._tag === "extraction") || receipt.pageIds.some((id) => !extraction.pages.some((page) => page.id === id)) || receipt.figureId !== null && !figures.some((figure) => figure.id === receipt.figureId)) return Result.fail(failed("Provider receipt scope does not match this output"))
    if (receipt.state._tag === "prepared" || receipt.state._tag === "submitted" || receipt.state._tag === "unknown-completion" || delivery === "reused" && (receipt.state._tag !== "completed" || receipt.state.validation._tag !== "accepted") && !cropReviewEvidence(receipt, decoded.success.figureCrops)) return Result.fail(failed("Unresolved provider work or unsuccessful reuse cannot be published"))
    receipts.push({ delivery, receipt })
  }
  const { museReviews, figureCrops } = decoded.success
  const reviewedFallback = (page: CorrectedText["checkedPages"][number]) => museFallback(museReviews, "page-check", page.pageId)
    && (museReviews ?? []).some((review) => review.stage === "page-check" && review.attemptIds.includes(page.providerAttemptId))
  for (const page of corrected.checkedPages) if (!reviewedFallback(page) && !receipts.some(({ receipt }) => receipt.id === page.providerAttemptId && receipt.stage === "page-check" && receipt.pageIds.includes(page.pageId) && receipt.state._tag === "completed" && receipt.state.validation._tag === "accepted")) return Result.fail(failed("Every page check requires its actual accepted receipt"))
  for (const figure of figures) {
    const description = figure.description
    if (description._tag === "generated" && !receipts.some(({ receipt }) => receipt.id === description.providerAttemptId && receipt.stage === "figures" && receipt.task === undefined && receipt.figureId === figure.id && receipt.state._tag === "completed" && receipt.state.validation._tag === "accepted")) return Result.fail(failed("Generated figure descriptions require their actual accepted receipt"))
  }
  const allPages = extraction.pages.map((page) => page.id)
  const figurePages = extraction.pages.filter((page) => figures.some((figure) => figure.locations.some((location) => location.pageId === page.id))).map((page) => page.id)
  const report: ProcessingReport = {
    schemaVersion: "1", scope,
    changes: { changedBlockIds: corrected.changedBlockIds, appliedJoinCount: headings.appliedJoinCount, changedHeadingCount: headings.changedHeadingCount },
    ambiguity: { _tag: "unavailable", reason: "Page checking does not inventory every ambiguity" },
    verifiedCorrectionCount: { _tag: "unavailable", reason: "Recorded edits have not been independently verified as corrections" },
    issues, receipts, ...(museReviews === undefined || museReviews.length === 0 ? {} : { museReviews }),
    ...(figureCrops === undefined || figureCrops.length === 0 ? {} : { figureCrops }),
    ...(pageCheckFurniture.length === 0 ? {} : { pageCheckFurniture }),
    checks: (["extraction", "page-check", "headings", "figures", "assembly"] as const).map((stage) => ({ stage, checkedPageIds: stage === "figures" ? figurePages : allPages, result: issues.some((issue) => issue.stage === stage) ? "issues" : "passed" })),
  }
  return Result.succeed({ extraction, canonical, images: { schemaVersion: "1", scope, figures }, report })
}
