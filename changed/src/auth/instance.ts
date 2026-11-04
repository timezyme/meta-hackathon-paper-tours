import { createClient } from "@libsql/client"
import { LibsqlDialect, type libsql } from "@libsql/kysely-libsql"
import { betterAuth } from "better-auth"
import { getMigrations } from "better-auth/db/migration"
import { admin } from "better-auth/plugins"
import { Effect, FileSystem, Path, Redacted, Schema } from "effect"
import { Kysely } from "kysely"
import { judgeSignIn } from "./judge.ts"
import { authRateLimits } from "./routes.ts"
import { AuthError, type AuthOptions, type TrustedProxy } from "./service.ts"

const AuthOrigin = Schema.URLFromString.check(Schema.makeFilter((url) =>
  url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === ""
  && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  || "Expected an HTTPS origin or an HTTP loopback origin"))

const clientAddressHeaders: Record<TrustedProxy, Array<string>> = { modal: ["x-forwarded-for"] }

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
      try: () => {
        const client = createClient({ url: url.href, timeout: 5000 })
        return { client, db: new Kysely({ dialect: new LibsqlDialect({ client: client as unknown as libsql.Client }) }) }
      },
      catch: (cause) => new AuthError({ operation: "database", cause }),
    }),
    ({ client, db }) => authOperation("database", () => db.destroy()).pipe(Effect.andThen(Effect.sync(() => client.close())), Effect.orDie),
  ).pipe(Effect.map(({ db }) => db))
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
      customRules: authRateLimits,
    },
    advanced: {
      useSecureCookies: origin.protocol === "https:",
      trustedProxyHeaders: false,
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: {
        ipAddressHeaders: options.trustedProxy === undefined ? [] : clientAddressHeaders[options.trustedProxy],
      },
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" as const, path: "/" },
    },
    logger: { disabled: true },
    telemetry: { enabled: false },
    plugins: [admin({ defaultRole: "user", adminRoles: ["admin"] }), ...(options.judgeSignIn === undefined ? [] : [judgeSignIn(options.judgeSignIn)])],
  }
  const migrations = yield* authOperation("migration", () => getMigrations(optionsForAuth))
  yield* authOperation("migration", () => migrations.runMigrations())
  const auth = betterAuth(optionsForAuth)
  yield* authOperation("configuration", () => auth.$context)
  return auth
})
