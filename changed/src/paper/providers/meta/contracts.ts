import { museSparkModel } from "../../../domain/meta-policy.ts"
import { Effect, Predicate, Result, Schema } from "effect"
import { Base64 } from "effect/encoding"
import type { StageReceipt } from "../../../domain/index.ts"
import { museReviewPrompt, museReviewPromptVersionFor } from "../../../domain/prompt-templates.ts"
import { executionFailure, type ExecutionFailure } from "../../../processing/contracts.ts"

const metaStages = ["extraction", "page-check", "headings", "figures", "guide"] as const
export type MetaStage = typeof metaStages[number]
export const figureCropReviewAgentId = "figures-crop-review"
export type MetaAgentId = MetaStage | `${MetaStage}-review` | typeof figureCropReviewAgentId
export const museReviewAgentId = (stage: MetaStage): MetaAgentId => `${stage}-review`
export const MetaContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("image_url"), image_url: Schema.Struct({ url: Schema.String.check(Schema.isPattern(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u)) }) }),
])
export type MetaContent = typeof MetaContent.Type
export const MetaRequest = Schema.Struct({
  model: Schema.Literal(museSparkModel),
  messages: Schema.Tuple([
    Schema.Struct({ role: Schema.Literal("system"), content: Schema.String }),
    Schema.Struct({ role: Schema.Literal("user"), content: Schema.NonEmptyArray(MetaContent) }),
  ]),
  reasoning_effort: Schema.Literals(["high", "medium"]),
  max_completion_tokens: Schema.Int.check(Schema.isGreaterThan(0)),
  response_format: Schema.Struct({ type: Schema.Literal("json_schema"), json_schema: Schema.Struct({ name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/u)), strict: Schema.Literal(true), schema: Schema.Json }) }),
})
export type MetaRequest = typeof MetaRequest.Type
export const MetaEnvelope = Schema.Struct({
  format: Schema.Literal("amuseme-meta-wire-v1"),
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  requestId: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,256}$/u))),
  bodyBase64: Schema.String,
  complete: Schema.Boolean,
})
export type MetaEnvelope = typeof MetaEnvelope.Type

export interface MetaStageSpec {
  readonly instructions: string
  readonly promptName: string
  readonly promptVersion: string
  readonly schema: Schema.Json
}
export type MetaStageSpecs = Readonly<Record<MetaStage, MetaStageSpec>>
export type MetaValidators = Readonly<Record<MetaStage, (value: Schema.Json, receipt: StageReceipt) => Effect.Effect<void, ExecutionFailure>>>
export const stableJson = (value: Schema.Json): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  return `{${Object.entries<Schema.Json>(value).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`
}
export const invalidMeta = () => executionFailure("invalid-provider-response", "The saved Meta response did not pass validation")
export const metaEffort = (stage: MetaStage) => stage === "headings" ? "medium" as const : "high" as const

export const strictSchema = (value: Schema.Json): boolean => {
  let properties = 0
  const visit = (node: unknown, depth: number): boolean => {
    if (!Predicate.isObject(node)) return typeof node === "boolean"
    if (depth > 10 || "oneOf" in node || "allOf" in node || "$ref" in node) return false
    if (node.type === "object") {
      if (!Predicate.isObject(node.properties) || !Array.isArray(node.required) || node.additionalProperties !== false) return false
      const keys = Object.keys(node.properties)
      const required = node.required
      properties += keys.length
      if (properties > 5000 || required.length !== keys.length || !keys.every((key) => required.includes(key))) return false
      if (!Object.values(node.properties).every((item) => visit(item, depth + 1))) return false
    }
    if (node.items !== undefined && !visit(node.items, depth + 1)) return false
    return node.anyOf === undefined || (Array.isArray(node.anyOf) && node.anyOf.every((item) => visit(item, depth + 1)))
  }
  return Predicate.isObject(value) && value.type === "object" && visit(value, 1)
}

export const makeMetaRequest = (stage: MetaStage, spec: MetaStageSpec, content: readonly [MetaContent, ...Array<MetaContent>], maxOutputTokens: number): MetaRequest => ({
  model: museSparkModel, messages: [{ role: "system", content: spec.instructions }, { role: "user", content }],
  reasoning_effort: metaEffort(stage), max_completion_tokens: maxOutputTokens,
  response_format: { type: "json_schema", json_schema: { name: spec.promptName, strict: true, schema: spec.schema } },
})

const TokenUsage = Schema.Struct({ prompt_tokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))), completion_tokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))) })
const Metadata = Schema.Struct({ id: Schema.optional(Schema.String), usage: Schema.optional(TokenUsage) })
const Completion = Schema.Struct({
  id: Schema.optional(Schema.String), model: Schema.Literal(museSparkModel),
  choices: Schema.Array(Schema.Struct({
    finish_reason: Schema.String,
    message: Schema.Struct({ role: Schema.Literal("assistant"), content: Schema.NullOr(Schema.String), refusal: Schema.optional(Schema.NullOr(Schema.String)), tool_calls: Schema.optional(Schema.Array(Schema.Unknown)) }),
  })),
  usage: Schema.optional(TokenUsage),
})
const readMetaJson = (envelope: MetaEnvelope) => {
  const bytes = Base64.decode(envelope.bodyBase64)
  if (Result.isFailure(bytes) || Base64.encode(bytes.success) !== envelope.bodyBase64) return Result.fail(invalidMeta())
  return Result.try({ try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes.success), catch: invalidMeta }).pipe(
    Result.flatMap(Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))), Result.mapError(invalidMeta),
  )
}
export const readMetaCompletion = (envelope: MetaEnvelope) => readMetaJson(envelope).pipe(Result.flatMap(Schema.decodeUnknownResult(Completion)), Result.mapError(invalidMeta))
export const readMetaMetadata = (envelope: MetaEnvelope) => readMetaJson(envelope).pipe(Result.flatMap(Schema.decodeUnknownResult(Metadata)), Result.mapError(invalidMeta))
export const decodeMetaOutput = Effect.fn("decodeMetaOutput")(function* (value: Schema.Json) {
  const envelope = yield* Schema.decodeUnknownEffect(MetaEnvelope)(value, { onExcessProperty: "error" }).pipe(Effect.mapError(invalidMeta))
  const bytes = Base64.decode(envelope.bodyBase64)
  if (Result.isFailure(bytes) || Base64.encode(bytes.success) !== envelope.bodyBase64) return yield* invalidMeta()
  if (envelope.complete && [429, 502, 503, 504].includes(envelope.status)) return yield* executionFailure("provider-failed", "Meta could not complete this request. Its saved response is retained.")
  if (!envelope.complete || envelope.status < 200 || envelope.status >= 300) return yield* invalidMeta()
  const completion = yield* Effect.fromResult(readMetaCompletion(envelope))
  const choice = completion.choices[0]
  if (completion.choices.length !== 1 || choice === undefined || choice.finish_reason !== "stop" || choice.message.content === null || choice.message.refusal || (choice.message.tool_calls?.length ?? 0) !== 0) return yield* invalidMeta()
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(choice.message.content).pipe(Effect.mapError(invalidMeta))
})

export const museReviewSpec = (stage: MetaStage, spec: MetaStageSpec): MetaStageSpec => {
  const promptVersion = museReviewPromptVersionFor(stage, spec.promptVersion)
  return { instructions: museReviewPrompt(stage, promptVersion), promptName: museReviewAgentId(stage), promptVersion, schema: spec.schema }
}
export const museReviewRounds = 2
export interface MuseReviewInput {
  readonly round: number
  readonly rejectedAnswer: string
  readonly rejectedAnswerSha256: string
  readonly problems: ReadonlyArray<string>
}
export const makeMuseReviewRequest = (stage: MetaStage, spec: MetaStageSpec, original: MetaRequest, review: MuseReviewInput): MetaRequest => {
  const museReview = { round: review.round, maxRounds: museReviewRounds, originalBrief: original.messages[0].content, rejectedAnswerSha256: review.rejectedAnswerSha256, rejectedAnswer: review.rejectedAnswer, problems: review.problems }
  return makeMetaRequest(stage, museReviewSpec(stage, spec), [...original.messages[1].content, { type: "text", text: JSON.stringify({ museReview }) }], original.max_completion_tokens)
}
export const metaAssistantText = (value: Schema.Json): string | null => {
  const envelope = Schema.decodeUnknownResult(MetaEnvelope)(value, { onExcessProperty: "error" })
  if (Result.isFailure(envelope) || !envelope.success.complete || envelope.success.status < 200 || envelope.success.status >= 300) return null
  const completion = readMetaCompletion(envelope.success)
  const content = Result.isSuccess(completion) && completion.success.choices.length === 1 ? completion.success.choices[0]?.message.content : null
  return typeof content === "string" && content.trim() !== "" ? content : null
}
