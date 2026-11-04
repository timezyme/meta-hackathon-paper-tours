import { Effect, Schema } from "effect"
import { OutputRevisionId, StageReceipt, type ReceiptUse } from "../../domain/index.ts"
import { applyHeadingDecisions } from "../../paper/headings/index.ts"
import { assembleDocument } from "../../paper/reading/index.ts"
import { type DispatchClaim } from "../../storage/index.ts"
import { type Checkpoint } from ".././checkpoints.ts"
import { isPageExtraction, deliveryFor, fallbackIssue } from ".././pipeline-shared.ts"
import { type StageContext } from ".././stage-context.ts"

export const makeAssemble = (context: StageContext) => {
  const { database, save, progress, loadDescribed } = context
  const assemble = Effect.fnUntraced(function* (claim: DispatchClaim, input: Checkpoint) {
    const stage = "assembly"
    const { described, descriptions, headings, correction, extraction, data } = yield* loadDescribed(claim, input)
    yield* progress(claim, stage, 0, 1)
    const rows = yield* database.query("assembly-receipts", () =>
      database.db
        .selectFrom("provider_attempts")
        .select("receipt_json")
        .where("owner_id", "=", claim.document.ownerId)
        .where("document_id", "=", claim.document.id)
        .where("run_id", "=", claim.run.id)
        .orderBy("created_at", "asc")
        .execute(),
    )
    const receipts = new Map(
      [
        ...data.receipts,
        ...(data.cropReceipts ?? []),
        ...correction.receipts,
        ...(headings.receipt === null ? [] : [headings.receipt]),
        ...descriptions.receipts,
      ].map((receipt) => [receipt.id, receipt]),
    )
    const museReviews = [
      ...(data.reviews ?? []),
      ...(correction.reviews ?? []),
      ...(headings.reviews ?? []),
      ...(descriptions.reviews ?? []),
    ]
    const unlisted: Array<StageReceipt> = []
    for (const row of rows) {
      const receipt = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StageReceipt))(row.receipt_json)
      if (!receipts.has(receipt.id)) unlisted.push(receipt)
    }
    const pageIndex = (receipt: StageReceipt) => extraction.pages.findIndex((page) => page.id === receipt.pageIds[0])
    const attemptIndex = (receipt: StageReceipt) =>
      data.reviews?.find((review) => review.pageIds[0] === receipt.pageIds[0])?.attemptIds.indexOf(receipt.id) ?? -1
    const unlistedExtraction = unlisted
      .filter(isPageExtraction)
      .toSorted((left, right) => pageIndex(left) - pageIndex(right) || attemptIndex(left) - attemptIndex(right))
    let extractionIndex = 0
    for (const receipt of unlisted) {
      const next = isPageExtraction(receipt) ? unlistedExtraction[extractionIndex++]! : receipt
      receipts.set(next.id, next)
    }
    const receiptUses: Array<ReceiptUse> = [...receipts.values()].map((receipt) => ({ receipt, delivery: deliveryFor(claim, receipt) }))
    const assembled = yield* Effect.fromResult(
      assembleDocument({
        document: claim.document,
        run: claim.run,
        revisionId: OutputRevisionId.make(claim.run.id),
        extraction,
        corrected: correction.corrected,
        headings: yield* Effect.fromResult(applyHeadingDecisions(extraction, correction.corrected, headings.response)),
        figures: descriptions.figures,
        issues: [...data.conversion.issues, ...descriptions.issues, ...museReviews.flatMap((review) => fallbackIssue(review, extraction))],
        receiptUses,
        ...(museReviews.length === 0 ? {} : { museReviews }),
        ...(data.cropReviews === undefined || data.cropReviews.length === 0 ? {} : { figureCrops: data.cropReviews }),
      }),
    )
    yield* progress(claim, stage, 1, 1)
    return { ...described, publication: yield* save(claim, assembled) }
  })
  return assemble
}
