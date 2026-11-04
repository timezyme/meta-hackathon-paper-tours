import { Result, Schema } from "effect"
import { Figure, NonBlank, type Extraction, type Issue, type ProviderAttemptId } from "../../domain/index.ts"
import { executionFailure, type ExecutionFailure } from "../../processing/index.ts"
import type { CorrectedText } from "../correction/contracts.ts"
import { formatCorrectedText } from "../correction/format.ts"
import { validateCorrectedText } from "../correction/page-check.ts"
import { boundRequest, imageContent, invalidStage, stageJsonSchema, type StageRequestLimits } from "../correction/requests.ts"
import { makeMetaRequest, type MetaRequest, type MetaStageSpec } from "../providers/meta/contracts.ts"
import { FIGURE_DESCRIPTION_PROMPT } from "./prompt.ts"

export const FigureResponse = Schema.Struct({ description: NonBlank })
export type FigureResponse = typeof FigureResponse.Type
export const figuresSpec: MetaStageSpec = { instructions: FIGURE_DESCRIPTION_PROMPT, promptName: "figures", promptVersion: "amuseme-1", schema: stageJsonSchema(FigureResponse) }

export const unavailableFigure = (figure: Figure, reason: string): { readonly figure: Figure; readonly issue: Issue } => {
  const message = reason.trim() === "" ? "Figure description is unavailable" : reason
  return { figure: { ...figure, description: { _tag: "unavailable", reason: message } }, issue: { code: "figure-description-unavailable", message, stage: "figures", locations: figure.locations, blockIds: figure.sourceBlockIds, figureId: figure.id } }
}

export type FigureRequestPreparation = { readonly _tag: "ready"; readonly request: MetaRequest } | { readonly _tag: "unavailable"; readonly figure: Figure; readonly issue: Issue }
const equalFigure = Schema.toEquivalence(Figure)

export const buildFigureRequest = (extraction: Extraction, corrected: CorrectedText, figure: Figure, verifiedImage: Uint8Array | null, limits: StageRequestLimits): Result.Result<FigureRequestPreparation, ExecutionFailure> => {
  const valid = validateCorrectedText(extraction, corrected)
  if (Result.isFailure(valid)) return Result.fail(valid.failure)
  const original = extraction.figures.find((item) => item.id === figure.id)
  if (original === undefined || !equalFigure(original, figure)) return Result.fail(executionFailure("conflict", "Figure does not match its original extraction"))
  if (figure.asset._tag === "unavailable" || verifiedImage === null) return Result.succeed({ _tag: "unavailable", ...unavailableFigure(figure, figure.asset._tag === "unavailable" ? figure.asset.reason : "Native figure image is unavailable") })
  const image = imageContent(verifiedImage, figure.asset.artifact.mediaType, figure.asset.artifact.byteCount)
  if (Result.isFailure(image)) return Result.fail(image.failure)
  const request = makeMetaRequest("figures", figuresSpec, [{ type: "text", text: formatCorrectedText(extraction, corrected.blocks) }, image.success, { type: "text", text: `Image link: ${figure.asset.artifact.path}\nFigure ID: ${figure.id}` }], limits.maxOutputTokens)
  return boundRequest(request, limits).pipe(Result.map((bounded) => ({ _tag: "ready" as const, request: bounded })))
}

export const validateFigureResponse = (value: unknown): Result.Result<FigureResponse, ExecutionFailure> => {
  const result = Schema.decodeUnknownResult(FigureResponse)(value, { onExcessProperty: "error" })
  if (Result.isFailure(result) || /\r?\n[\t ]*\r?\n|^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|```|~~~)/mu.test(result.success.description)) return Result.fail(invalidStage("Figure description must contain nonempty plain text without headings, bullets, fences, or blank lines"))
  return Result.succeed(result.success)
}

export const applyFigureDescription = (figure: Figure, value: unknown, providerAttemptId: ProviderAttemptId): Result.Result<Figure, ExecutionFailure> => {
  if (figure.asset._tag === "unavailable") return Result.fail(invalidStage("An unavailable image cannot receive a generated description"))
  return validateFigureResponse(value).pipe(Result.map(({ description }) => ({ ...figure, description: { _tag: "generated", text: description, providerAttemptId, label: "AI-written" } })))
}
