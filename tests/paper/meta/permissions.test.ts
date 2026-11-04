import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { RequestContext } from "@mastra/core/request-context"
import type { AgentExecutionOptionsBase } from "@mastra/core/agent"
import { Effect, Redacted, Result } from "effect"
import { HttpClient } from "effect/http"
import { describe, expect, vi } from "vitest"
import { ProviderAdapter, ProviderGuard } from "../../../src/processing/index.ts"
import { makeMetaModel } from "../../../src/paper/providers/meta/transport.ts"
import { claim, registered, request, response, rows, runWith, settings, storeLayer, validators } from "./fixtures.ts"

const promise = <A>(work: () => PromiseLike<A> | A) => Effect.tryPromise({ try: () => Promise.resolve(work()), catch: () => "expected rejection" as const })
type Model = Extract<Awaited<ReturnType<ReturnType<typeof registered>["agents"]["page-check"]["getModel"]>>, { readonly specificationVersion: "v2" }>
type CallOptions = AgentExecutionOptionsBase<unknown> & { readonly structuredOutput?: never }
type Messages = Parameters<ReturnType<typeof registered>["agents"]["page-check"]["generate"]>[0]

describe("Meta agent permissions", () => {
  it.effect("allows metadata inspection but rejects missing and forged context including model overrides", () => Effect.gen(function* () {
    const boundary = registered()
    const override = makeMetaModel()
    const calls = vi.spyOn(override, "doGenerate")
    for (const agent of Object.values(boundary.agents)) {
      const metadata = yield* promise(() => agent.getModel())
      expect(metadata.provider).toBe("meta")
      expect(metadata.modelId).toBe("muse-spark-1.3")
      expect(Result.isFailure(yield* Effect.result(promise(() => override.doGenerate({ prompt: [] }))))).toBe(true)
      for (const context of [undefined, new RequestContext([["amusemeMetaPermit", {}]])]) {
        for (const method of ["generate", "stream"] as const) {
          const result = yield* Effect.result(promise<unknown>(() => agent[method]("unauthorized", { requestContext: context, model: override })))
          expect(Result.isFailure(result)).toBe(true)
        }
      }
    }
    expect(calls).toHaveBeenCalledTimes(4)
  }))

  it.effect("rejects cross-agent, serialized, spent and revoked permissions while permitting shallow identity copies", () => Effect.gen(function* () {
    const options = yield* settings
    const boundary = registered()
    const agent = boundary.agents["page-check"]
    const generate = agent.generate.bind(agent)
    let execution: { readonly messages: Messages; readonly options: CallOptions } | undefined
    vi.spyOn(agent, "generate").mockImplementation((messages, value?: CallOptions) => {
      execution = { messages, options: value ?? {} }
      return generate(messages, value ?? {})
    })
    let context: RequestContext | undefined
    let resolved: Model | undefined
    let sends = 0
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      const adapter = yield* runWith(boundary, HttpClient.make((req) => Effect.gen(function* () {
        sends += 1
        const invocation = execution
        const current = invocation?.options.requestContext
        if (invocation === undefined || current === undefined) return yield* Effect.die("Expected the actual agent invocation")
        context = current
        const model = yield* promise(() => agent.getModel({ requestContext: current }))
        if (model.specificationVersion === "v2") resolved = model
        const clone = new RequestContext()
        clone.setRaw("amusemeMetaPermit", current.getRaw("amusemeMetaPermit"))
        expect((yield* promise(() => agent.requestContextSchema?.["~standard"].validate(clone.all)))?.issues).toBeUndefined()
        const forged = new RequestContext([["amusemeMetaPermit", JSON.parse(JSON.stringify(current.getRaw("amusemeMetaPermit")))]])
        expect(Result.isFailure(yield* Effect.result(promise(() => agent.generate("forged", { requestContext: forged }))))).toBe(true)
        expect(Result.isFailure(yield* Effect.result(promise(() => boundary.agents.headings.generate("cross-agent", { requestContext: current }))))).toBe(true)
        expect(Result.isFailure(yield* Effect.result(promise(() => generate(invocation.messages, invocation.options))))).toBe(true)
        expect(Result.isFailure(yield* Effect.result(promise(() => agent.stream(invocation.messages, { ...invocation.options, requestContext: clone }).then((stream) => stream.getFullOutput()))))).toBe(true)
        return response(req)
      }).pipe(Effect.orDie)))
      yield* guard.execute(owned, yield* request()).pipe(Effect.provideService(ProviderAdapter, adapter))
      expect(sends).toBe(1)
      if (context === undefined || resolved === undefined) return yield* Effect.die("Expected a captured permission")
      const stale = context
      const model = resolved
      expect(Result.isFailure(yield* Effect.result(promise(() => agent.generate("stale", { requestContext: stale }))))).toBe(true)
      expect(Result.isFailure(yield* Effect.result(promise(() => model.doGenerate({ prompt: [] }))))).toBe(true)
      expect(sends).toBe(1)
    }).pipe(Effect.provide(storeLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  for (const alteration of ["prompt", "temperature", "schema"] as const) {
    it.effect(`rejects unexpected normalized ${alteration} before HTTP`, () => Effect.gen(function* () {
      const options = yield* settings
      const boundary = registered()
      const agent = boundary.agents["page-check"]
      const generate = agent.generate.bind(agent)
      vi.spyOn(agent, "generate").mockImplementation((messages, value?: CallOptions) => generate(alteration === "prompt" ? "altered" : messages, alteration === "temperature" ? { ...value, modelSettings: { ...value?.modelSettings, temperature: 0.5 } } : alteration === "schema" ? { ...value, providerOptions: { meta: { reasoningEffort: "high", responseFormat: "altered" } } } : value ?? {}))
      let sends = 0
      yield* Effect.gen(function* () {
        const owned = yield* claim()
        const guard = yield* ProviderGuard
        const adapter = yield* runWith(boundary, HttpClient.make((req) => Effect.sync(() => { sends += 1; return response(req) })))
        expect(Result.isFailure(yield* Effect.result(guard.execute(owned, yield* request()).pipe(Effect.provideService(ProviderAdapter, adapter))))).toBe(true)
        expect(sends).toBe(0)
        expect((yield* rows)[0]).toMatchObject({ status: "failed", actual_microusd: 0 })
      }).pipe(Effect.provide(storeLayer(options)))
    }).pipe(Effect.provide(NodeServices.layer)))
  }

  it.effect("keeps concurrent guarded calls isolated", () => Effect.gen(function* () {
    const options = yield* settings
    const boundary = registered()
    let sends = 0
    yield* Effect.gen(function* () {
      const owned = yield* claim()
      const guard = yield* ProviderGuard
      const adapter = yield* boundary.makeAdapter({ credential: Redacted.make("offline-secret"), validators }).pipe(Effect.provideService(HttpClient.HttpClient, HttpClient.make((req) => Effect.sync(() => { sends += 1; return response(req) }))))
      const results = yield* Effect.all([guard.execute(owned, yield* request()), guard.execute(owned, yield* request("headings"))], { concurrency: "unbounded" }).pipe(Effect.provideService(ProviderAdapter, adapter))
      expect(results.map((result) => result.receipt.stage).toSorted()).toEqual(["headings", "page-check"])
      expect(sends).toBe(2)
    }).pipe(Effect.provide(storeLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))
})
