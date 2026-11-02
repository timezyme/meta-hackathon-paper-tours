import { Result, Schema } from "effect"
import type { ImageArtifact, Page, PixelBox } from "../../domain/index.ts"
import { FIGURE_CROP_REVIEW_PROMPT, figureCropReviewPromptVersion } from "../../domain/prompt-templates.ts"
import type { ExecutionFailure } from "../../processing/index.ts"
import { boundRequest, imageContent, invalidStage, stageJsonSchema, type StageRequestLimits } from "../correction/requests.ts"
import { cropBox } from "../extraction/page.ts"
import { figureCropReviewAgentId, makeMetaRequest, type MetaRequest, type MetaStageSpec } from "../providers/meta/contracts.ts"

const Region = Schema.Struct({ x: Schema.Finite, y: Schema.Finite, width: Schema.Finite, height: Schema.Finite })
export const FigureCropAnswer = Schema.Struct({ verdict: Schema.Literals(["confirmed", "corrected"]), box: Schema.NullOr(Region) })
export type FigureCropAnswer = typeof FigureCropAnswer.Type
export const figureCropReviewSpec: MetaStageSpec = {
  instructions: FIGURE_CROP_REVIEW_PROMPT, promptName: figureCropReviewAgentId, promptVersion: figureCropReviewPromptVersion, schema: stageJsonSchema(FigureCropAnswer),
}
export const figureCropRounds = 2
export const figureCropLimits = { minSide: 24, minOverlap: 0.25 } as const

export type FigureCropVerdict = { readonly _tag: "confirmed" } | { readonly _tag: "corrected"; readonly box: PixelBox }
const area = (box: PixelBox) => box.width * box.height
const overlap = (left: PixelBox, right: PixelBox) =>
  Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
  * Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
const sameBox = (left: PixelBox, right: PixelBox) => left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
const schemaProblem = "The answer does not match the schema { verdict: \"confirmed\" | \"corrected\", box: { x, y, width, height } | null }"

export const figureCropProblems = (page: Page, proposed: PixelBox, current: PixelBox, value: unknown): Result.Result<FigureCropVerdict, ReadonlyArray<string>> => {
  const decoded = Schema.decodeUnknownResult(FigureCropAnswer)(value, { onExcessProperty: "error" })
  if (Result.isFailure(decoded)) return Result.fail([schemaProblem])
  const { verdict, box } = decoded.success
  if (verdict === "confirmed") return box === null ? Result.succeed({ _tag: "confirmed" }) : Result.fail(["A confirmed crop must return box null"])
  if (box === null) return Result.fail(["A corrected crop must return its corrected box"])
  if (box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0) return Result.fail(["The corrected box needs a nonnegative origin and a positive width and height"])
  const corrected = cropBox(box)
  const problems: Array<string> = []
  if (corrected.x + corrected.width > page.width || corrected.y + corrected.height > page.height) problems.push(`The corrected box must lie inside the ${page.width}x${page.height} rendered page`)
  if (corrected.width < figureCropLimits.minSide || corrected.height < figureCropLimits.minSide) problems.push(`The corrected box must be at least ${figureCropLimits.minSide} pixels wide and high`)
  if (overlap(corrected, proposed) < figureCropLimits.minOverlap * Math.min(area(corrected), area(proposed))) {
    problems.push(`The corrected box must overlap the proposed figure region (${proposed.x}, ${proposed.y}, ${proposed.width}x${proposed.height}) by at least ${figureCropLimits.minOverlap * 100}% of the smaller box`)
  }
  if (problems.length > 0) return Result.fail(problems)
  return Result.succeed(sameBox(corrected, current) ? { _tag: "confirmed" } : { _tag: "corrected", box: corrected })
}
export const validateFigureCropAnswer = (page: Page, proposed: PixelBox, current: PixelBox, value: unknown): Result.Result<FigureCropVerdict, ExecutionFailure> =>
  figureCropProblems(page, proposed, current, value).pipe(Result.mapError((problems) => invalidStage(`Figure crop review rejected: ${problems.join("; ")}`)))

export interface FigureCropRequestInput {
  readonly page: Page
  readonly pageImage: Uint8Array
  readonly crop: { readonly bytes: Uint8Array; readonly artifact: ImageArtifact }
  readonly box: PixelBox
  readonly label: string
  readonly caption: string
  readonly round: number
  readonly previous: { readonly answer: unknown; readonly problems: ReadonlyArray<string> } | null
}
export const buildFigureCropRequest = (input: FigureCropRequestInput, limits: StageRequestLimits): Result.Result<MetaRequest, ExecutionFailure> => {
  const pageImage = imageContent(input.pageImage, input.page.image.mediaType, input.page.image.byteCount)
  if (Result.isFailure(pageImage)) return Result.fail(pageImage.failure)
  const crop = imageContent(input.crop.bytes, input.crop.artifact.mediaType, input.crop.artifact.byteCount)
  if (Result.isFailure(crop)) return Result.fail(crop.failure)
  const { x, y, width, height } = input.box
  const figureCropReview = {
    round: input.round, maxRounds: figureCropRounds,
    page: { pageNumber: input.page.pageNumber, width: input.page.width, height: input.page.height },
    figure: { label: input.label, caption: input.caption }, box: { x, y, width, height },
    ...(input.previous === null ? {} : { previousRound: input.previous }),
  }
  return boundRequest(makeMetaRequest("figures", figureCropReviewSpec, [{ type: "text", text: JSON.stringify({ figureCropReview }) }, pageImage.success, crop.success], limits.maxOutputTokens), limits)
}
