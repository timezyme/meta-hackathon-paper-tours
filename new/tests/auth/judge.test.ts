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
const post = (options: AuthOptions, path: string, body: object) => new Request(`${options.origin}${path}`, {
  method: "POST", headers: { origin: options.origin, "content-type": "application/json" }, body: JSON.stringify(body),
})
const cookies = (response: Response) => response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ")
const judge = (auth: AuthService["Service"], options: AuthOptions, body: object) => auth.handle(post(options, "/auth/sign-in/judge", body))
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

  it.effect("keeps a shared rolling rate limit on email-only sign-in", () => Effect.gen(function* () {
    const options = yield* fixture({ accessCode: null })
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      const statuses: number[] = []
      for (let attempt = 0; attempt < 21; attempt += 1) statuses.push((yield* judge(auth, options, { email: `judge${attempt}@example.test` })).status)
      expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true)
      expect(statuses[20]).toBe(429)
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))
})
