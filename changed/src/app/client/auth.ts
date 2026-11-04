import { Cause, Effect, Exit, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { Session, SignInOptions } from "../../domain/index.ts"

export type UserSession = typeof Session.Type

export class AuthFailure extends Schema.TaggedError<AuthFailure>()("AuthFailure", {
  kind: Schema.Literals(["transport", "rejected", "invalid-response"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
  status: Schema.optional(Schema.Number),
}) {}

const transportFailure = (cause: unknown) => new AuthFailure({ kind: "transport", message: "We couldn’t reach AmuseMe. Check your connection and try again.", cause })

export const readSession = Effect.gen(function* () {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient)
  const response = yield* client.get("/api/session").pipe(Effect.mapError(transportFailure))
  if (response.status === 401) return null
  if (response.status !== 200) return yield* new AuthFailure({ kind: "rejected", message: "We couldn’t check your session. Please try again.", status: response.status })
  const json = yield* response.json.pipe(Effect.mapError((cause) => new AuthFailure({ kind: "invalid-response", message: "AmuseMe returned an unreadable session. Please try again.", cause })))
  return yield* Schema.decodeUnknownEffect(Session)(json).pipe(Effect.mapError((cause) => new AuthFailure({ kind: "invalid-response", message: "AmuseMe returned an invalid session. Please try again.", cause })))
}).pipe(Effect.scoped)

const optionsUnavailable = "We couldn’t load the sign-in page. Please try again."
const unreadableOptions = (cause: unknown) =>
  new AuthFailure({ kind: "invalid-response", message: optionsUnavailable, cause })
export const readSignInOptions = Effect.gen(function* () {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient)
  const response = yield* client.get("/auth/sign-in-options").pipe(Effect.mapError(transportFailure))
  if (response.status !== 200) {
    return yield* new AuthFailure({ kind: "rejected", message: optionsUnavailable, status: response.status })
  }
  const json = yield* response.json.pipe(Effect.mapError(unreadableOptions))
  return yield* Schema.decodeUnknownEffect(SignInOptions)(json).pipe(Effect.mapError(unreadableOptions))
}).pipe(Effect.scoped)

const emailOnlyMessages: Record<number, string> = {
  400: "Enter a valid email address.",
  401: "That access code is not right. Check it and try again.",
  403: "This email already has a password. Sign in with the invited account instead.",
}

const postAuth = Effect.fn("postAuth")(function* (path: string, body: { readonly email: string; readonly password?: string; readonly accessCode?: string } | Record<string, never>) {
  const client = HttpClient.withScope(yield* HttpClient.HttpClient)
  const request = yield* HttpClientRequest.bodyJson(HttpClientRequest.post(path), body).pipe(Effect.mapError((cause) => new AuthFailure({ kind: "rejected", message: "The sign-in request could not be prepared.", cause })))
  const response = yield* client.execute(request).pipe(Effect.mapError(transportFailure))
  if (response.status >= 200 && response.status < 300) return
  const message = response.status === 429
    ? "Too many attempts. Please wait a minute before trying again."
    : path === "/auth/sign-in/email" && (response.status === 400 || response.status === 401)
      ? "The email or password is incorrect. Please try again."
      : path === "/auth/sign-in/judge" && emailOnlyMessages[response.status] !== undefined
        ? emailOnlyMessages[response.status] ?? ""
      : path === "/auth/sign-out"
        ? "We couldn’t sign you out. Please try again."
        : "We couldn’t sign you in. Please try again."
  return yield* new AuthFailure({ kind: "rejected", message, status: response.status })
}, Effect.scoped)

export const signIn = Effect.fn("signIn")(function* (email: string, password: string) {
  yield* postAuth("/auth/sign-in/email", { email, password })
  const session = yield* readSession
  if (session === null) return yield* new AuthFailure({ kind: "rejected", message: "Your session could not be confirmed. Please sign in again." })
  return session
})

export const signInWithEmail = Effect.fn("signInWithEmail")(function* (email: string, accessCode: string | null) {
  yield* postAuth("/auth/sign-in/judge", accessCode === null ? { email } : { email, accessCode })
  const session = yield* readSession
  if (session === null) return yield* new AuthFailure({ kind: "rejected", message: "Your session could not be confirmed. Please try again." })
  return session
})

export const signOut = postAuth("/auth/sign-out", {})

export const runAuth = <A>(
  program: Effect.Effect<A, AuthFailure, HttpClient.HttpClient>,
  onSuccess: (value: A) => void,
  onFailure: (error: AuthFailure) => void,
): (() => void) => Effect.runCallback(program.pipe(
  Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(new AuthFailure({ kind: "transport", message: "AmuseMe took too long to respond. Please try again." })) }),
  Effect.provide(FetchHttpClient.layer),
  Effect.provideService(FetchHttpClient.RequestInit, { credentials: "same-origin", cache: "no-store", redirect: "error" }),
  Effect.match({ onSuccess, onFailure }),
), {
  onExit: (exit) => {
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
      onFailure(new AuthFailure({ kind: "invalid-response", message: "Something unexpected happened. Please reload AmuseMe." }))
    }
  },
})
