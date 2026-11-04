import { describe, expect, it } from "@effect/vitest"
import { Effect, Result } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Hono } from "hono"
import { openListener } from "../../src/server/lifecycle.ts"
import type { ServerState } from "../../src/server/http.ts"

describe("HTTP listener scope", () => {
  it.effect("binds loopback, serves real HTTP, and closes the socket when the scope ends", () => Effect.gen(function* () {
    const state: ServerState = { phase: "starting" }
    const address = yield* Effect.gen(function* () {
      const app = new Hono().get("/probe", (context) => context.json({ ok: true }))
      const listener = yield* openListener(app, 0, state)
      const bound = listener.address()
      if (bound === null || typeof bound === "string") return yield* Effect.die("Expected TCP address")
      expect(bound.address).toBe("127.0.0.1")
      expect(state.phase).toBe("ready")
      const url = `http://127.0.0.1:${bound.port}/probe`
      const response = yield* HttpClient.get(url)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ ok: true })
      return url
    }).pipe(Effect.scoped)
    expect(state.phase).toBe("draining")
    expect(Result.isFailure(yield* Effect.result(HttpClient.get(address)))).toBe(true)
  }).pipe(Effect.provide(FetchHttpClient.layer)))

  it.effect("reports an occupied port and preserves the existing listener", () => Effect.gen(function* () {
    const app = new Hono().get("/probe", (context) => context.text("ready"))
    const state: ServerState = { phase: "starting" }
    const first = yield* openListener(app, 0, state)
    const bound = first.address()
    if (bound === null || typeof bound === "string") return yield* Effect.die("Expected TCP address")
    const second = yield* Effect.result(openListener(app, bound.port, { phase: "starting" }).pipe(Effect.scoped))
    expect(Result.isFailure(second)).toBe(true)
    if (Result.isFailure(second)) expect(second.failure.operation).toBe("listen")
    expect((yield* HttpClient.get(`http://127.0.0.1:${bound.port}/probe`)).status).toBe(200)
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)))
})
