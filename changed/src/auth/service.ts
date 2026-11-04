import { Context, Effect, Redacted, Schema } from "effect"
import { Session } from "../domain/index.ts"
import type { JudgeSignInOptions } from "./judge.ts"

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  operation: Schema.Literals(["configuration", "database", "migration", "session", "request", "provision"]),
  cause: Schema.Defect(),
}) {}

export type TrustedProxy = "modal"

export interface AuthOptions {
  readonly origin: string
  readonly secret: Redacted.Redacted<string>
  readonly databasePath: string
  readonly judgeSignIn?: JudgeSignInOptions | undefined
  readonly trustedProxy?: TrustedProxy | undefined
}

export class AuthService extends Context.Service<AuthService, {
  readonly getSession: (headers: Headers) => Effect.Effect<typeof Session.Type | null, AuthError>
  readonly handle: (request: Request) => Effect.Effect<Response, AuthError>
}>()("amuseme/auth/AuthService") {}
