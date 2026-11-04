import { Effect, Fiber, Result, Schema } from "effect"
import {
  FigureCropReview,
  Issue,
  MuseReview,
  StageReceipt,
  validateExtraction,
  Extraction,
  type ImageArtifact,
  type PixelBox,
} from "../../domain/index.ts"
import { invalidStage } from "../../paper/correction/index.ts"
import {
  buildPageExtractionRequest,
  convertPageExtraction,
  cropBox,
  pageExtractionProblems,
  pageExtractionPromptVersion,
} from "../../paper/extraction/page.ts"
import { buildExtractionRequest, convertSparkExtraction, extractionPage } from "../../paper/extraction/index.ts"
import { figureNeighbours } from "../../paper/figures/index.ts"
import { PdfRenderError } from "../../paper/pdf/index.ts"
import { decodeMetaOutput } from "../../paper/providers/meta/index.ts"
import { type DispatchClaim } from "../../storage/index.ts"
import { type Checkpoint } from ".././checkpoints.ts"
import { affordablePageLimit, minimumReservationMicrousd } from ".././policy.ts"
import { ProviderAdapter, executionFailure } from ".././contracts.ts"
import {
  imageTokenUpperBound,
  figureImageAllowanceBytes,
  missingGuideReservation,
  reviewedFigureBoxes,
  rejectionMessage,
} from ".././pipeline-shared.ts"
import { type StageContext } from ".././stage-context.ts"
import { type makeMuseReview } from ".././muse-review.ts"
import { type makeFigureCrops } from ".././figure-crops.ts"

export const makeExtract = (
  context: StageContext,
  { reviewedMetaCall }: ReturnType<typeof makeMuseReview>,
  { renderPages, cropFigure, reviewFigureCrop }: ReturnType<typeof makeFigureCrops>,
) => {
  const { options, guard, save, readPrivate, progress, measure, headroom, prepareMetaCall, guardedMetaCall, settleInOrder } = context
  const extract = Effect.fnUntraced(function* (claim: DispatchClaim, input: Checkpoint) {
    const stage = "extraction"
    const { configuration } = claim.run
    const mandatoryReservation = minimumReservationMicrousd(options.policy, configuration, claim.document.pageCount)
    if (mandatoryReservation === undefined) return yield* missingGuideReservation()
    if (claim.document.pageCount > affordablePageLimit(options.policy, configuration)) {
      return yield* executionFailure("limit-exceeded", "This document exceeds its reserved processing allowance before figure descriptions")
    }
    yield* progress(claim, stage, 0, claim.document.pageCount)
    const rendered = yield* renderPages(claim)
    const model = claim.run.configuration.extractionModel
    if (model === undefined) return yield* executionFailure("processing-unavailable", "The Meta extraction model is not configured")
    const extractionLimits = {
      maxOutputTokens: model.maxOutputTokens,
      maxRequestBytes: options.policy.maxRequestBytes,
      imageTokenUpperBound,
    }
    const receipts: Array<StageReceipt> = []
    const reviews: Array<MuseReview> = []
    const cropReviews: Array<FigureCropReview> = []
    const cropReceipts: Array<StageReceipt> = []
    const pages: Array<Extraction> = []
    const issues: Array<Issue> = []
    let totalFigureBytes = 0
    const legacy = model.promptVersion === "1"
    if (legacy && (rendered.length !== 1 || rendered[0]?.physicalRotation !== 0)) {
      return yield* new PdfRenderError({ code: "unsupported-pdf", message: "The historical extraction trial requires one unrotated page" })
    }
    if (!legacy && model.promptVersion !== pageExtractionPromptVersion) {
      return yield* executionFailure("processing-unavailable", "The extraction prompt version is not supported")
    }
    const startPage = Effect.fnUntraced(function* (index: number) {
      const prepared = yield* Effect.gen(function* () {
        const page = extractionPage(rendered[index]!)
        const image = yield* readPrivate(claim, page.image)
        const request = yield* Effect.fromResult(buildPageExtractionRequest(page, claim.document.pageCount, image, extractionLimits))
        const call = yield* prepareMetaCall(
          claim,
          {
            stage,
            request,
            limits: extractionLimits,
            pageIds: [page.id],
            figureId: null,
            inputHashes: [page.image.hash],
            headroomMicrousd: headroom(claim, claim.document.pageCount - index - 1, claim.document.pageCount, true),
            validate: (value) =>
              Result.mapError(pageExtractionProblems(page, value), (problems) => invalidStage(rejectionMessage(problems))),
          },
          yield* measure(request),
        )
        return { ...call, saved: yield* guard.prepare(claim, call.attempt).pipe(Effect.result) }
      }).pipe(Effect.result)
      const work = Result.isFailure(prepared)
        ? Effect.fail(prepared.failure)
        : Effect.gen(function* () {
            const { attempt, adapter, saved } = prepared.success
            const result = Result.isFailure(saved)
              ? Result.fail(saved.failure)
              : yield* (saved.success._tag === "prepared" ? guard.dispatch(saved.success.ticket) : guard.execute(claim, attempt)).pipe(
                  Effect.provideService(ProviderAdapter, adapter),
                  Effect.result,
                )
            return { attempt, result }
          })
      return yield* work.pipe(Effect.result, Effect.forkChild)
    })
    const pending: Array<Effect.Success<ReturnType<typeof startPage>>> = []
    let nextPage = 0
    if (!legacy) {
      while (nextPage < Math.min(rendered.length, options.policy.maxConcurrentCalls)) pending.push(yield* startPage(nextPage++))
    }
    yield* Effect.forEach(
      rendered,
      (renderedPage) =>
        Effect.gen(function* () {
          const page = extractionPage(renderedPage)
          const imageBytes = yield* readPrivate(claim, page.image)
          const request = yield* Effect.fromResult(
            legacy
              ? buildExtractionRequest(page, imageBytes, extractionLimits)
              : buildPageExtractionRequest(page, claim.document.pageCount, imageBytes, extractionLimits),
          )
          if (legacy) {
            const response = yield* guardedMetaCall(claim, {
              stage,
              request,
              limits: extractionLimits,
              pageIds: [page.id],
              figureId: null,
              inputHashes: [page.image.hash],
              validate: (value) => convertSparkExtraction(claim.document, claim.run.id, page, value),
            })
            const conversion = yield* Effect.fromResult(
              convertSparkExtraction(claim.document, claim.run.id, page, yield* decodeMetaOutput(response.response)),
            )
            pages.push(conversion.extraction)
            issues.push(...conversion.issues)
            receipts.push(response.receipt)
          } else {
            const started = pending.shift()
            const first = started === undefined ? undefined : Effect.fromResult(yield* Fiber.join(started))
            const response = yield* reviewedMetaCall(
              claim,
              {
                stage,
                request,
                limits: extractionLimits,
                pageIds: [page.id],
                figureId: null,
                inputHashes: [page.image.hash],
                headroomMicrousd: headroom(claim, claim.document.pageCount - receipts.length - 1, claim.document.pageCount, true),
                check: (value) => pageExtractionProblems(page, value),
                fallback: () => null,
              },
              first,
            )
            if (response._tag !== "accepted") return yield* executionFailure("invalid-provider-response", response.reason)
            if (response.review !== null) reviews.push(response.review)
            receipts.push(response.receipt)
            const extractedPage = response.value
            const images = new Map<number, ImageArtifact>()
            const boxes = new Map<number, PixelBox>()
            const pageCrops: Array<FigureCropReview> = []
            const cropHeadroom = headroom(claim, claim.document.pageCount - receipts.length, claim.document.pageCount, true)
            const reviewedFigures = yield* settleInOrder(extractedPage.figures, (proposal) =>
              Effect.gen(function* () {
                if (proposal.box === null) return null
                const initial = yield* cropFigure(claim, page, imageBytes, proposal, cropBox(proposal.box))
                if (initial === null) return null
                const neighbours = figureNeighbours(extractedPage.figures, proposal.blockIndex)
                return {
                  blockIndex: proposal.blockIndex,
                  ...(yield* reviewFigureCrop(claim, page, imageBytes, extractedPage, proposal, initial, neighbours, cropHeadroom)),
                }
              }),
            )
            for (const reviewed of reviewedFigures) {
              if (reviewed === null) continue
              totalFigureBytes += reviewed.crop.asset.byteCount
              if (totalFigureBytes > figureImageAllowanceBytes) {
                return yield* executionFailure("limit-exceeded", "Figure images exceed the document image allowance")
              }
              images.set(reviewed.blockIndex, reviewed.crop.asset)
              boxes.set(reviewed.blockIndex, reviewed.crop.box)
              pageCrops.push(reviewed.review)
              cropReceipts.push(...reviewed.receipts)
            }
            const reviewedPage = yield* Effect.fromResult(reviewedFigureBoxes(page, extractedPage, boxes))
            const conversion = convertPageExtraction(claim.document, claim.run.id, page, reviewedPage, images)
            pages.push(conversion.extraction)
            issues.push(...conversion.issues)
            cropReviews.push(...pageCrops)
            for (const crop of pageCrops) {
              const figure = conversion.extraction.figures.find((item) => item.id === crop.figureId)
              if (figure !== undefined && crop.warning !== null) {
                issues.push({
                  code: "figure-crop-unconfirmed",
                  message: crop.warning,
                  stage: "extraction",
                  locations: figure.locations,
                  blockIds: figure.sourceBlockIds,
                  figureId: figure.id,
                })
              }
            }
          }
          yield* progress(claim, stage, receipts.length, rendered.length)
          if (!legacy && nextPage < rendered.length) pending.push(yield* startPage(nextPage++))
        }),
      { discard: true },
    ).pipe(Effect.catch((error) => Effect.forEach(pending, Fiber.join, { discard: true }).pipe(Effect.andThen(Effect.fail(error)))))
    const sourceBlocks = pages.flatMap((page) => page.sourceBlocks).map((block, readingOrder) => ({ ...block, readingOrder }))
    const extraction = yield* Schema.decodeUnknownEffect(Extraction)({
      schemaVersion: "1",
      scope: { documentId: claim.document.id, runId: claim.run.id, sourceHash: claim.document.sourceHash },
      pages: pages.flatMap((page) => page.pages),
      sourceBlocks,
      pageFurniture: pages.flatMap((page) => page.pageFurniture ?? []),
      figures: pages.flatMap((page) => page.figures),
    })
    if (validateExtraction(claim.document, extraction).length !== 0) {
      return yield* executionFailure("invalid-provider-response", "Extracted pages do not cover the admitted document")
    }
    return {
      documentId: input.documentId,
      runId: input.runId,
      extraction: yield* save(claim, {
        conversion: { extraction, issues },
        receipts,
        ...(reviews.length === 0 ? {} : { reviews }),
        ...(cropReviews.length === 0 ? {} : { cropReviews }),
        ...(cropReceipts.length === 0 ? {} : { cropReceipts }),
      }),
    }
  })
  return extract
}
