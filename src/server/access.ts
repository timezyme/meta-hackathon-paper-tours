import { Effect, Schema } from "effect"
import { AuthService } from "../auth/index.ts"
import { authRoutes } from "../auth/routes.ts"
import { Session } from "../domain/api.ts"
import { documentRouteDefinitions } from "../mastra/document-routes.ts"
import { outputRouteDefinitions } from "../mastra/output-routes.ts"
import { isStudioInspectionRequest, studioInspectionRoutes } from "./studio-access.ts"

export const gatewayRoutes = [
  { method: "GET", path: "/health", access: "public" },
  { method: "GET", path: "/health/ready", access: "public" },
  ...authRoutes.map((route) => ({ method: route.method, path: `/auth${route.path}`, access: "public" as const })),
  { method: "GET", path: "/api/session", access: "session" },
  ...documentRouteDefinitions.map((route) => ({ method: route.method, path: route.path, access: "session" as const })),
  ...outputRouteDefinitions.map((route) => ({ method: route.method, path: route.path, access: "session" as const })),
  ...studioInspectionRoutes,
] as const

export const gatewayRouteIds = gatewayRoutes.map((route) => `route:${route.method}:${route.path}`)
const publicReads = new Set<string>(["/", "/sign-in", ...gatewayRoutes.filter((route) => route.method === "GET" && route.access === "public").map((route) => route.path)])
const publicWrites = new Set<string>(gatewayRoutes.filter((route) => route.method === "POST" && route.access === "public").map((route) => route.path))
const appAsset = /^\/app\/assets\/[A-Za-z0-9_-]+\.(?:css|js|svg|woff2|png|ico)$/u
const documentShell = /^\/documents\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u
const readMethods = new Set(["GET", "HEAD", "OPTIONS"])
const documentPatterns = [...documentRouteDefinitions, ...outputRouteDefinitions].map((route) => ({ method: route.method, path: new RegExp(`^${route.path.replace(/:[A-Za-z]+/gu, "[A-Za-z0-9][A-Za-z0-9_-]{0,127}")}$`, "u") }))

export const isDocumentRequest = (method: string, path: string) => documentPatterns.some((route) => route.method === method && route.path.test(path))

export const failureResponse = (status: number, code: string, message: string): Response => Response.json(
  { code, message },
  { status, headers: { "cache-control": "no-store" } },
)

export const isPublicRequest = (method: string, path: string): boolean => method === "GET"
  ? publicReads.has(path) || appAsset.test(path) || documentShell.test(path)
  : method === "POST" && publicWrites.has(path)

export const accessDecision = Effect.fnUntraced(function* (request: Request, origin: string) {
  const url = new URL(request.url)
  if (url.origin !== origin) return failureResponse(403, "forbidden", "Request origin is not allowed")
  const path = url.pathname
  if (isPublicRequest(request.method, path)) return null
  const auth = yield* AuthService
  const session = yield* auth.getSession(request.headers).pipe(Effect.timeout("5 seconds"))
  if (session === null) return failureResponse(401, "unauthenticated", "Sign in to continue")
  if (path === "/api/session" && request.method === "GET") {
    const payload = yield* Schema.encodeEffect(Session)(session)
    return Response.json(payload, { headers: { "cache-control": "no-store" } })
  }
  if (!readMethods.has(request.method)
    && (request.headers.get("origin") !== origin || request.headers.get("sec-fetch-site") === "cross-site")) {
    return failureResponse(403, "forbidden", "Same-origin request required")
  }
  if (isDocumentRequest(request.method, path)) return null
  if (session.user.role !== "admin") return failureResponse(403, "forbidden", "Administrator access required")
  if ((path === "/admin" || path.startsWith("/admin/")) && !isStudioInspectionRequest(request.method, path)) {
    return failureResponse(403, "forbidden", "Studio is available for inspection. Start document processing from AmuseMe.")
  }
  return null
}, (effect) => effect.pipe(
  Effect.catchTag("AuthError", () => Effect.succeed(failureResponse(503, "processing-unavailable", "Session service unavailable"))),
  Effect.catchTag("TimeoutError", () => Effect.succeed(failureResponse(503, "processing-unavailable", "Session service unavailable"))),
))

export const secureResponse = (response: Response, path: string, origin: string): Response => {
  const headers = new Headers(response.headers)
  headers.set("x-content-type-options", "nosniff")
  headers.set("referrer-policy", "no-referrer")
  headers.set("x-frame-options", "DENY")
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()")
  headers.set("content-security-policy", "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'")
  headers.delete("access-control-allow-origin")
  headers.delete("access-control-allow-credentials")
  headers.delete("x-powered-by")
  if (!appAsset.test(path) || response.status !== 200) headers.set("cache-control", "no-store")
  if (origin.startsWith("https:")) headers.set("strict-transport-security", "max-age=31536000")
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
