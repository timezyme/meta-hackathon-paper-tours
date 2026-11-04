import { Effect, Layer, Schema } from "effect"
import { Session, type SignInOptions } from "../domain/index.ts"
import { authOperation, makeAuth } from "./instance.ts"
import { AuthError, AuthService, type AuthOptions } from "./service.ts"
import { authRoutes } from "./routes.ts"
import { bufferAuthRequest } from "./request.ts"

export { AuthError, AuthService, type AuthOptions, type TrustedProxy } from "./service.ts"
export { provisionUser, type InviteUser } from "./provision.ts"
export type { JudgeSignInOptions } from "./judge.ts"

export const makeAuthLayer = (options: AuthOptions) => Layer.effect(AuthService, Effect.gen(function* () {
  const auth = yield* makeAuth(options)
  const getSession = Effect.fn("AuthService.getSession")(function* (headers: Headers) {
    const session = yield* authOperation("session", () => auth.api.getSession({ headers, query: { disableCookieCache: true } }))
    if (session === null) return null
    return yield* Schema.decodeUnknownEffect(Session)({ user: session.user }).pipe(
      Effect.mapError((cause) => new AuthError({ operation: "session", cause })),
    )
  })
  const signInOptions: SignInOptions = { method: options.judgeSignIn === undefined ? "password" : "email", accessCode: options.judgeSignIn?.accessCode != null }
  const handle = Effect.fn("AuthService.handle")(function* (request: Request) {
    const path = new URL(request.url).pathname
    const route = authRoutes.find((candidate) => candidate.method === request.method && `/auth${candidate.path}` === path)
    if (route === undefined || (route.judgeOnly && options.judgeSignIn === undefined)) return new Response(null, { status: 404 })
    if (route.id === "options") return Response.json(signInOptions, { headers: { "cache-control": "no-store" } })
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
