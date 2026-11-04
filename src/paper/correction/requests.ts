import { Predicate, Result, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { executionFailure, type ExecutionFailure } from "../../processing/index.ts"
import { MetaRequest, type MetaContent } from "../providers/meta/contracts.ts"

export const sparkContextTokens = 1_048_576
export interface StageRequestLimits {
  readonly maxOutputTokens: number
  readonly maxRequestBytes: number
  readonly imageTokenUpperBound: number
}

const flattenBounds = (value: Schema.Json): Schema.Json => {
  if (Array.isArray(value)) return value.map(flattenBounds)
  if (value === null || typeof value !== "object") return value
  const mapped = Object.fromEntries(Object.entries<Schema.Json>(value).map(([key, child]) => [key, flattenBounds(child)]))
  const bounds = mapped.allOf
  if (!Array.isArray(bounds) || !bounds.every((bound) => Predicate.isObject(bound) && Object.entries(bound).every(([key, entry]) => (key === "minimum" || key === "maximum") && typeof entry === "number"))) return mapped
  const { allOf: _allOf, ...rest } = mapped
  for (const bound of bounds) {
    if (Predicate.isObject(bound) && typeof bound.minimum === "number") rest.minimum = Math.max(typeof rest.minimum === "number" ? rest.minimum : -Infinity, bound.minimum)
    if (Predicate.isObject(bound) && typeof bound.maximum === "number") rest.maximum = Math.min(typeof rest.maximum === "number" ? rest.maximum : Infinity, bound.maximum)
  }
  return rest
}

export const stageJsonSchema = (schema: Schema.Constraint): Schema.Json => flattenBounds(Schema.decodeUnknownSync(Schema.Json)(Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error", referencePolicy: () => undefined }).schema))
export const invalidStage = (message: string): ExecutionFailure => executionFailure("invalid-provider-response", message)

export const boundRequest = (request: MetaRequest, limits: StageRequestLimits): Result.Result<MetaRequest, ExecutionFailure> => {
  const valid = Schema.decodeUnknownResult(MetaRequest)(request, { onExcessProperty: "error" })
  if (Result.isFailure(valid) || !Number.isSafeInteger(limits.maxRequestBytes) || limits.maxRequestBytes < 1 || !Number.isSafeInteger(limits.imageTokenUpperBound) || limits.imageTokenUpperBound < 0) return Result.fail(executionFailure("limit-exceeded", "Invalid model request limits"))
  const textOnly = { ...request, messages: request.messages.map((message) => ({ ...message, content: typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text") })) }
  const bytes = new TextEncoder()
  const imageCount = request.messages[1].content.filter((part) => part.type === "image_url").length
  if ((imageCount > 0 && limits.imageTokenUpperBound === 0) || imageCount > 50 || request.max_completion_tokens !== limits.maxOutputTokens || bytes.encode(JSON.stringify(textOnly)).byteLength + limits.imageTokenUpperBound + limits.maxOutputTokens + 4096 > sparkContextTokens || bytes.encode(JSON.stringify(request)).byteLength > limits.maxRequestBytes) return Result.fail(executionFailure("limit-exceeded", "The complete model request exceeds its context or byte allowance"))
  return Result.succeed(request)
}

export const imageContent = (bytes: Uint8Array, mediaType: "image/png" | "image/jpeg" | "image/webp", expectedByteCount: number): Result.Result<MetaContent, ExecutionFailure> => {
  const validType = mediaType === "image/png"
    ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
    : mediaType === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP"
  if (!validType || bytes.byteLength !== expectedByteCount || bytes.byteLength > 50_000_000) return Result.fail(executionFailure("conflict", "Verified image bytes do not match their artifact metadata"))
  return Result.succeed({ type: "image_url", image_url: { url: `data:${mediaType};base64,${Base64.encode(bytes)}` } })
}
