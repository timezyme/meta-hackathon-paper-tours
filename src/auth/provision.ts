import { Effect, Redacted, Schema } from "effect"
import { Session } from "../domain/index.ts"
import { authOperation, makeAuth } from "./instance.ts"
import { AuthError, type AuthOptions } from "./service.ts"

const InviteUser = Schema.Struct({
  email: Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/), Schema.isMaxLength(254)),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  password: Schema.Redacted(Schema.String.check(Schema.isMinLength(12), Schema.isMaxLength(128))),
  role: Session.fields.user.fields.role,
})
export type InviteUser = typeof InviteUser.Type

export const provisionUser = Effect.fn("provisionUser")(function* (options: AuthOptions, input: InviteUser) {
  const user = yield* Schema.decodeUnknownEffect(InviteUser)(input).pipe(
    Effect.mapError((cause) => new AuthError({ operation: "provision", cause })),
  )
  const auth = yield* makeAuth(options)
  const created = yield* authOperation("provision", () => auth.api.createUser({ body: {
    email: user.email,
    name: user.name,
    password: Redacted.value(user.password),
    role: user.role,
  } }))
  return yield* Schema.decodeUnknownEffect(Session)({ user: created.user }).pipe(
    Effect.mapError((cause) => new AuthError({ operation: "provision", cause })),
  )
}, Effect.scoped)
