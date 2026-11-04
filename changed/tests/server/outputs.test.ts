import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { AuthService } from "../../src/auth/index.ts"
import { Session } from "../../src/domain/index.ts"
import { OutputHandler, type OutputOperation } from "../../src/server/outputs.ts"
import { OutputStore, makeDocumentStoreLayer } from "../../src/storage/index.ts"
import { directory, owner, other, setup, text } from "../fixtures/published-output.ts"

const origin = "http://127.0.0.1:4183"
const session = (id: string) => Schema.decodeUnknownSync(Session)({ user: { id, role: "user", email: "reader@example.test" } })
const fixture = Effect.fnUntraced(function* (dataDirectory: string, read?: OutputStore["Service"]["read"]) {
  const state = yield* setup(dataDirectory)
  yield* state.outputs.publish(state.claim, state.publication)
  const auth = AuthService.of({
    getSession: (headers) => Effect.succeed(headers.get("cookie") === "owner" ? session(owner) : headers.get("cookie") === "other" ? session(other) : null),
    handle: () => Effect.succeed(new Response(null, { status: 404 })),
  })
  const handler = yield* OutputHandler.pipe(Effect.provide(OutputHandler.layer(origin).pipe(Layer.provide(Layer.merge(Layer.succeed(AuthService, auth), Layer.succeed(OutputStore, read === undefined ? state.outputs : { ...state.outputs, read }))))))
  const request = (operation: OutputOperation, options: RequestInit = {}, revision = "output-1") => handler.handle(operation,
    new Request(`${origin}/api/documents/${state.claim.document.id}/outputs/${revision}/text`, { ...options, headers: { cookie: "owner", ...options.headers } }), state.claim.document.id, revision)
  return { ...state, request }
})

describe("owner output HTTP operations", () => {
  it.effect("downloads exact published bytes and round-trips one replaceable rating", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const { request, publication, claim } = yield* fixture(options.dataDirectory)
      const response = yield* request("text")
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-store")
      const textName = `amuseme-${claim.document.id.slice(0, 8)}.txt`
      expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${textName}"`)
      expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(text)
      const files = [
        ["canonical", publication.canonical, "document.json"], ["report", publication.report, "processing-report.json"],
      ] as const
      for (const [operation, expected, filename] of files) {
        const result = yield* request(operation)
        expect(result.headers.get("content-disposition")).toBe(`attachment; filename="${filename}"`)
        expect(yield* Effect.promise(() => result.json())).toEqual(expected)
      }
      for (const value of ["up", "down"] as const) {
        expect((yield* request("rate", { method: "PUT", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ value }) })).status).toBe(200)
        const saved = yield* request("readRating")
        expect(yield* Effect.promise(() => saved.json())).toEqual({ value })
      }
      expect((yield* request("clearRating", { method: "DELETE", headers: { origin } })).status).toBe(204)
      const cleared = yield* request("readRating")
      expect(yield* Effect.promise(() => cleared.json())).toEqual({ value: null })
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.live("cancels a ZIP producer when the HTTP request is aborted", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      let finalized = false
      const { request, claim } = yield* fixture(options.dataDirectory, () => Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        return yield* Effect.never
      }).pipe(Effect.ensuring(Effect.sync(() => { finalized = true }))))
      const controller = new AbortController()
      const response = yield* request("zip", { signal: controller.signal })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("application/zip")
      expect(response.headers.get("content-disposition")).toBe(`attachment; filename="amuseme-${claim.document.id.slice(0, 8)}.zip"`)
      const body = yield* Effect.tryPromise(() => response.arrayBuffer()).pipe(Effect.result, Effect.forkChild)
      yield* Deferred.await(started)
      controller.abort()
      expect((yield* Fiber.join(body))._tag).toBe("Failure")
      expect(finalized).toBe(true)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects missing sessions, foreign revisions, cross-origin writes and malformed ratings", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const { request, documents, claim } = yield* fixture(options.dataDirectory)
      expect((yield* request("text", { headers: { cookie: "none" } })).status).toBe(401)
      expect((yield* request("text", { headers: { cookie: "other" } })).status).toBe(404)
      expect((yield* request("text", {}, "another-revision")).status).toBe(404)
      expect((yield* request("text", {}, "../source")).status).toBe(400)
      expect((yield* request("rate", { method: "PUT", headers: { origin: "https://elsewhere.test", "content-type": "application/json" }, body: '{"value":"up"}' })).status).toBe(403)
      for (const body of ['{"value":"bad"}', "{", JSON.stringify({ value: "up", padding: "x".repeat(1024) })]) {
        expect((yield* request("rate", { method: "PUT", headers: { origin, "content-type": "application/json" }, body })).status).toBe(400)
      }
      expect((yield* request("rate", { method: "GET" })).status).toBe(404)
      yield* documents.delete(owner, claim.document.id)
      expect((yield* request("text")).status).toBe(404)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("lets every signed-in reader download a shared example while ratings stay with each owner", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const { request, publication, documents, claim } = yield* fixture(options.dataDirectory)
      const asOther = { headers: { cookie: "other" } }
      const response = yield* request("text", asOther)
      expect(response.status).toBe(200)
      expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(text)
      const canonical = yield* request("canonical", asOther)
      expect(yield* Effect.promise(() => canonical.json())).toEqual(publication.canonical)
      expect((yield* request("report", asOther)).status).toBe(200)
      expect((yield* request("zip", asOther)).status).toBe(200)
      expect((yield* request("rate", { method: "PUT", headers: { origin, "content-type": "application/json" }, body: '{"value":"up"}' })).status).toBe(200)
      const otherRating = yield* request("readRating", asOther)
      expect(yield* Effect.promise(() => otherRating.json())).toEqual({ value: null })
      expect((yield* request("rate", { method: "PUT", headers: { cookie: "other", origin, "content-type": "application/json" }, body: '{"value":"down"}' })).status).toBe(404)
      expect((yield* request("clearRating", { method: "DELETE", headers: { cookie: "other", origin } })).status).toBe(404)
      const ownerRating = yield* request("readRating")
      expect(yield* Effect.promise(() => ownerRating.json())).toEqual({ value: "up" })
      yield* documents.delete(owner, claim.document.id)
      expect((yield* request("text", asOther)).status).toBe(404)
    }).pipe(Effect.provide(makeDocumentStoreLayer({ ...options, examplesOwnerId: owner })))
  }).pipe(Effect.provide(NodeServices.layer)))
})
