import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Redacted } from "effect"
import { AuthService, makeAuthLayer, provisionUser, type AuthOptions } from "../../src/auth/index.ts"
import { authOperation, makeAuth } from "../../src/auth/instance.ts"

const secret = Redacted.make("fixture-only-judge-signing-secret-32-characters")
const fixture = Effect.fnUntraced(function* (judgeSignIn?: AuthOptions["judgeSignIn"]) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-judge-" })
  return { origin: "http://127.0.0.1:4180", secret, databasePath: path.join(root, "private", "auth.sqlite"), judgeSignIn } satisfies AuthOptions
})
const post = (options: AuthOptions, path: string, body: object, headers: Record<string, string> = {}) =>
  new Request(`${options.origin}${path}`, {
    method: "POST", headers: { origin: options.origin, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
const cookies = (response: Response) => response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ")
const judge = (auth: AuthService["Service"], options: AuthOptions, body: object) => auth.handle(post(options, "/auth/sign-in/judge", body))
const signInsFrom = (
  auth: AuthService["Service"], options: AuthOptions, forwarded: string | undefined, count: number, from = 0,
) => Effect.forEach(Array.from({ length: count }, (_, index) => from + index), (attempt) => auth.handle(post(
  options, "/auth/sign-in/judge", { email: `judge${attempt}@example.test` },
  forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
)).pipe(Effect.map((response) => response.status)))
const allowed = (statuses: ReadonlyArray<number>) => statuses.length > 0 && statuses.every((status) => status === 200)
const signInOptions = (auth: AuthService["Service"], options: AuthOptions) => auth.handle(new Request(`${options.origin}/auth/sign-in-options`)).pipe(
  Effect.flatMap((response) => Effect.promise(() => response.json())),
)

describe("email-only judge sign-in", () => {
  it.effect("is off by default: the endpoint is absent and the page asks for a password", () => Effect.gen(function* () {
    const options = yield* fixture()
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      expect(yield* signInOptions(auth, options)).toEqual({ method: "password", accessCode: false })
      const response = yield* judge(auth, options, { email: "judge@example.test" })
      expect(response.status).toBe(404)
      expect(cookies(response)).toBe("")
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("creates a normalized user-role account once and signs the same account in again", () => Effect.gen(function* () {
    const options = yield* fixture({ accessCode: null })
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      expect(yield* signInOptions(auth, options)).toEqual({ method: "email", accessCode: false })
      const first = yield* judge(auth, options, { email: "  Judge@Example.TEST ", role: "admin", name: "Admin" })
      expect(first.status).toBe(200)
      expect(cookies(first)).toContain("better-auth.session_token=")
      const session = yield* auth.getSession(new Headers({ cookie: cookies(first) }))
      expect(session?.user).toMatchObject({ email: "judge@example.test", role: "user" })
      const again = yield* judge(auth, options, { email: "judge@example.test" })
      expect((yield* auth.getSession(new Headers({ cookie: cookies(again) })))?.user.id).toBe(session?.user.id)
      const signup = yield* auth.handle(post(options, "/auth/sign-up/email", { email: "new@example.test", name: "New", password: "a-long-enough-password" }))
      expect(signup.status).toBe(404)
    }).pipe(Effect.provide(makeAuthLayer(options)))
    const raw = yield* makeAuth(options)
    const signup = yield* authOperation("request", () => raw.handler(post(options, "/auth/sign-up/email", { email: "new@example.test", name: "New", password: "a-long-enough-password" })))
    expect(signup.status).toBe(400)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("rejects malformed emails and never signs in as an invited password or admin account", () => Effect.gen(function* () {
    const options = yield* fixture({ accessCode: null })
    yield* provisionUser(options, { email: "reader@example.test", name: "Reader", password: Redacted.make("invited-fixture-password-2026"), role: "user" })
    yield* provisionUser(options, { email: "admin@example.test", name: "Admin", password: Redacted.make("invited-fixture-password-2026"), role: "admin" })
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      for (const email of ["", "not-an-email", "two@@example.test", "spaces in@example.test", `${"a".repeat(250)}@example.test`]) {
        const response = yield* judge(auth, options, { email })
        expect(response.status, email).toBe(400)
        expect(cookies(response)).toBe("")
      }
      expect((yield* judge(auth, options, {})).status).toBe(400)
      for (const email of ["reader@example.test", "ADMIN@example.test"]) {
        const response = yield* judge(auth, options, { email })
        expect(response.status, email).toBe(403)
        expect(cookies(response)).toBe("")
      }
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("requires the configured access code when one is set", () => Effect.gen(function* () {
    const options = yield* fixture({ accessCode: Redacted.make("meta-judges-2026") })
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      expect(yield* signInOptions(auth, options)).toEqual({ method: "email", accessCode: true })
      for (const body of [{ email: "judge@example.test" }, { email: "judge@example.test", accessCode: "meta-judges-202" }, { email: "judge@example.test", accessCode: "meta-judges-20266" }]) {
        const response = yield* judge(auth, options, body)
        expect(response.status).toBe(401)
        expect(cookies(response)).toBe("")
      }
      const accepted = yield* judge(auth, options, { email: "judge@example.test", accessCode: "meta-judges-2026" })
      expect(accepted.status).toBe(200)
      expect((yield* auth.getSession(new Headers({ cookie: cookies(accepted) })))?.user.role).toBe("user")
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("limits each client separately behind the trusted Modal proxy", () => Effect.gen(function* () {
    const options = { ...(yield* fixture({ accessCode: null })), trustedProxy: "modal" as const }
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      expect(allowed(yield* signInsFrom(auth, options, "203.0.113.1", 20))).toBe(true)
      expect(yield* signInsFrom(auth, options, "203.0.113.1", 1, 20)).toEqual([429])
      expect(allowed(yield* signInsFrom(auth, options, "203.0.113.2", 20, 21))).toBe(true)
      expect(yield* signInsFrom(auth, options, "203.0.113.2", 1, 41)).toEqual([429])
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("shares one limit between direct clients when no proxy is trusted", () => Effect.gen(function* () {
    const options = yield* fixture({ accessCode: null })
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      expect(allowed(yield* signInsFrom(auth, options, "203.0.113.1", 20))).toBe(true)
      expect(yield* signInsFrom(auth, options, "203.0.113.2", 1, 20)).toEqual([429])
      expect(yield* signInsFrom(auth, options, undefined, 1, 21)).toEqual([429])
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("keeps forwarded chains a client could have padded in one shared limit", () => Effect.gen(function* () {
    const options = { ...(yield* fixture({ accessCode: null })), trustedProxy: "modal" as const }
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const spoofed = `198.51.100.${attempt + 1}`
        const padded = attempt % 2 === 0 ? `${spoofed}, 203.0.113.9` : `203.0.113.9, ${spoofed}`
        expect(yield* signInsFrom(auth, options, padded, 1, attempt)).toEqual([200])
      }
      expect(yield* signInsFrom(auth, options, "198.51.100.77, 203.0.113.9", 1, 20)).toEqual([429])
      expect(yield* signInsFrom(auth, options, "203.0.113.9, 198.51.100.78", 1, 21)).toEqual([429])
      expect(yield* signInsFrom(auth, options, "203.0.113.10", 1, 22)).toEqual([200])
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))
})
