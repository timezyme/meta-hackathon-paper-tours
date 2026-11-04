import type { JSONValue, LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2Prompt, LanguageModelV2StreamPart } from "@ai-sdk/provider"
import { Clock, Crypto, Effect, Redacted, Result, Schema, Stream } from "effect"
import { Base64 } from "effect/encoding"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { ExecutionFailure, ProviderFailure, executionFailure, type GuardError, type ProviderCall, type ProviderResponse } from "../../../processing/contracts.ts"
import { readMetaCompletion, readMetaMetadata, stableJson, type MetaEnvelope, type MetaRequest, type MetaStage } from "./contracts.ts"

export const metaEndpoint = "https://api.meta.ai/v1/chat/completions"
export const countEndpoint = "https://api.meta.ai/v1/responses/input_tokens"
const CountAnswer = Schema.Struct({ object: Schema.Literal("response.input_tokens"), input_tokens: Schema.Int.check(Schema.isGreaterThan(0)) })
export const measureMetaInput = Effect.fn("MetaTransport.measureInput")(function* (request: MetaRequest, credential: Redacted.Redacted<string>) {
  const client = yield* HttpClient.HttpClient
  const crypto = yield* Crypto.Crypto
  const body = stableJson({
    model: request.model,
    instructions: request.messages[0].content,
    input: [{ role: "user", content: request.messages[1].content.map((part): Schema.Json => part.type === "text" ? { type: "input_text", text: part.text } : { type: "input_image", image_url: part.image_url.url }) }],
    text: { format: { type: "json_schema", ...request.response_format.json_schema } },
    reasoning: { effort: request.reasoning_effort },
  })
  const requestHash = Array.from(yield* crypto.digest("SHA-256", new TextEncoder().encode(body)), (byte) => byte.toString(16).padStart(2, "0")).join("")
  const response = yield* client.execute(HttpClientRequest.post(countEndpoint).pipe(HttpClientRequest.bearerToken(credential), HttpClientRequest.bodyText(body, "application/json"), HttpClientRequest.acceptJson))
  if (response.status !== 200) return yield* executionFailure(
    [408, 429, 500, 502, 503, 504].includes(response.status) ? "provider-failed" : [401, 403].includes(response.status) ? "processing-unavailable" : "invalid-provider-response",
    "Document context could not be checked before generation",
  )
  const bytes = yield* response.stream.pipe(Stream.runFoldEffect(() => new Uint8Array(), (collected, chunk) => {
    if (collected.length + chunk.length > 4096) return Effect.fail(executionFailure("invalid-provider-response", "The token-count response exceeds its byte allowance"))
    const next = new Uint8Array(collected.length + chunk.length)
    next.set(collected); next.set(chunk, collected.length)
    return Effect.succeed(next)
  }))
  const counted = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CountAnswer))(new TextDecoder().decode(bytes))
  if (counted.input_tokens > 524288) return yield* executionFailure("limit-exceeded", "The complete document exceeds the supported context allowance")
  return { requestHash, inputTokens: counted.input_tokens, model: request.model, framingReserveTokens: 65536 }
}, (effect) => effect.pipe(
  Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
  Effect.timeout("60 seconds"),
  Effect.mapError((cause) => Schema.is(ExecutionFailure)(cause) ? cause : executionFailure(
    cause._tag === "HttpClientError" || cause._tag === "TimeoutError" ? "provider-failed" : "invalid-provider-response",
    "Document context could not be checked before generation",
  )),
))
export interface MetaBinding {
  readonly stage: MetaStage
  readonly call: ProviderCall
  readonly request: MetaRequest
  readonly credential: Redacted.Redacted<string>
  readonly run: <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>, options?: { readonly signal?: AbortSignal }) => Promise<A>
  readonly signal: AbortSignal
  active: boolean
  sent: boolean
  captured: ProviderResponse | null
  readonly pending: Set<Promise<void>>
}
const denied = (sent = false) => new ProviderFailure({ certainty: sent ? "unknown" : "not-submitted", message: "The Meta request is not authorized or no longer active" })
const safeRequestId = (value: string | undefined): string | null => value !== undefined && /^[A-Za-z0-9._:-]{1,256}$/u.test(value) ? value : null
const FrameworkMetadata = Schema.Struct({ mastra: Schema.Struct({ createdAt: Schema.Number }) })
const frameworkMetadata = (value: unknown) => value === undefined || Result.isSuccess(Schema.decodeUnknownResult(FrameworkMetadata)(value, { onExcessProperty: "error" }))
const promptMatches = (prompt: LanguageModelV2Prompt, request: MetaRequest): boolean => {
  const system = prompt[0]
  const user = prompt[1]
  if (prompt.length !== 2 || system?.role !== "system" || system.content !== request.messages[0].content || user?.role !== "user" || user.content.length !== request.messages[1].content.length) return false
  if (!frameworkMetadata(system.providerOptions) || !frameworkMetadata(user.providerOptions)) return false
  return user.content.every((part, index) => {
    const expected = request.messages[1].content[index]
    if (!frameworkMetadata(part.providerOptions) || expected === undefined) return false
    if (part.type === "text") return expected.type === "text" && part.text === expected.text
    if (expected.type !== "image_url" || part.filename !== undefined) return false
    const actual = part.data instanceof URL ? part.data.href : `data:${part.mediaType};base64,${typeof part.data === "string" ? part.data : Base64.encode(part.data)}`
    return actual === expected.image_url.url
  })
}
const mutableJson = (value: Schema.Json): JSONValue => value === null || typeof value !== "object" ? value : Array.isArray(value) ? value.map(mutableJson) : Object.fromEntries(Object.entries<Schema.Json>(value).map(([key, item]) => [key, mutableJson(item)]))
export const metaProviderOptions = (request: MetaRequest) => ({ meta: { reasoningEffort: request.reasoning_effort, responseFormat: mutableJson(request.response_format) } })
const optionsMatch = (options: LanguageModelV2CallOptions, request: MetaRequest): boolean =>
  promptMatches(options.prompt, request) && options.maxOutputTokens === request.max_completion_tokens &&
  options.temperature === undefined && options.topP === undefined && options.topK === undefined && options.seed === undefined &&
  options.presencePenalty === undefined && options.frequencyPenalty === undefined && (options.stopSequences?.length ?? 0) === 0 &&
  (options.tools?.length ?? 0) === 0 && (options.toolChoice === undefined || options.toolChoice.type === "none") &&
  (options.responseFormat === undefined || options.responseFormat.type === "text") && Object.keys(options.headers ?? {}).length === 0 &&
  options.includeRawChunks !== true &&
  stableJson(options.providerOptions ?? {}) === stableJson(metaProviderOptions(request))

const submit = Effect.fn("MetaTransport.submit")(function* (binding: MetaBinding, options: LanguageModelV2CallOptions): Effect.fn.Return<MetaEnvelope, ProviderFailure | GuardError, HttpClient.HttpClient> {
  if (!binding.active || binding.sent || binding.signal.aborted || options.abortSignal?.aborted || !optionsMatch(options, binding.request)) return yield* denied(binding.sent)
  const now = yield* Clock.currentTimeMillis
  const remaining = binding.call.intent.deadlineAt - now
  const overhead = new TextEncoder().encode(JSON.stringify({ format: "amuseme-meta-wire-v1", status: 599, requestId: "x".repeat(256), bodyBase64: "", complete: false })).length
  const bodyLimit = Math.floor((binding.call.intent.maxResponseBytes - overhead) / 4) * 3
  if (remaining <= 0 || bodyLimit <= 0 || Redacted.value(binding.credential).length === 0) return yield* denied()
  const client = yield* HttpClient.HttpClient
  const operation = Effect.gen(function* () {
    if (!binding.active || binding.sent || binding.signal.aborted || options.abortSignal?.aborted) return yield* denied(binding.sent)
    binding.sent = true
    const response = yield* client.execute(HttpClientRequest.post(metaEndpoint).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(binding.credential)}`),
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyText(stableJson(binding.request), "application/json"),
    )).pipe(Effect.mapError(() => new ProviderFailure({ certainty: "unknown", message: "Meta submission ended without a complete response" })))
    let requestId = safeRequestId(response.headers["x-request-id"])
    if (requestId !== null) yield* binding.call.submitted(requestId)
    const bytes = new Uint8Array(bodyLimit)
    let length = 0
    let complete = true
    yield* response.stream.pipe(Stream.runForEachWhile((chunk) => Effect.sync(() => {
      const count = Math.min(chunk.length, bodyLimit - length)
      bytes.set(chunk.subarray(0, count), length)
      length += count
      if (count < chunk.length) complete = false
      return complete
    })), Effect.mapError(() => new ProviderFailure({ certainty: "unknown", message: "Meta response was interrupted before completion" })))
    const envelope: MetaEnvelope = { format: "amuseme-meta-wire-v1", status: response.status, requestId, bodyBase64: Base64.encode(bytes.subarray(0, length)), complete }
    const parsed = readMetaMetadata(envelope)
    if (requestId === null && Result.isSuccess(parsed)) {
      requestId = safeRequestId(parsed.success.id)
      if (requestId !== null) yield* binding.call.submitted(requestId)
    }
    const usage = Result.isSuccess(parsed) ? parsed.success.usage : undefined
    binding.captured = {
      response: { ...envelope, requestId },
      usage: usage?.prompt_tokens !== undefined || usage?.completion_tokens !== undefined
        ? { _tag: "reported", inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null, costUsd: null }
        : { _tag: "unavailable", reason: "Meta did not report usable token counts" },
      actualCostMicrousd: null,
    }
    return { ...envelope, requestId }
  })
  return yield* operation.pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.timeoutOrElse({ duration: remaining, orElse: () => Effect.fail(new ProviderFailure({ certainty: "unknown", message: "Meta deadline elapsed; remote completion is unknown" })) }),
  )
})

const modelResult = (envelope: MetaEnvelope): Awaited<ReturnType<LanguageModelV2["doGenerate"]>> => {
  const parsed = readMetaCompletion(envelope)
  const completion = Result.isSuccess(parsed) ? parsed.success : undefined
  const choice = completion?.choices[0]
  const valid = envelope.complete && envelope.status >= 200 && envelope.status < 300 && completion?.choices.length === 1 && choice?.finish_reason === "stop" && !choice.message.refusal && (choice.message.tool_calls?.length ?? 0) === 0
  return {
    content: valid && choice?.message.content !== null && choice?.message.content !== undefined ? [{ type: "text", text: choice.message.content }] : [],
    finishReason: valid ? "stop" : "error",
    usage: { inputTokens: completion?.usage?.prompt_tokens, outputTokens: completion?.usage?.completion_tokens, totalTokens: undefined },
    warnings: [],
  }
}
const asStream = (result: Awaited<ReturnType<LanguageModelV2["doGenerate"]>>): Awaited<ReturnType<LanguageModelV2["doStream"]>> => ({
  stream: new ReadableStream<LanguageModelV2StreamPart>({ start(controller) {
    controller.enqueue({ type: "stream-start", warnings: [] })
    for (const part of result.content) {
      if (part.type !== "text") continue
      controller.enqueue({ type: "text-start", id: "meta-text" })
      controller.enqueue({ type: "text-delta", id: "meta-text", delta: part.text })
      controller.enqueue({ type: "text-end", id: "meta-text" })
    }
    controller.enqueue({ type: "finish", finishReason: result.finishReason, usage: result.usage })
    controller.close()
  } }),
})
export const makeMetaModel = (binding?: MetaBinding): LanguageModelV2 => {
  const generate = (options: LanguageModelV2CallOptions) => {
    if (binding === undefined) return Promise.reject(denied())
    const completion = binding.run(submit(binding, options), { signal: options.abortSignal === undefined ? binding.signal : AbortSignal.any([binding.signal, options.abortSignal]) }).then(modelResult)
    const settled = completion.then(() => undefined, () => undefined)
    binding.pending.add(settled)
    settled.then(() => binding.pending.delete(settled))
    return completion
  }
  return { specificationVersion: "v2", provider: "meta", modelId: "muse-spark-1.3", supportedUrls: { "image/*": [/^data:image\/(?:png|jpeg|webp);base64,/u] }, doGenerate: generate, doStream: (options) => generate(options).then(asStream) }
}
