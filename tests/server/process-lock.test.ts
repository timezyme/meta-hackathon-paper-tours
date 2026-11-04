import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { withProcessLock } from "../../src/server/process-lock.ts"
import { makeDocumentStoreLayer } from "../../src/storage/index.ts"

const Record = Schema.Struct({ parentPid: Schema.Int, holderPid: Schema.Int, token: Schema.String })
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dataDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-process-lock-" })
  const options = { dataDirectory, pythonBin: path.resolve("data/python/.venv/bin/python") }
  const recordPath = path.join(dataDirectory, ".amuseme-process.lock")
  const record = fs.readFileString(recordPath).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Record))))
  return { fs, path, options, recordPath, record }
})
const command = Effect.fnUntraced(function* (executable: string, args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const process = yield* spawner.spawn(ChildProcess.make(executable, args, { forceKillAfter: "100 millis" }))
  return yield* process.exitCode
}, Effect.scoped)

describe("exclusive local application process", () => {
  it.effect("rejects a second holder before runtime cleanup, regardless of stale diagnostic content", () => Effect.gen(function* () {
    const f = yield* fixture
    const entered = yield* Deferred.make<void>()
    const holder = yield* withProcessLock(f.options, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))).pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    const record = yield* f.record
    expect(record.parentPid).toBeGreaterThan(0)
    expect(record.holderPid).toBeGreaterThan(0)
    expect(record.token).toMatch(/^[a-f0-9-]{36}$/u)
    expect((yield* f.fs.stat(f.recordPath)).mode & 0o777).toBe(0o600)
    const uploads = f.path.join(f.options.dataDirectory, "uploads")
    yield* f.fs.makeDirectory(uploads)
    const live = yield* f.fs.makeTempDirectory({ directory: uploads, prefix: "upload-" })
    yield* f.fs.writeFileString(f.path.join(live, "source.pdf"), "live upload")
    yield* f.fs.writeFileString(f.recordPath, '{"parentPid":999999999,"holderPid":999999998,"token":"old"}')
    let started = false
    const second = withProcessLock(f.options, Effect.sync(() => { started = true }).pipe(Effect.provide(makeDocumentStoreLayer({ dataDirectory: f.options.dataDirectory, queueLimit: 1 }))))
    expect(yield* second.pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { reason: "busy" } })
    expect(started).toBe(false)
    expect(yield* f.fs.readFileString(f.path.join(live, "source.pdf"))).toBe("live upload")
    yield* Fiber.interrupt(holder)
    expect(yield* withProcessLock(f.options, Effect.succeed("reacquired"))).toBe("reacquired")
    expect((yield* f.record).token).not.toBe(record.token)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("releases on success, application failure and interruption without unlinking the lock inode", () => Effect.gen(function* () {
    const f = yield* fixture
    expect(yield* withProcessLock(f.options, Effect.succeed(42))).toBe(42)
    const first = yield* f.fs.stat(f.recordPath)
    expect(yield* withProcessLock(f.options, Effect.fail("application failed")).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: "application failed" })
    expect(yield* withProcessLock(f.options, Effect.succeed(43))).toBe(43)
    expect((yield* f.fs.stat(f.recordPath)).ino).toEqual(first.ino)
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("fails closed for symlinks, hard links, public permissions and missing runtimes", () => Effect.gen(function* () {
    const f = yield* fixture
    const external = f.path.join(f.options.dataDirectory, "external")
    yield* f.fs.writeFileString(external, "untouched", { mode: 0o600 })
    for (const kind of ["symlink", "hardlink", "public"] as const) {
      if (kind === "symlink") yield* f.fs.symlink(external, f.recordPath)
      else if (kind === "hardlink") yield* f.fs.link(external, f.recordPath)
      else yield* f.fs.writeFileString(f.recordPath, "public", { mode: 0o644 })
      expect(yield* withProcessLock(f.options, Effect.die("Must not run")).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { reason: "unsafe" } })
      yield* f.fs.remove(f.recordPath)
      expect(yield* f.fs.readFileString(external)).toBe("untouched")
    }
    expect(yield* withProcessLock({ ...f.options, pythonBin: "/no/python" }, Effect.void).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { reason: "unavailable" } })
    yield* f.fs.chmod(f.options.dataDirectory, 0o755)
    expect(yield* withProcessLock(f.options, Effect.void).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { reason: "unsafe" } })
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("interrupts application work if the lock helper dies unexpectedly", () => Effect.gen(function* () {
    const f = yield* fixture
    const entered = yield* Deferred.make<void>()
    let stopped = false
    const running = yield* withProcessLock(f.options, Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => { stopped = true })))).pipe(Effect.result, Effect.forkScoped)
    yield* Deferred.await(entered)
    const record = yield* f.record
    expect(yield* command("/bin/kill", ["-KILL", String(record.holderPid)])).toBe(0)
    expect(yield* Fiber.join(running)).toMatchObject({ _tag: "Failure", failure: { reason: "lost" } })
    expect(stopped).toBe(true)
    expect(yield* withProcessLock(f.options, Effect.succeed("available"))).toBe("available")
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("bounds acquisition time and stops an unresponsive lock executable", () => Effect.gen(function* () {
    const f = yield* fixture
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const spawned = yield* Deferred.make<void>()
    const stalled = f.path.join(f.options.dataDirectory, "stalled")
    yield* f.fs.writeFileString(stalled, "#!/bin/sh\nsleep 60\n", { mode: 0o700 })
    const tracked: ChildProcessSpawner.ChildProcessSpawner["Service"] = { ...spawner, spawn: (cmd) => spawner.spawn(cmd).pipe(Effect.tap(() => Deferred.succeed(spawned, undefined))) }
    const fiber = yield* withProcessLock({ ...f.options, pythonBin: stalled }, Effect.die("Must not run")).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, tracked), Effect.result, Effect.forkScoped)
    yield* Deferred.await(spawned)
    yield* TestClock.adjust("5 seconds")
    expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "Failure", failure: { reason: "unavailable" } })
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("releases an orphan helper through pipe EOF when its Node parent is killed", () => Effect.gen(function* () {
    const f = yield* fixture
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const source = `import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { withProcessLock } from "./src/server/process-lock.ts";
withProcessLock(${JSON.stringify(f.options)}, Effect.sync(() => process.stdout.write("ready\\n")).pipe(Effect.andThen(Effect.never)))
  .pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);`
    const parent = yield* spawner.spawn(ChildProcess.make("volta", ["run", "--node", "24.19.0", "node", "--input-type=module", "-e", source], { cwd: f.path.resolve("."), forceKillAfter: "100 millis" }))
    const ready = yield* parent.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.take(1), Stream.mkString, Effect.timeout("5 seconds"))
    expect(ready).toBe("ready")
    expect(yield* withProcessLock(f.options, Effect.void).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { reason: "busy" } })
    yield* parent.kill({ killSignal: "SIGKILL", forceKillAfter: "100 millis" })
    expect((yield* parent.exitCode.pipe(Effect.result))._tag).toBe("Failure")
    expect(yield* withProcessLock(f.options, Effect.succeed("parent-death released"))).toBe("parent-death released")
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { timeout: 10000 })
})
