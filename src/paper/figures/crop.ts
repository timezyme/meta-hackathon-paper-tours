import { Result, Schema } from "effect"
import type { FigureCropPromptVersion, ImageArtifact, Page, PixelBox } from "../../domain/index.ts"
import { FIGURE_CROP_REVIEW_PROMPT, FIGURE_CROP_REVIEW_PROMPT_V2, figureCropReviewPromptVersion } from "../../domain/prompt-templates.ts"
import type { ExecutionFailure } from "../../processing/index.ts"
import { boundRequest, imageContent, stageJsonSchema, type StageRequestLimits } from "../correction/requests.ts"
import { cropBox } from "../extraction/page.ts"
import { figureCropReviewAgentId, makeMetaRequest, type MetaRequest, type MetaStageSpec } from "../providers/meta/contracts.ts"

const Region = Schema.Struct({ x: Schema.Finite, y: Schema.Finite, width: Schema.Finite, height: Schema.Finite })
export const FigureCropAnswer = Schema.Struct({ verdict: Schema.Literals(["confirmed", "corrected"]), box: Schema.NullOr(Region) })
export type FigureCropAnswer = typeof FigureCropAnswer.Type
const cropSpec = (instructions: string, promptVersion: FigureCropPromptVersion): MetaStageSpec => ({
  instructions, promptName: figureCropReviewAgentId, promptVersion, schema: stageJsonSchema(FigureCropAnswer),
})
export const figureCropReviewSpecs: Readonly<Record<FigureCropPromptVersion, MetaStageSpec>> = {
  "amuseme-1": cropSpec(FIGURE_CROP_REVIEW_PROMPT, "amuseme-1"),
  "amuseme-2": cropSpec(FIGURE_CROP_REVIEW_PROMPT_V2, "amuseme-2"),
}
export const figureCropReviewSpec = figureCropReviewSpecs[figureCropReviewPromptVersion]
export const figureCropRounds = 2
export const figureCropLimits = { minSide: 24, minOverlap: 0.25, maxPageShare: 0.5, maxNeighbourShare: 0.5 } as const

export type FigureCropVerdict = { readonly _tag: "confirmed" } | { readonly _tag: "corrected"; readonly box: PixelBox }
export interface FigureCropCheck {
  readonly page: Page
  readonly proposed: PixelBox
  readonly current: PixelBox
  readonly neighbours: ReadonlyArray<PixelBox>
}
const area = (box: PixelBox) => box.width * box.height
const overlap = (left: PixelBox, right: PixelBox) =>
  Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
  * Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
const sameBox = (left: PixelBox, right: PixelBox) => left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
const percent = (part: number, whole: number) => Math.round(part / whole * 100)
const placement = (box: PixelBox) => `(${box.x}, ${box.y}, ${box.width}x${box.height})`
const schemaProblem = "The answer does not match the schema { verdict: \"confirmed\" | \"corrected\", box: { x, y, width, height } | null }"

export const figureNeighbours = (
  figures: ReadonlyArray<{ readonly blockIndex: number; readonly box: typeof Region.Type | null }>, blockIndex: number,
): ReadonlyArray<PixelBox> => figures.flatMap((figure) => figure.blockIndex === blockIndex || figure.box === null ? [] : [cropBox(figure.box)])

const inflationProblems = ({ page, proposed, neighbours }: FigureCropCheck, corrected: PixelBox): ReadonlyArray<string> => {
  const pageArea = page.width * page.height
  const pageLimit = figureCropLimits.maxPageShare * pageArea
  const wholePage = area(corrected) >= pageLimit && area(proposed) < pageLimit
    ? [`The corrected box covers ${percent(area(corrected), pageArea)}% of the page, but the proposed figure region covers ${percent(area(proposed), pageArea)}%; crop only this figure, never the whole page, its title or neighbouring figures`]
    : []
  const taken = neighbours.filter((neighbour) => {
    const limit = figureCropLimits.maxNeighbourShare * area(neighbour)
    return area(neighbour) > 0 && overlap(corrected, neighbour) >= limit && overlap(proposed, neighbour) < limit
  })
  const duplicate = taken.length === 0 ? [] : [
    `The corrected box takes in ${taken.length === 1 ? "another figure's region" : `${taken.length} other figures' regions`} on this page (${taken.slice(0, 3).map(placement).join(", ")}); crop only this figure, without neighbouring figures or steps`,
  ]
  return [...wholePage, ...duplicate]
}

export const figureCropProblems = (check: FigureCropCheck, value: unknown): Result.Result<FigureCropVerdict, ReadonlyArray<string>> => {
  const decoded = Schema.decodeUnknownResult(FigureCropAnswer)(value, { onExcessProperty: "error" })
  if (Result.isFailure(decoded)) return Result.fail([schemaProblem])
  const { verdict, box } = decoded.success
  if (verdict === "confirmed") return box === null ? Result.succeed({ _tag: "confirmed" }) : Result.fail(["A confirmed crop must return box null"])
  if (box === null) return Result.fail(["A corrected crop must return its corrected box"])
  if (box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0) return Result.fail(["The corrected box needs a nonnegative origin and a positive width and height"])
  const { page, current } = check
  const corrected = cropBox(box)
  const problems: Array<string> = []
  if (corrected.x + corrected.width > page.width || corrected.y + corrected.height > page.height) problems.push(`The corrected box must lie inside the ${page.width}x${page.height} rendered page`)
  if (corrected.width < figureCropLimits.minSide || corrected.height < figureCropLimits.minSide) problems.push(`The corrected box must be at least ${figureCropLimits.minSide} pixels wide and high`)
  if (overlap(corrected, current) < figureCropLimits.minOverlap * Math.min(area(corrected), area(current))) {
    problems.push(`The corrected box must overlap the given box ${placement(current)} by at least ${figureCropLimits.minOverlap * 100}% of the smaller box`)
  }
  problems.push(...inflationProblems(check, corrected))
  if (problems.length > 0) return Result.fail(problems)
  return Result.succeed(sameBox(corrected, current) ? { _tag: "confirmed" } : { _tag: "corrected", box: corrected })
}

export const widenedFigureCrop = (check: FigureCropCheck): PixelBox | null => {
  const { proposed, current } = check
  const x = Math.min(proposed.x, current.x)
  const y = Math.min(proposed.y, current.y)
  const union: PixelBox = {
    coordinateSystem: current.coordinateSystem, x, y,
    width: Math.max(proposed.x + proposed.width, current.x + current.width) - x,
    height: Math.max(proposed.y + proposed.height, current.y + current.height) - y,
  }
  return sameBox(union, current) || inflationProblems(check, union).length > 0 ? null : union
}

export interface FigureCropRequestInput {
  readonly promptVersion: FigureCropPromptVersion
  readonly page: Page
  readonly pageImage: Uint8Array
  readonly crop: { readonly bytes: Uint8Array; readonly artifact: ImageArtifact }
  readonly box: PixelBox
  readonly neighbours: ReadonlyArray<PixelBox>
  readonly label: string
  readonly caption: string
  readonly round: number
  readonly previous: { readonly answer: unknown; readonly problems: ReadonlyArray<string> } | null
}
const region = ({ x, y, width, height }: PixelBox) => ({ x, y, width, height })
export const buildFigureCropRequest = (input: FigureCropRequestInput, limits: StageRequestLimits): Result.Result<MetaRequest, ExecutionFailure> => {
  const pageImage = imageContent(input.pageImage, input.page.image.mediaType, input.page.image.byteCount)
  if (Result.isFailure(pageImage)) return Result.fail(pageImage.failure)
  const crop = imageContent(input.crop.bytes, input.crop.artifact.mediaType, input.crop.artifact.byteCount)
  if (Result.isFailure(crop)) return Result.fail(crop.failure)
  const figureCropReview = {
    round: input.round, maxRounds: figureCropRounds,
    page: { pageNumber: input.page.pageNumber, width: input.page.width, height: input.page.height },
    figure: { label: input.label, caption: input.caption }, box: region(input.box),
    ...(input.promptVersion === "amuseme-1" ? {} : { otherFigures: input.neighbours.map(region) }),
    ...(input.previous === null ? {} : { previousRound: input.previous }),
  }
  const spec = figureCropReviewSpecs[input.promptVersion]
  return boundRequest(makeMetaRequest("figures", spec, [{ type: "text", text: JSON.stringify({ figureCropReview }) }, pageImage.success, crop.success], limits.maxOutputTokens), limits)
}
