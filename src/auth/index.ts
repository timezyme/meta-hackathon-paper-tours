import { Effect, Layer, Schema } from "effect"
import { Session } from "../domain/index.ts"
import { authOperation, makeAuth } from "./instance.ts"
import { AuthError, AuthService, type AuthOptions } from "./service.ts"
import { bufferAuthRequest } from "./request.ts"

export { AuthError, AuthService, type AuthOptions } from "./service.ts"
export { provisionUser, type InviteUser } from "./provision.ts"

export const makeAuthLayer = (options: AuthOptions) => Layer.effect(AuthService, Effect.gen(function* () {
  const auth = yield* makeAuth(options)
  const getSession = Effect.fn("AuthService.getSession")(function* (headers: Headers) {
    const session = yield* authOperation("session", () => auth.api.getSession({ headers, query: { disableCookieCache: true } }))
    if (session === null) return null
    return yield* Schema.decodeUnknownEffect(Session)({ user: session.user }).pipe(
      Effect.mapError((cause) => new AuthError({ operation: "session", cause })),
    )
  })
  const handle = Effect.fn("AuthService.handle")(function* (request: Request) {
    const path = new URL(request.url).pathname
    const allowed = (request.method === "POST" && (path === "/auth/sign-in/email" || path === "/auth/sign-out"))
      || (request.method === "GET" && path === "/auth/get-session")
    if (!allowed) return new Response(null, { status: 404 })
    if (request.method === "POST" && request.headers.get("origin") !== new URL(options.origin).origin) {
      return new Response(null, { status: 403 })
    }
    return yield* bufferAuthRequest(request).pipe(
      Effect.flatMap((buffered) => authOperation("request", () => auth.handler(buffered))),
      Effect.catchTag("AuthInputError", (error) => Effect.succeed(new Response(null, { status: error.status }))),
    )
  })
  return AuthService.of({ getSession, handle })
}))
