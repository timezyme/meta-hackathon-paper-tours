import { LibsqlDialect } from "@libsql/kysely-libsql"
import { betterAuth } from "better-auth"
import { getMigrations } from "better-auth/db/migration"
import { admin } from "better-auth/plugins"
import { Effect, FileSystem, Path, Redacted, Schema } from "effect"
import { Kysely } from "kysely"
import { AuthError, type AuthOptions } from "./service.ts"

const AuthOrigin = Schema.URLFromString.check(Schema.makeFilter((url) =>
  url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === ""
  && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  || "Expected an HTTPS origin or an HTTP loopback origin"))

export const authOperation = <A>(operation: typeof AuthError.Type["operation"], run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new AuthError({ operation, cause }) }).pipe(Effect.uninterruptible)

export const makeAuth = Effect.fn("makeAuth")(function* (options: AuthOptions) {
  const origin = yield* Schema.decodeUnknownEffect(AuthOrigin)(options.origin).pipe(
    Effect.mapError((cause) => new AuthError({ operation: "configuration", cause })),
  )
  yield* Schema.decodeUnknownEffect(Schema.Redacted(Schema.String.check(Schema.isMinLength(32))))(options.secret).pipe(
    Effect.mapError((cause) => new AuthError({ operation: "configuration", cause })),
  )
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (!path.isAbsolute(options.databasePath) || path.basename(options.databasePath) !== "auth.sqlite") {
    return yield* new AuthError({ operation: "configuration", cause: "Expected an absolute auth.sqlite path" })
  }
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(options.databasePath), { recursive: true, mode: 0o700 })
    yield* fs.chmod(path.dirname(options.databasePath), 0o700)
    yield* fs.writeFile(options.databasePath, new Uint8Array(), { flag: "a", mode: 0o600 })
    yield* fs.chmod(options.databasePath, 0o600)
  }).pipe(Effect.mapError((cause) => new AuthError({ operation: "database", cause })))
  const url = yield* path.toFileUrl(options.databasePath).pipe(
    Effect.mapError((cause) => new AuthError({ operation: "configuration", cause })),
  )
  const database = yield* Effect.acquireRelease(
    Effect.try({
      try: () => new Kysely({ dialect: new LibsqlDialect({ url: url.href }) }),
      catch: (cause) => new AuthError({ operation: "database", cause }),
    }),
    (db) => authOperation("database", () => db.destroy()).pipe(Effect.orDie),
  )
  const optionsForAuth = {
    appName: "AmuseMe",
    baseURL: origin.origin,
    basePath: "/auth",
    secret: Redacted.value(options.secret),
    database: { db: database, type: "sqlite" as const },
    trustedOrigins: [origin.origin],
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12, maxPasswordLength: 128 },
    session: { expiresIn: 60 * 60 * 24, cookieCache: { enabled: false } },
    rateLimit: {
      enabled: true,
      storage: "database" as const,
      window: 60,
      max: 120,
      customRules: { "/sign-in/email": { window: 60, max: 10 } },
    },
    advanced: {
      useSecureCookies: origin.protocol === "https:",
      trustedProxyHeaders: false,
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: { ipAddressHeaders: [] },
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" as const, path: "/" },
    },
    logger: { disabled: true },
    telemetry: { enabled: false },
    plugins: [admin({ defaultRole: "user", adminRoles: ["admin"] })],
  }
  const migrations = yield* authOperation("migration", () => getMigrations(optionsForAuth))
  yield* authOperation("migration", () => migrations.runMigrations())
  const auth = betterAuth(optionsForAuth)
  yield* authOperation("configuration", () => auth.$context)
  return auth
})
