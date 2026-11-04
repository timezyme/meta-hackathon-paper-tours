import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Config, Console, Effect, Path } from "effect"
import { provisionUser } from "../src/auth/index.ts"

Effect.gen(function* () {
  const origin = yield* Config.String("AMUSEME_ORIGIN")
  const secret = yield* Config.Redacted("BETTER_AUTH_SECRET")
  const directory = yield* Config.String("AMUSEME_DATA_DIR")
  const path = yield* Path.Path
  const databasePath = path.resolve(directory, "auth.sqlite")
  const email = yield* Config.String("AMUSEME_INVITE_EMAIL")
  const name = yield* Config.String("AMUSEME_INVITE_NAME")
  const password = yield* Config.Redacted("AMUSEME_INVITE_PASSWORD")
  const role = yield* Config.Literals(["user", "admin"], "AMUSEME_INVITE_ROLE")
  yield* provisionUser({ origin, secret, databasePath }, { email, name, password, role })
  yield* Console.log("Invited user created.")
}).pipe(
  Effect.catch(() => Console.error("Could not create the invited user. Check the private configuration and whether the account already exists.").pipe(
    Effect.andThen(Effect.fail("Invitation failed")),
  )),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
