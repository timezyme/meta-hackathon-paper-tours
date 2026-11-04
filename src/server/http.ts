import type { Mastra } from "@mastra/core/mastra"
import { createHonoServer } from "@mastra/deployer/server"
import { Effect, Schema } from "effect"
import type { ManagedRuntime } from "effect"
import { Hono } from "hono"
import { AuthService } from "../auth/index.ts"
import { accessDecision, failureResponse, isDocumentRequest, isPublicRequest, secureResponse } from "./access.ts"

export class ServerError extends Schema.TaggedError<ServerError>()("ServerError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

export type ServerState = { phase: "starting" | "ready" | "draining" }

type InnerServer = Awaited<ReturnType<typeof createHonoServer>>

const nonPagePaths = ["/api", "/auth", "/app/assets", "/health", "/admin/api", "/admin/assets", "/admin/refresh-events", "/admin/__refresh", "/admin/__hot-reload-status"]

const servesPageShell = (request: Request, response: Response, origin: string): boolean => {
  const url = new URL(request.url)
  return [401, 403, 404].includes(response.status)
    && url.origin === origin
    && (request.method === "GET" || request.method === "HEAD")
    && request.headers.get("accept")?.includes("text/html") === true
    && !nonPagePaths.some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
}

const routeRequest = Effect.fnUntraced(function* (request: Request, inner: InnerServer, origin: string, state: ServerState) {
  const path = new URL(request.url).pathname
  const decision = yield* accessDecision(request, origin)
  if (decision !== null) return decision
  if (request.method === "GET" && path === "/health") return Response.json({ status: "alive" })
  if (request.method === "GET" && path === "/health/ready") {
    return Response.json({ status: state.phase }, { status: state.phase === "ready" ? 200 : 503 })
  }
  if (state.phase !== "ready") return failureResponse(503, "processing-unavailable", "Server is not accepting requests")
  if (path.startsWith("/auth/")) {
    if (!isPublicRequest(request.method, path)) return failureResponse(404, "not-found", "Not found")
    const auth = yield* AuthService
    return yield* auth.handle(request)
  }
  if (isPublicRequest(request.method, path) || isDocumentRequest(request.method, path) || path === "/admin" || path.startsWith("/admin/")) {
    return yield* Effect.tryPromise({
      try: () => Promise.resolve(inner.fetch(request)),
      catch: (cause) => new ServerError({ operation: "request", cause }),
    })
  }
  return failureResponse(404, "not-found", "Not found")
})

const dispatchRequest = Effect.fnUntraced(function* (request: Request, inner: InnerServer, origin: string, state: ServerState) {
  const response = yield* routeRequest(request, inner, origin, state)
  if (!servesPageShell(request, response, origin)) return response
  const shell = yield* Effect.tryPromise({
    try: () => Promise.resolve(inner.fetch(new Request(`${origin}/`, { signal: request.signal }))),
    catch: (cause) => new ServerError({ operation: "serve page shell", cause }),
  })
  return shell.status === 200 ? new Response(request.method === "HEAD" ? null : shell.body, { status: response.status, headers: shell.headers }) : response
}, (effect) => effect.pipe(
  Effect.catchTag("AuthError", () => Effect.succeed(failureResponse(503, "processing-unavailable", "Sign-in service unavailable"))),
  Effect.catchTag("SchemaError", (error) => Effect.logError("Invalid session response", error).pipe(Effect.as(failureResponse(500, "internal-error", "Request failed")))),
  Effect.catchTag("ServerError", (error) => Effect.logError("Server request failed", error).pipe(Effect.as(failureResponse(500, "internal-error", "Request failed")))),
  Effect.catchDefect((cause) => Effect.logError("Unexpected server failure", cause).pipe(Effect.as(failureResponse(500, "internal-error", "Request failed")))),
))

export const proxiedRequest = (request: Request, origin: string): Request => {
  const url = new URL(request.url)
  const configured = new URL(origin)
  if (configured.protocol !== "https:" || url.protocol !== "http:" || url.host !== configured.host) return request
  const body = request.method === "GET" || request.method === "HEAD" ? null : request.body
  return new Request(`${configured.origin}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body, signal: request.signal, ...(body === null ? {} : { duplex: "half" }) } as RequestInit)
}

export const createGuardedApp = Effect.fnUntraced(function* <R, E>(
  mastra: Mastra,
  runtime: ManagedRuntime.ManagedRuntime<AuthService | R, E>,
  origin: string,
  state: ServerState,
) {
  const inner = yield* Effect.tryPromise({
    try: () => createHonoServer(mastra, { studio: true, browserStream: false, tools: {}, isDev: false }),
    catch: (cause) => new ServerError({ operation: "create server", cause }),
  })
  const app = new Hono()
  app.all("*", (context) => runtime.runPromise(
    dispatchRequest(proxiedRequest(context.req.raw, origin), inner, origin, state).pipe(
      Effect.map((response) => secureResponse(response, new URL(context.req.url).pathname, origin)),
    ),
    { signal: context.req.raw.signal },
  ))
  return app
})
