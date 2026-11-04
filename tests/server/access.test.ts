import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Mastra } from "@mastra/core/mastra"
import { createHonoServer } from "@mastra/deployer/server"
import { Effect, FileSystem, Layer, ManagedRuntime, Schema } from "effect"
import { AuthError, AuthService } from "../../src/auth/index.ts"
import { Session } from "../../src/domain/api.ts"
import { makeAmuseMe } from "../../src/mastra/amuseme.ts"
import { createGuardedApp, proxiedRequest } from "../../src/server/http.ts"
import { isStudioInspectionRequest } from "../../src/server/studio-access.ts"

const origin = "http://127.0.0.1:4183"
const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped()
  yield* fs.makeDirectory(`${directory}/assets`)
  yield* fs.writeFileString(`${directory}/index.html`, "<!doctype html><title>AmuseMe</title><main>Sign in</main>")
  yield* fs.writeFileString(`${directory}/assets/app-test.js`, "export {}")
  yield* fs.writeFileString(`${directory}/assets/mark-test.svg`, "<svg></svg>")
  yield* fs.writeFileString(`${directory}/assets/font-test.woff2`, "fixture")
  const user = yield* Schema.decodeUnknownEffect(Session)({ user: { id: "user_a", email: "user@example.test", role: "user" } })
  const admin = yield* Schema.decodeUnknownEffect(Session)({ user: { id: "admin_a", email: "admin@example.test", role: "admin" } })
  const runtime = yield* Effect.acquireRelease(
    Effect.sync(() => ManagedRuntime.make(Layer.succeed(AuthService, AuthService.of({
      getSession: (headers) => headers.get("cookie") === "session=admin" ? Effect.succeed(admin)
        : headers.get("cookie") === "session=user" ? Effect.succeed(user)
        : headers.get("cookie") === "session=failed" ? Effect.fail(new AuthError({ operation: "session", cause: "unavailable" }))
        : Effect.succeed(null),
      handle: () => Effect.succeed(Response.json({ auth: true })),
    })))),
    (managed) => managed.disposeEffect,
  )
  const mastra = yield* Effect.acquireRelease(
    Effect.sync(() => new Mastra(makeAmuseMe(4183, { appDirectory: directory }))),
    (instance) => Effect.promise(() => instance.shutdown()),
  )
  const state = { phase: "ready" as "starting" | "ready" | "draining" }
  const app = yield* createGuardedApp(mastra, runtime, origin, state)
  const request = (path: string, options?: RequestInit) => Effect.promise(() => Promise.resolve(app.request(`${origin}${path}`, options)))
  return { app, mastra, request, user, admin, state }
})

describe("guarded Mastra HTTP surface", () => {
  it.effect("serves only explicit public methods and paths without a session", () => Effect.gen(function* () {
    const { request } = yield* makeFixture
    for (const path of ["/", "/sign-in", "/documents/doc_123", "/app/assets/app-test.js", "/app/assets/mark-test.svg", "/app/assets/font-test.woff2", "/health", "/health/ready", "/auth/get-session"]) {
      expect((yield* request(path)).status, path).toBe(200)
    }
    for (const path of ["/auth/sign-in/email", "/auth/sign-out"]) {
      expect((yield* request(path, { method: "POST" })).status).toBe(200)
    }
    for (const path of ["/", "/sign-in", "/health", "/app/assets/app-test.js", "/auth/get-session"]) {
      for (const method of ["HEAD", "OPTIONS", "POST"]) expect((yield* request(path, { method })).status, `${method} ${path}`).toBe(401)
    }
    expect((yield* request("/app/assets/missing.js")).status).toBe(404)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("returns a validated product session and separates failed from absent sessions", () => Effect.gen(function* () {
    const { request, user, admin } = yield* makeFixture
    expect((yield* request("/api/session")).status).toBe(401)
    expect((yield* request("/api/session", { headers: { cookie: "session=expired" } })).status).toBe(401)
    expect((yield* request("/api/session", { headers: { cookie: "session=failed" } })).status).toBe(503)
    for (const [role, expected] of [["user", user], ["admin", admin]] as const) {
      const response = yield* request("/api/session", { headers: { cookie: `session=${role}` } })
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toEqual(expected)
      expect(response.headers.get("cache-control")).toBe("no-store")
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("denies every installed framework route to anonymous and ordinary users", () => Effect.gen(function* () {
    const { request, mastra } = yield* makeFixture
    const factory = yield* Effect.promise(() => createHonoServer(mastra, { studio: true, browserStream: false, tools: {}, isDev: false }))
    const routes = factory.routes.filter((route) => route.path.startsWith("/admin"))
    expect(routes.length).toBeGreaterThan(100)
    for (const route of routes) {
      const path = route.path.replace(/:[A-Za-z][A-Za-z0-9_]*/gu, "fixture").replaceAll("*", "fixture")
      const method = route.method === "ALL" ? "GET" : route.method
      for (const role of ["anonymous", "user"] as const) {
        const response = yield* request(path, {
          method,
          headers: { cookie: `session=${role}`, "x-mastra-client-type": "studio", origin },
        })
        expect(response.status, `${role} ${method} ${path}`).toBe(role === "anonymous" ? 401 : 403)
      }
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("protects aliases, assets, unknown paths, and path encodings", () => Effect.gen(function* () {
    const { request } = yield* makeFixture
    for (const path of ["/admin", "/admin/", "/admin/assets/index.js", "/admin/api/agents", "/admin/api/agents/fixture/browser/session", "/api/agents", "/swagger-ui", "/openapi.json", "/auth/sign-up/email", "/auth/admin/create-user", "/__refresh", "/refresh-events", "/does-not-exist", "/%61dmin", "/admin%2fapi%2fagents", "/%68ealth", "/app/assets/%61pp-test.js", "/documents/doc%2f123"]) {
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
        expect((yield* request(path, { method, headers: { "x-mastra-client-type": "studio", "x-user-role": "admin" } })).status, `${method} ${path}`).toBe(401)
        expect((yield* request(path, { method, headers: { cookie: "session=user", "x-mastra-client-type": "studio", "x-user-role": "admin" } })).status, `${method} ${path}`).toBe(403)
      }
    }
    expect((yield* request("/api/agents", { headers: { cookie: "session=admin" } })).status).toBe(404)
    expect((yield* request("/does-not-exist", { headers: { cookie: "session=admin" } })).status).toBe(404)
    expect((yield* request("/api/documents", { headers: { cookie: "session=user" } })).status).toBe(503)
    for (const method of ["HEAD", "OPTIONS", "PUT", "DELETE"]) {
      expect((yield* request("/api/documents", { method, headers: { cookie: "session=user", origin } })).status).toBe(403)
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("denies generic execution and every unlisted framework API even for an administrator", () => Effect.gen(function* () {
    const { request, mastra } = yield* makeFixture
    const factory = yield* Effect.promise(() => createHonoServer(mastra, { studio: true, browserStream: false, tools: {}, isDev: false }))
    let denied = 0
    for (const route of factory.routes.filter((entry) => entry.path.startsWith("/admin/api/"))) {
      const path = route.path.replace(/:[A-Za-z][A-Za-z0-9_]*/gu, "fixture").replaceAll("*", "fixture")
      const method = route.method === "ALL" ? "POST" : route.method
      if (isStudioInspectionRequest(method, path)) continue
      const response = yield* request(path, { method, headers: { cookie: "session=admin", origin, "content-type": "application/json" },
        ...(method === "GET" || method === "HEAD" ? {} : { body: JSON.stringify({ model: "openai/override", requestContext: { authorized: true }, structuredOutput: { model: "openai/override" } }) }),
      })
      expect(response.status, `${method} ${path}`).toBe(403)
      denied += 1
    }
    expect(denied).toBeGreaterThan(400)
    for (const path of ["/admin/%61pi/agents/fixture/browser/session", "/admin/api/memory/search", "/admin/api/new-provider-feature"]) {
      expect((yield* request(path, { headers: { cookie: "session=admin", origin } })).status, path).toBe(403)
    }
    for (const path of ["/admin/api/agents/fixture/model", "/admin/api/workflows/fixture/restart", "/admin/api/v1/responses"]) {
      expect((yield* request(path, { method: "POST", headers: { cookie: "session=admin", origin } })).status, path).toBe(403)
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("permits actual admin reads and requires same-origin mutations", () => Effect.gen(function* () {
    const { request } = yield* makeFixture
    for (const path of ["/admin/api/agents", "/admin/api/workflows", "/admin/api/tools"]) {
      expect((yield* request(path, { headers: { cookie: "session=admin" } })).status, path).toBe(200)
    }
    for (const headers of [
      { cookie: "session=admin" },
      { cookie: "session=admin", origin: "https://evil.example" },
      { cookie: "session=admin", origin, "sec-fetch-site": "cross-site" },
      { cookie: "session=admin", "x-forwarded-host": "127.0.0.1:4183", "x-forwarded-proto": "http", origin: "https://evil.example" },
    ]) expect((yield* request("/admin/__refresh", { method: "POST", headers })).status).toBe(403)
    expect((yield* request("/admin/__refresh", { method: "POST", headers: { cookie: "session=admin", origin } })).status).toBe(200)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("serves the public product shell for denied and unknown page navigations while preserving HTTP status and API JSON", () => Effect.gen(function* () {
    const { request } = yield* makeFixture
    const missing = yield* request("/does-not-exist", { headers: { cookie: "session=admin", accept: "text/html" } })
    expect(missing.status).toBe(404)
    expect(yield* Effect.promise(() => missing.text())).toContain("<title>AmuseMe</title>")
    for (const role of ["anonymous", "user"] as const) {
      const headers = { cookie: `session=${role}`, accept: "text/html" }
      for (const path of ["/admin", "/admin/", "/admin/agents", "/nope", "/library"]) {
        const response = yield* request(path, { headers })
        expect(response.status).toBe(role === "anonymous" ? 401 : 403)
        expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
        expect(yield* Effect.promise(() => response.text())).toContain("<title>AmuseMe</title>")
      }
      const head = yield* request("/admin/", { method: "HEAD", headers })
      expect(head.status).toBe(role === "anonymous" ? 401 : 403)
      expect(yield* Effect.promise(() => head.text())).toBe("")
      for (const path of ["/admin/api/agents", "/admin/assets/index.js", "/admin/refresh-events", "/admin/__hot-reload-status", "/api/agents"]) {
        const response = yield* request(path, { headers })
        expect(response.status).toBe(role === "anonymous" ? 401 : 403)
        expect(response.headers.get("content-type")).toContain("application/json")
      }
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("adds security headers, rejects untrusted hosts, and reports draining readiness", () => Effect.gen(function* () {
    const { request, app, state } = yield* makeFixture
    const response = yield* request("/")
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("x-frame-options")).toBe("DENY")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect((yield* request("/app/assets/app-test.js")).headers.get("cache-control")).toContain("immutable")
    const forged = yield* Effect.promise(() => Promise.resolve(app.request("http://evil.example/", { headers: { "x-forwarded-host": "127.0.0.1:4183", "x-forwarded-proto": "http" } })))
    expect(forged.status).toBe(403)
    state.phase = "draining"
    expect((yield* request("/health")).status).toBe(200)
    expect((yield* request("/health/ready")).status).toBe(503)
    expect((yield* request("/")).status).toBe(503)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("maps TLS-proxied requests for the configured HTTPS host only", () => Effect.gen(function* () {
    const deployed = "https://amuseme--web.modal.run"
    const mapped = proxiedRequest(new Request("http://amuseme--web.modal.run/auth/sign-in/judge?x=1", { method: "POST", headers: { origin: deployed }, body: '{"email":"judge@example.test"}' }), deployed)
    expect(mapped.url).toBe(`${deployed}/auth/sign-in/judge?x=1`)
    expect(mapped.headers.get("origin")).toBe(deployed)
    expect(yield* Effect.promise(() => mapped.text())).toBe('{"email":"judge@example.test"}')
    for (const url of ["http://elsewhere.modal.run/", "http://amuseme--web.modal.run:8000/"]) expect(proxiedRequest(new Request(url), deployed).url).toBe(url)
    const local = new Request(`${origin}/`)
    expect(proxiedRequest(local, origin)).toBe(local)
  }))
})
