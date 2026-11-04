import { Deferred, Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const holder = new URL("./read-lock-holder.mjs", import.meta.url).pathname

// A read lock held by another process, like the Modal snapshot sidecar. Returns once the
// lock is held. `arm` starts the hold timer; `released` gives the epoch millisecond at
// which the other process let go. Closing the scope kills the process.
export const holdReadLock = Effect.fnUntraced(function* (databasePath: string, table: string, holdMilliseconds: number) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const child = yield* spawner.spawn(ChildProcess.make(process.execPath, [holder, databasePath, table, String(holdMilliseconds)]))
  const locked = yield* Deferred.make<void>()
  const released = yield* Deferred.make<number>()
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => line === "locked" ? Deferred.succeed(locked, undefined)
      : line.startsWith("released ") ? Deferred.succeed(released, Number(line.slice("released ".length))) : Effect.void),
    Effect.forkScoped,
  )
  yield* Deferred.await(locked)
  return {
    arm: Stream.make(new TextEncoder().encode("arm\n")).pipe(Stream.run(child.stdin)),
    released: Deferred.await(released),
  }
})
