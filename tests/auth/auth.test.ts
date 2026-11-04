import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { createClient } from "@libsql/client"
import { Clock, Effect, Fiber, FileSystem, Path, Redacted, Result } from "effect"
import { TestClock } from "effect/testing"
import { AuthService, makeAuthLayer, provisionUser, type AuthOptions } from "../../src/auth/index.ts"
import { holdReadLock } from "../fixtures/read-lock.ts"
import { authOperation, makeAuth } from "../../src/auth/instance.ts"

const password = "invited-fixture-password-2026"
const secret = Redacted.make("fixture-only-signing-secret-32-characters-long")
const fixture = Effect.fnUntraced(function* (origin = "http://127.0.0.1:4180") {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-auth-" })
  return { origin, secret, databasePath: path.join(root, "private", "auth.sqlite") } satisfies AuthOptions
})
const invite = (options: AuthOptions, email = "reader@example.test", role: "user" | "admin" = "user") =>
  provisionUser(options, { email, name: "Invited reader", password: Redacted.make(password), role })

const request = (options: AuthOptions, path: string, body?: object, headers?: Record<string, string>) => new Request(`${options.origin}${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { origin: options.origin, "content-type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

const signIn = (auth: AuthService["Service"], options: AuthOptions, email = "reader@example.test", extras?: object) =>
  auth.handle(request(options, "/auth/sign-in/email", { email, password, ...extras }))

const cookies = (response: Response) => response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ")
const sessionHeaders = (response: Response) => new Headers({ cookie: cookies(response) })

const database = Effect.fnUntraced(function* (options: AuthOptions) {
  const path = yield* Path.Path
  const url = yield* path.toFileUrl(options.databasePath)
  return yield* Effect.acquireRelease(
    Effect.sync(() => createClient({ url: url.href })),
    (client) => Effect.sync(() => client.close()),
  )
})

describe("private database authentication", () => {
  it.effect("invites two distinct identities with server-owned roles and persists sessions across restart", () => Effect.gen(function* () {
    const options = yield* fixture()
    const reader = yield* invite(options)
    const administrator = yield* invite(options, "admin@example.test", "admin")
    expect(reader.user.role).toBe("user")
    expect(administrator.user.role).toBe("admin")
    expect(reader.user.id).not.toBe(administrator.user.id)
    const headers = yield* Effect.gen(function* () {
      const auth = yield* AuthService
      const response = yield* signIn(auth, options)
      expect(response.status).toBe(200)
      expect(yield* auth.getSession(sessionHeaders(response))).toEqual(reader)
      const adminResponse = yield* signIn(auth, options, "admin@example.test")
      expect(yield* auth.getSession(sessionHeaders(adminResponse))).toEqual(administrator)
      return sessionHeaders(response)
    }).pipe(Effect.provide(makeAuthLayer(options)))
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      expect(yield* auth.getSession(headers)).toEqual(reader)
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("uses private files and creates auth tables before accepting requests", () => Effect.gen(function* () {
    const options = yield* fixture()
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      expect(yield* auth.getSession(new Headers())).toBeNull()
      const client = yield* database(options)
      const rows = yield* authOperation("database", () => client.execute("SELECT name FROM sqlite_master WHERE type='table'"))
      expect(rows.rows.map((row) => row["name"])).toEqual(expect.arrayContaining(["user", "account", "session", "rateLimit"]))
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      expect((yield* fs.stat(options.databasePath)).mode & 0o777).toBe(0o600)
      expect((yield* fs.stat(path.dirname(options.databasePath))).mode & 0o777).toBe(0o700)
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects wrong passwords and forged role or owner fields cannot elevate a signed-in user", () => Effect.gen(function* () {
    const options = yield* fixture()
    const reader = yield* invite(options)
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      const wrong = yield* auth.handle(request(options, "/auth/sign-in/email", { email: reader.user.email, password: "wrong-password" }))
      expect(wrong.status).toBe(401)
      expect(cookies(wrong)).toBe("")
      const signedIn = yield* signIn(auth, options, reader.user.email, { role: "admin", ownerId: "someone-else", userId: "someone-else" })
      expect(signedIn.status).toBe(200)
      const headers = sessionHeaders(signedIn)
      headers.set("x-user-role", "admin")
      headers.set("x-user-id", "someone-else")
      expect(yield* auth.getSession(headers)).toEqual(reader)
      expect((yield* auth.handle(request(options, "/auth/admin/set-role", { userId: reader.user.id, role: "admin" }, { cookie: cookies(signedIn) }))).status).toBe(404)
      expect(yield* auth.getSession(headers)).toEqual(reader)
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("disables registration in Better Auth itself and rejects every non-allowlisted HTTP endpoint", () => Effect.gen(function* () {
    const options = yield* fixture()
    const raw = yield* makeAuth(options)
    const signup = yield* authOperation("request", () => raw.handler(request(options, "/auth/sign-up/email", {
      email: "attacker@example.test", name: "Uninvited", password, role: "admin",
    })))
    expect(signup.status).toBe(400)
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      for (const path of ["/auth/sign-up/email", "/auth/admin/create-user", "/auth/request-password-reset", "/auth/update-user", "/auth/sign-in/email/", "/auth/sign-in%2femail"]) {
        expect((yield* auth.handle(request(options, path, { email: "attacker@example.test", name: "Uninvited", password, role: "admin" }))).status).toBe(404)
      }
      expect((yield* auth.handle(request(options, "/auth/sign-in/email"))).status).toBe(404)
      expect((yield* signIn(auth, options, "attacker@example.test")).status).toBe(401)
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("sign-out revokes the database session immediately", () => Effect.gen(function* () {
    const options = yield* fixture()
    yield* invite(options)
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      const response = yield* signIn(auth, options)
      const headers = sessionHeaders(response)
      expect(yield* auth.getSession(headers)).not.toBeNull()
      const signedOut = yield* auth.handle(request(options, "/auth/sign-out", {}, { cookie: cookies(response) }))
      expect(signedOut.status).toBe(200)
      expect(yield* auth.getSession(headers)).toBeNull()
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("reads revoked sessions, expired sessions, and changed roles from SQLite without cached authority", () => Effect.gen(function* () {
    const options = yield* fixture()
    yield* invite(options, "admin@example.test", "admin")
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      const client = yield* database(options)
      const response = yield* signIn(auth, options, "admin@example.test")
      const headers = sessionHeaders(response)
      expect((yield* auth.getSession(headers))?.user.role).toBe("admin")
      yield* authOperation("database", () => client.execute("UPDATE user SET role='user'"))
      expect((yield* auth.getSession(headers))?.user.role).toBe("user")
      yield* authOperation("database", () => client.execute("UPDATE session SET expiresAt=0"))
      expect(yield* auth.getSession(headers)).toBeNull()
      const again = yield* signIn(auth, options, "admin@example.test")
      expect(yield* auth.getSession(sessionHeaders(again))).not.toBeNull()
      yield* authOperation("database", () => client.execute("DELETE FROM session"))
      expect(yield* auth.getSession(sessionHeaders(again))).toBeNull()
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("sets Secure HTTPS cookies and permits insecure cookies only on explicit loopback HTTP", () => Effect.gen(function* () {
    for (const origin of ["https://amuseme.example.test", "http://127.0.0.1:4180"]) {
      const options = yield* fixture(origin)
      yield* invite(options)
      yield* Effect.gen(function* () {
        const auth = yield* AuthService
        const response = yield* signIn(auth, options)
        expect(response.status).toBe(200)
        const cookie = response.headers.getSetCookie().find((value) => value.includes("session_token="))
        expect(cookie).toContain("HttpOnly")
        expect(cookie).toContain("SameSite=Lax")
        expect(cookie?.includes("Secure")).toBe(origin.startsWith("https:"))
        expect(cookie?.startsWith("__Secure-")).toBe(origin.startsWith("https:"))
      }).pipe(Effect.provide(makeAuthLayer(options)))
    }
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects unsafe configuration and invalid invitation input", () => Effect.gen(function* () {
    const options = yield* fixture()
    for (const origin of ["http://amuseme.example.test", "https://user:pass@amuseme.example.test", "https://amuseme.example.test/path", "https://amuseme.example.test?query=yes", "not-a-url"]) {
      expect(Result.isFailure(yield* Effect.result(makeAuth({ ...options, origin })))).toBe(true)
    }
    expect(Result.isFailure(yield* Effect.result(makeAuth({ ...options, secret: Redacted.make("short") })))).toBe(true)
    expect(Result.isFailure(yield* Effect.result(makeAuth({ ...options, databasePath: "auth.sqlite" })))).toBe(true)
    expect(Result.isFailure(yield* Effect.result(provisionUser(options, {
      email: "reader@example.test", name: "Reader", role: "user", password: Redacted.make("short"),
    })))).toBe(true)
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects hostile origins and redirect callbacks while ignoring forwarded authority", () => Effect.gen(function* () {
    const options = yield* fixture()
    yield* invite(options)
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      const crossOrigin = yield* auth.handle(request(options, "/auth/sign-in/email", { email: "reader@example.test", password }, { origin: "https://attacker.example" }))
      expect(crossOrigin.status).toBe(403)
      const redirect = yield* signIn(auth, options, "reader@example.test", { callbackURL: "https://attacker.example" })
      expect(redirect.status).toBe(403)
      const forwarded = yield* auth.handle(request(options, "/auth/sign-in/email", { email: "reader@example.test", password }, {
        "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https", "x-forwarded-for": "1.2.3.4",
      }))
      expect(forwarded.status).toBe(200)
      expect(forwarded.headers.getSetCookie().some((value) => value.includes("Secure"))).toBe(false)
      expect(yield* auth.getSession(sessionHeaders(forwarded))).not.toBeNull()
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("keeps the login limit across restart and cannot bypass it with forged client-IP headers", () => Effect.gen(function* () {
    const options = yield* fixture()
    yield* invite(options)
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = yield* auth.handle(request(options, "/auth/sign-in/email", { email: "reader@example.test", password: "wrong-password" }))
        expect(response.status).toBe(401)
      }
      expect((yield* signIn(auth, options)).status).toBe(429)
    }).pipe(Effect.provide(makeAuthLayer(options)))
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      const response = yield* auth.handle(request(options, "/auth/sign-in/email", { email: "reader@example.test", password }, {
        "x-forwarded-for": "5.6.7.8", "x-real-ip": "5.6.7.8", "cf-connecting-ip": "5.6.7.8",
      }))
      expect(response.status).toBe(429)
      expect(response.headers.get("x-retry-after")).not.toBeNull()
      expect(yield* auth.getSession(new Headers())).toBeNull()
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("enforces the durable sign-in limit under concurrent requests", () => Effect.gen(function* () {
    const options = yield* fixture()
    yield* invite(options)
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      const responses = yield* Effect.all(Array.from({ length: 13 }, () =>
        auth.handle(request(options, "/auth/sign-in/email", { email: "reader@example.test", password: "wrong-password" }))),
      { concurrency: "unbounded" })
      expect(responses.filter((response) => response.status === 401)).toHaveLength(10)
      expect(responses.filter((response) => response.status === 429)).toHaveLength(3)
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects oversized and malformed sign-in bodies before creating a session", () => Effect.gen(function* () {
    const options = yield* fixture()
    yield* invite(options)
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      const oversized = yield* auth.handle(request(options, "/auth/sign-in/email", { email: "reader@example.test", password, padding: "x".repeat(17000) }))
      expect(oversized.status).toBe(413)
      const malformed = yield* auth.handle(new Request(`${options.origin}/auth/sign-in/email`, {
        method: "POST", body: "{", headers: { origin: options.origin, "content-type": "application/json" },
      }))
      expect(malformed.status).toBe(400)
      expect(cookies(oversized)).toBe("")
      expect(cookies(malformed)).toBe("")
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("buffers the Node server's structural request without native Request cloning", () => Effect.gen(function* () {
    const options = yield* fixture()
    yield* invite(options)
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      const incoming = request(options, "/auth/sign-in/email", { email: "reader@example.test", password })
      const wrapped = new Proxy(incoming, { get: (target, key) => Reflect.get(target, key, target) })
      const response = yield* auth.handle(wrapped)
      expect(response.status).toBe(200)
      expect((yield* auth.getSession(sessionHeaders(response)))?.user.email).toBe("reader@example.test")
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("times out stalled request bodies and cancels their readers", () => Effect.gen(function* () {
    const options = yield* fixture()
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      let canceled = false
      const body = new ReadableStream<Uint8Array>({ cancel: () => { canceled = true } })
      const slow = new Request(`${options.origin}/auth/sign-in/email`, {
        method: "POST", body, duplex: "half", headers: { origin: options.origin, "content-type": "application/json" },
      })
      const fiber = yield* auth.handle(slow).pipe(Effect.forkChild)
      yield* TestClock.adjust("5 seconds")
      expect((yield* Fiber.join(fiber)).status).toBe(408)
      expect(canceled).toBe(true)
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("interrupts request-body admission without leaving a reader or database operation running", () => Effect.gen(function* () {
    const options = yield* fixture()
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      let canceled = false
      const body = new ReadableStream<Uint8Array>({ cancel: () => { canceled = true } })
      const slow = new Request(`${options.origin}/auth/sign-in/email`, {
        method: "POST", body, duplex: "half", headers: { origin: options.origin, "content-type": "application/json" },
      })
      const fiber = yield* auth.handle(slow).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      expect(canceled).toBe(true)
      const client = yield* database(options)
      const rows = yield* authOperation("database", () => client.execute("SELECT count(*) AS total FROM session"))
      expect(rows.rows[0]?.["total"]).toBe(0)
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("fails startup on an unreadable database and fails closed on an invalid stored role", () => Effect.gen(function* () {
    const broken = yield* fixture()
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.dirname(broken.databasePath), { recursive: true })
    yield* fs.writeFileString(broken.databasePath, "not a SQLite database")
    const startup = yield* Effect.result(makeAuth(broken))
    expect(Result.isFailure(startup)).toBe(true)
    if (Result.isFailure(startup)) expect(startup.failure.operation).toBe("migration")
    const options = yield* fixture()
    yield* invite(options)
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      const response = yield* signIn(auth, options)
      const client = yield* database(options)
      yield* authOperation("database", () => client.execute("UPDATE user SET role='admin,user'"))
      const invalidRole = yield* Effect.result(auth.getSession(sessionHeaders(response)))
      expect(Result.isFailure(invalidRole)).toBe(true)
      if (Result.isFailure(invalidRole)) expect(invalidRole.failure.operation).toBe("session")
    }).pipe(Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.live("waits for another process's read lock on auth.sqlite instead of failing sign-in", () => Effect.gen(function* () {
    const options = yield* fixture()
    yield* invite(options)
    yield* Effect.gen(function* () {
      const auth = yield* AuthService
      expect((yield* signIn(auth, options)).status).toBe(200)
      const lock = yield* holdReadLock(options.databasePath, "user", 300)
      yield* lock.arm
      const response = yield* signIn(auth, options)
      const finished = yield* Clock.currentTimeMillis
      // A sign-in that finished before the release never met the lock, so it proves nothing.
      expect(finished).toBeGreaterThanOrEqual(yield* lock.released)
      expect(response.status).toBe(200)
      expect((yield* auth.getSession(sessionHeaders(response)))?.user.email).toBe("reader@example.test")
    }).pipe(Effect.scoped, Effect.provide(makeAuthLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)), 15000)
})
