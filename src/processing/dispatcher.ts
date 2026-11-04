import { Clock, Context, DateTime, Effect, Exit, Layer, Schema } from "effect"
import { RunState } from "../domain/index.ts"
import { DocumentStore, type DispatchClaim } from "../storage/index.ts"
import { ExecutionFailure, GuardPolicy, ProviderGuard, executionFailure, type GuardError } from "./contracts.ts"
import { processingAvailability } from "./policy.ts"

export class RunStarter extends Context.Service<RunStarter, {
  readonly startOrReconnect: (claim: DispatchClaim) => Effect.Effect<RunState, ExecutionFailure>
}>()("amuseme/processing/RunStarter") {}

export class RunDispatcher extends Context.Service<RunDispatcher, {
  readonly dispatchOne: () => Effect.Effect<DispatchClaim | null, GuardError, RunStarter>
  readonly recover: () => Effect.Effect<number, GuardError>
}>()("amuseme/processing/RunDispatcher") {}

export const makeRunDispatcher = Effect.fn("makeRunDispatcher")(function* (policy: GuardPolicy, workerId: string, leaseMilliseconds: number) {
  yield* Schema.decodeUnknownEffect(Schema.Struct({ policy: GuardPolicy, workerId: Schema.String.check(Schema.isMinLength(1)), leaseMilliseconds: Schema.Int.check(Schema.isGreaterThanOrEqualTo(30)) }))({ policy, workerId, leaseMilliseconds }).pipe(Effect.mapError(() => executionFailure("processing-unavailable", "Dispatcher configuration is invalid")))
  const store = yield* DocumentStore
  const guard = yield* ProviderGuard
  const interrupt = Effect.fn("RunDispatcher.interrupt")(function* (claim: DispatchClaim) {
    const now = yield* DateTime.now
    yield* store.updateRun(claim, { _tag: "interrupted", finishedAt: DateTime.formatIso(now), failure: { code: "provider-unknown-completion", message: "Processing stopped; saved provider attempts must be reconciled before retry", retryable: true, stage: null, pageId: null, figureId: null } }).pipe(Effect.catchTag("StorageFailure", (error) => error.code === "conflict" ? Effect.void : Effect.fail(error)))
  })
  const dispatchOne = Effect.fn("RunDispatcher.dispatchOne")(function* () {
    const availability = processingAvailability(policy)
    if (!availability.available) return yield* executionFailure("processing-unavailable", availability.reason ?? "Processing is unavailable")
    const starter = yield* RunStarter
    const claim = yield* store.claimNext({ workerId, leaseMilliseconds })
    if (claim === null) return null
    const started = yield* Clock.currentTimeMillis
    const deadline = claim.run.state._tag === "running" ? DateTime.toEpochMillis(DateTime.makeUnsafe(claim.run.state.startedAt)) + claim.run.configuration.deadlineMilliseconds : started
    const heartbeat = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(Math.floor(leaseMilliseconds / 3))
        yield* store.renewClaim(claim, leaseMilliseconds).pipe(Effect.catchTag("StorageFailure", (error) => Effect.gen(function* () {
          if (error.code !== "conflict") return yield* error
          const latest = yield* store.status(claim.document.ownerId, claim.document.id)
          if (latest.id === claim.run.id && (latest.state._tag === "succeeded" || latest.state._tag === "succeeded-with-issues")) return yield* Effect.never
          return yield* error
        })))
      }
    })
    const execute = Effect.gen(function* () {
      const state = yield* starter.startOrReconnect(claim)
      const validated = yield* Schema.decodeUnknownEffect(RunState)(state).pipe(Effect.mapError(() => executionFailure("invalid-provider-response", "The workflow returned an invalid run outcome")))
      if (validated._tag === "queued" || validated._tag === "running") return yield* executionFailure("provider-unknown-completion", "The workflow returned without a terminal outcome")
      if (validated._tag === "succeeded" || validated._tag === "succeeded-with-issues") {
        const persisted = yield* store.status(claim.document.ownerId, claim.document.id)
        if (persisted.id !== claim.run.id || JSON.stringify(persisted.state) !== JSON.stringify(validated)) return yield* executionFailure("invalid-provider-response", "Workflow success has no matching published output")
      } else yield* store.updateRun(claim, validated)
      return claim
    })
    return yield* Effect.raceFirst(execute, heartbeat).pipe(
      Effect.timeoutOrElse({ duration: Math.max(0, deadline - started), orElse: () => Effect.fail(executionFailure("provider-unknown-completion", "The workflow deadline elapsed")) }),
      Effect.onExit((exit) => Exit.isFailure(exit) ? interrupt(claim) : Effect.void),
    )
  })
  const recover = Effect.fn("RunDispatcher.recover")(function* () {
    yield* guard.reconcile()
    return yield* store.recoverExpiredClaims()
  })
  return RunDispatcher.of({ dispatchOne, recover })
})

export const makeRunDispatcherLayer = (policy: GuardPolicy, workerId: string, leaseMilliseconds: number) => Layer.effect(RunDispatcher, makeRunDispatcher(policy, workerId, leaseMilliseconds))
