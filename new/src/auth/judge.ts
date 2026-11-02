import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthEndpoint } from "better-auth/api"
import { setSessionCookie } from "better-auth/cookies"
import { Effect, Redacted, Schema } from "effect"
import { EmailAddress, normalizeEmail } from "../domain/index.ts"

export interface JudgeSignInOptions {
  readonly accessCode: Redacted.Redacted<string> | null
}

export const judgeSignInPath = "/sign-in/judge"
const JudgeSignInBody = Schema.Struct({ email: Schema.String.check(Schema.isMaxLength(512)), accessCode: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))) })
const sameCode = (given: string, expected: string) => {
  let difference = given.length ^ expected.length
  for (let index = 0; index < expected.length; index += 1) difference |= (given.charCodeAt(index) || 0) ^ expected.charCodeAt(index)
  return difference === 0
}
const isEmail = Schema.is(EmailAddress)

export const judgeSignIn = (options: JudgeSignInOptions) => ({
  id: "amuseme-judge-sign-in",
  endpoints: {
    signInJudge: createAuthEndpoint(judgeSignInPath, { method: "POST", body: Schema.toStandardSchemaV1(JudgeSignInBody) }, (ctx) => Effect.runPromise(Effect.gen(function* () {
      if (options.accessCode !== null && !sameCode(ctx.body.accessCode ?? "", Redacted.value(options.accessCode))) {
        return yield* Effect.fail(APIError.from("UNAUTHORIZED", { code: "INVALID_ACCESS_CODE", message: "The access code is not correct." }))
      }
      const email = normalizeEmail(ctx.body.email)
      if (!isEmail(email)) return yield* Effect.fail(APIError.from("BAD_REQUEST", { code: "INVALID_EMAIL", message: "Enter a valid email address." }))
      const adapter = ctx.context.internalAdapter
      const existing = yield* Effect.promise(() => adapter.findUserByEmail(email, { includeAccounts: true }))
      if (existing !== null && (existing.accounts.length > 0 || (existing.user as { role?: unknown }).role !== "user")) {
        return yield* Effect.fail(APIError.from("FORBIDDEN", { code: "PASSWORD_ACCOUNT", message: "This email belongs to an invited account. Sign in with its password." }))
      }
      const user = existing?.user ?? (yield* Effect.promise(() => adapter.createUser({ email, name: email.split("@")[0] ?? email, emailVerified: false, role: "user" }, { method: "amuseme-judge" })))
      const session = yield* Effect.promise(() => adapter.createSession(user.id))
      yield* Effect.promise(() => Promise.resolve(setSessionCookie(ctx, { session, user })))
      return yield* Effect.promise(() => Promise.resolve(ctx.json({ user: { id: user.id, email: user.email } })))
    }))),
  },
}) satisfies BetterAuthPlugin
