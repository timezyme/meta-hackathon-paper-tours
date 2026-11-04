import { Effect, Result } from "effect"
import { FigureCropReview, StageReceipt, figureCropPromptVersionOf, type ImageArtifact, type Page, type PixelBox } from "../domain/index.ts"
import { invalidStage } from "../paper/correction/index.ts"
import { pageFigureId, type PageExtractionResponse } from "../paper/extraction/page.ts"
import { buildFigureCropRequest, figureCropProblems, figureCropRounds, widenedFigureCrop } from "../paper/figures/index.ts"
import { figureCropReviewAgentId } from "../paper/providers/meta/index.ts"
import { type DispatchClaim } from "../storage/index.ts"
import { executionFailure, type AttemptInput } from "./contracts.ts"
import {
  sameArtifact,
  type MetaCall,
  problemLimit,
  reviewUnavailable,
  preflightUnavailable,
  type CroppedFigure,
  cropProblemText,
  cropWarning,
  type StageError,
  reviewLoop,
} from "./pipeline-shared.ts"
import { type StageContext } from "./stage-context.ts"

export const makeFigureCrops = (context: StageContext) => {
  const { options, fs, path, documents, artifacts, renderer, limits, attemptCall, reviewAttempt } = context
  const renderPages = Effect.fnUntraced(function* (claim: DispatchClaim) {
    const original = yield* documents.original(claim.document.ownerId, claim.document.id)
    const directory = yield* fs.makeTempDirectoryScoped({ directory: options.temporaryDirectory, prefix: "render-" })
    yield* fs.chmod(directory, 0o700)
    const source = path.join(directory, "source.pdf")
    yield* fs.writeFile(source, original.bytes, { flag: "wx", mode: 0o600 })
    const { byteCount, sourceHash, pageCount } = claim.document
    const pages = yield* renderer.render({ privatePath: source, byteCount, sourceHash, pageCount, outputDirectory: directory })
    for (const page of pages) {
      const bytes = yield* fs.readFile(path.join(directory, page.image.path))
      const stored = yield* artifacts.put(claim.document.ownerId, claim.document.id, bytes)
      if (!sameArtifact(stored, page.image))
        return yield* executionFailure("invalid-provider-response", "Rendered page integrity check failed")
    }
    return pages
  }, Effect.scoped)
  const cropFigure = Effect.fnUntraced(function* (
    claim: DispatchClaim,
    page: Page,
    pageImage: Uint8Array,
    proposal: PageExtractionResponse["figures"][number],
    box: PixelBox,
    corrected = false,
  ) {
    const directory = yield* fs.makeTempDirectoryScoped({ directory: options.temporaryDirectory, prefix: "figure-" })
    yield* fs.chmod(directory, 0o700)
    const privatePath = path.join(directory, "page.png")
    const outputPath = path.join(directory, "figure.png")
    yield* fs.writeFile(privatePath, pageImage, { flag: "wx", mode: 0o600 })
    const croppedResult = yield* renderer.crop({ privatePath, outputPath, page, box }).pipe(Effect.result)
    if (croppedResult._tag === "Failure") {
      if ((croppedResult.failure.code === "invalid-input" && !corrected) || croppedResult.failure.code === "storage-failed")
        return yield* croppedResult.failure
      return null
    }
    const cropped = croppedResult.success
    const bytes = yield* fs.readFile(outputPath)
    const stored = yield* artifacts.put(claim.document.ownerId, claim.document.id, bytes)
    if (!sameArtifact(stored, cropped)) return yield* executionFailure("invalid-provider-response", "Figure crop integrity check failed")
    const asset: ImageArtifact = {
      path: `images/page-${page.pageNumber}-figure-${proposal.blockIndex + 1}.png`,
      mediaType: "image/png",
      ...stored,
    }
    return { box, asset, bytes } satisfies CroppedFigure
  }, Effect.scoped)

  const reviewFigureCrop = Effect.fnUntraced(function* (
    claim: DispatchClaim,
    page: Page,
    pageImage: Uint8Array,
    extracted: PageExtractionResponse,
    proposal: PageExtractionResponse["figures"][number],
    initial: CroppedFigure,
    neighbours: ReadonlyArray<PixelBox>,
    headroomMicrousd: number,
  ) {
    const figureId = pageFigureId(page.pageNumber, proposal.blockIndex)
    const label = extracted.blocks[proposal.blockIndex]?.content ?? "[Figure]"
    const caption = proposal.captionBlockIndices.map((index) => extracted.blocks[index]?.content ?? "").join("\n\n")
    const figureLimits = limits(claim, "figures")
    const promptVersion = figureCropPromptVersionOf(claim.run.configuration)
    const receipts: Array<StageReceipt> = []
    const problems: Array<string> = []
    let current = initial
    let changed = false
    let previous: { readonly answer: unknown; readonly problems: ReadonlyArray<string> } | null = null
    const finish = (outcome: FigureCropReview["outcome"], reason: string | null) => ({
      crop: current,
      receipts,
      review: {
        figureId,
        pageId: page.id,
        agent: figureCropReviewAgentId,
        outcome,
        rounds: receipts.length,
        attemptIds: receipts.map((receipt) => receipt.id),
        proposedBox: initial.box,
        finalBox: current.box,
        problems: problems.slice(0, problemLimit).map(cropProblemText),
        warning: outcome === "unconfirmed" || outcome === "not-reviewed" ? cropWarning(outcome, reason ?? "review unavailable") : null,
      } satisfies FigureCropReview,
    })
    const unconfirmed = Effect.fnUntraced(function* (reason: string | null) {
      const widened = changed ? widenedFigureCrop({ page, proposed: initial.box, current: current.box, neighbours }) : null
      const recropped = widened === null ? null : yield* cropFigure(claim, page, pageImage, proposal, widened, true)
      if (recropped !== null) current = recropped
      return finish("unconfirmed", reason)
    })
    const unreviewed = (reason: string) => (receipts.length === 0 ? Effect.succeed(finish("not-reviewed", reason)) : unconfirmed(reason))
    return yield* reviewLoop(
      1,
      figureCropRounds,
      Effect.fnUntraced(function* (round: number): Effect.fn.Return<ReturnType<typeof finish> | null, StageError> {
        const box = current.box
        const check = { page, proposed: initial.box, current: box, neighbours }
        const request = buildFigureCropRequest(
          {
            promptVersion,
            page,
            pageImage,
            crop: { bytes: current.bytes, artifact: current.asset },
            box,
            neighbours,
            label,
            caption,
            round,
            previous,
          },
          figureLimits,
        )
        if (Result.isFailure(request)) return yield* unreviewed(request.failure.message)
        const call: MetaCall = {
          stage: "figures",
          task: "figure-crop",
          request: request.success,
          limits: figureLimits,
          pageIds: [page.id],
          figureId,
          inputHashes: [page.image.hash, current.asset.hash],
          ...(round === 1 ? { headroomMicrousd } : {}),
          validate: (value) =>
            Result.mapError(figureCropProblems(check, value), (found) =>
              invalidStage(`Figure crop review rejected: ${found.slice(0, 3).join("; ")}`),
            ),
        }
        const previousAttemptId = receipts.at(-1)?.id
        const retry: AttemptInput["retry"] =
          previousAttemptId === undefined
            ? { _tag: "none" }
            : { _tag: "review", previousAttemptId, round: 1, headroomMicrousd: Math.max(0, headroomMicrousd) }
        const outcome = yield* reviewAttempt(
          claim,
          attemptCall(claim, call, retry),
          (value) => figureCropProblems(check, value),
          true,
          (failure, phase) => (phase === "preflight" ? preflightUnavailable(failure) : reviewUnavailable(failure)),
        )
        if (outcome._tag === "unavailable") return yield* unreviewed(outcome.failure.message)
        const { response, answer, verdict } = outcome
        receipts.push(response.receipt)
        if (Result.isFailure(verdict)) {
          problems.push(...verdict.failure)
          previous = { answer, problems: verdict.failure }
          return null
        }
        if (verdict.success._tag === "confirmed") return finish(changed ? "corrected" : "confirmed", null)
        const recropped = yield* cropFigure(claim, page, pageImage, proposal, verdict.success.box, true)
        if (recropped === null) {
          const problem = "The corrected box could not be cropped from the rendered page"
          problems.push(problem)
          previous = { answer, problems: [problem] }
          return null
        }
        current = recropped
        changed = true
        previous = { answer, problems: [] }
        return null
      }),
      unconfirmed(null),
    )
  })

  return { renderPages, cropFigure, reviewFigureCrop }
}
