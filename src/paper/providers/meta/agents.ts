import { Agent } from "@mastra/core/agent"
import { RequestContext } from "@mastra/core/request-context"
import { Effect, Predicate, Redacted, Schema } from "effect"
import { HttpClient } from "effect/http"
import { z } from "zod"
import { ProviderAdapter, ProviderFailure, type ProviderCall } from "../../../processing/contracts.ts"
import { decodeMetaOutput, invalidMeta, metaEffort, MetaRequest, stableJson, strictSchema, type MetaStage, type MetaStageSpecs, type MetaValidators } from "./contracts.ts"
import { makeMetaModel, metaProviderOptions, type MetaBinding } from "./transport.ts"

const permitKey = "amusemeMetaPermit"
export const makeMetaAgentBoundary = (supplied: MetaStageSpecs) => {
  const copy = (stage: MetaStage) => ({ ...supplied[stage], schema: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(stableJson(supplied[stage].schema)) })
  const specs: MetaStageSpecs = { extraction: copy("extraction"), "page-check": copy("page-check"), headings: copy("headings"), figures: copy("figures") }
  const permits = new WeakMap<object, MetaBinding>()
  const models = new WeakMap<object, ReturnType<typeof makeMetaModel>>()
  const metadataModel = makeMetaModel()
  const permitted = (stage: MetaStage, value: unknown) => {
    if (!Predicate.isObject(value)) return false
    const binding = permits.get(value)
    return binding !== undefined && binding.active && !binding.signal.aborted && binding.stage === stage
  }
  const createAgent = (stage: MetaStage) => {
    const permission = Schema.Unknown.check(Schema.makeFilter((value) => permitted(stage, value) || "A current guarded Meta call is required"))
    return new Agent({
      id: stage, name: `AmuseMe ${stage}`, instructions: specs[stage].instructions,
      description: "Document normalization through the durable processing guard",
      model: ({ requestContext }) => {
        const token = requestContext.getRaw(permitKey)
        return Predicate.isObject(token) && permitted(stage, token) ? models.get(token) ?? metadataModel : metadataModel
      },
      requestContextSchema: z.object({ amusemeMetaPermit: z.unknown().refine(Schema.is(permission), "A current guarded Meta call is required") }),
      maxRetries: 0, maxProcessorRetries: 0,
      defaultOptions: { maxSteps: 1, modelSettings: { maxRetries: 0 }, maxProcessorRetries: 0, activeTools: [], toolChoice: "none" },
    })
  }
  const agents = { extraction: createAgent("extraction"), "page-check": createAgent("page-check"), headings: createAgent("headings"), figures: createAgent("figures") }
  const makeAdapter = Effect.fn("makeMetaAdapter")(function* (options: {
    readonly credential: Redacted.Redacted<string>
    readonly validators: MetaValidators
    readonly getAgent?: (stage: MetaStage) => typeof agents[MetaStage]
  }) {
    const context = yield* Effect.context<HttpClient.HttpClient>()
    const run = Effect.runPromiseWith(context)
    const invoke = Effect.fn("MetaAdapter.invoke")(function* (call: ProviderCall) {
      const stage = call.receipt.stage
      const spec = specs[stage]
      const request = yield* Schema.decodeUnknownEffect(MetaRequest)(call.intent.request, { onExcessProperty: "error" }).pipe(Effect.mapError(() => new ProviderFailure({ certainty: "not-submitted", message: "The Meta request is invalid" })))
      const saved = call.receipt.configuration
      const configuration = stage === "extraction" ? saved._tag === "extraction" && saved.provider === "meta" && saved.version === request.model ? saved.model : undefined : saved._tag === "model" ? saved : undefined
      if (configuration === undefined || configuration.provider !== "meta" || configuration.model !== request.model || configuration.reasoning !== request.reasoning_effort || request.reasoning_effort !== metaEffort(stage) || configuration.maxOutputTokens !== request.max_completion_tokens || call.intent.maxOutputTokens !== request.max_completion_tokens || configuration.promptName !== spec.promptName || configuration.promptVersion !== spec.promptVersion || request.messages[0].content !== spec.instructions || request.response_format.json_schema.name !== spec.promptName || stableJson(request.response_format.json_schema.schema) !== stableJson(spec.schema) || !strictSchema(spec.schema) || call.intent.clientIdempotencyKey !== null || request.messages[1].content.filter((part) => part.type === "image_url").length > 50) {
        return yield* new ProviderFailure({ certainty: "not-submitted", message: "The Meta request does not match its authorized stage" })
      }
      const token = {}
      let binding: MetaBinding | undefined
      let controller: AbortController | undefined
      const requestContext = new RequestContext()
      const agent = options.getAgent?.(stage) ?? agents[stage]
      const stopped = () => new ProviderFailure({ certainty: binding?.sent ? "unknown" : "not-submitted", message: binding?.sent ? "Meta execution ended without a complete response" : "The guarded Meta agent rejected the request" })
      const result = yield* Effect.result(Effect.callback<void, ProviderFailure>((resume) => {
        controller = new AbortController()
        const signal = controller.signal
        binding = { stage, call, request, credential: options.credential, run, signal, active: true, sent: false, captured: null, pending: new Set() }
        permits.set(token, binding)
        models.set(token, makeMetaModel(binding))
        requestContext.setRaw(permitKey, token)
        const completion = run(Effect.tryPromise({ try: () => agent.generate([{ role: "user", content: request.messages[1].content.map((part) => part.type === "text" ? { type: "text" as const, text: part.text } : { type: "image" as const, image: part.image_url.url, mediaType: part.image_url.url.slice(5, part.image_url.url.indexOf(";")) }) }], {
          requestContext, maxSteps: 1, maxProcessorRetries: 0, activeTools: [], toolChoice: "none", abortSignal: signal,
          runId: call.attemptId,
          tracingOptions: { metadata: { documentId: call.receipt.scope.documentId, documentRunId: call.receipt.scope.runId, providerAttemptId: call.attemptId, resourceId: call.receipt.ownerId }, hideInput: true, hideOutput: true },
          modelSettings: { maxRetries: 0, maxOutputTokens: request.max_completion_tokens },
          providerOptions: metaProviderOptions(request),
        }), catch: stopped }))
        completion.then(() => resume(Effect.void), () => resume(Effect.fail(stopped())))
        return Effect.sync(() => { if (binding !== undefined) binding.active = false; controller?.abort() }).pipe(
          Effect.andThen(Effect.promise(() => completion.then(() => undefined, () => undefined))),
        )
      }).pipe(Effect.ensuring(Effect.sync(() => {
        if (binding !== undefined) binding.active = false
        controller?.abort()
        permits.delete(token)
        models.delete(token)
      }).pipe(Effect.andThen(Effect.promise(() => Promise.all(binding?.pending ?? [])))))))
      if (binding?.captured !== null && binding?.captured !== undefined) return binding.captured
      if (result._tag === "Failure") return yield* result.failure
      return yield* new ProviderFailure({ certainty: binding?.sent ? "unknown" : "not-submitted", message: "The Meta agent returned no captured provider response" })
    })
    const validate = Effect.fn("MetaAdapter.validate")(function* (response: Schema.Json, receipt: ProviderCall["receipt"]) {
      const saved = receipt.configuration
      const configuration = receipt.stage === "extraction" ? saved._tag === "extraction" && saved.provider === "meta" && saved.version === "muse-spark-1.3" ? saved.model : undefined : saved._tag === "model" ? saved : undefined
      const spec = specs[receipt.stage]
      if (configuration === undefined || configuration.provider !== "meta" || configuration.model !== "muse-spark-1.3" || configuration.reasoning !== metaEffort(receipt.stage) || configuration.promptName !== spec.promptName || configuration.promptVersion !== spec.promptVersion) return yield* invalidMeta()
      yield* options.validators[receipt.stage](yield* decodeMetaOutput(response), receipt)
    })
    return ProviderAdapter.of({ invoke, validate })
  })
  return { agents, makeAdapter }
}
