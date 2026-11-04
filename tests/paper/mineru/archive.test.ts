import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Clock, Duration, Effect, Fiber, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { MineruArchiveReader } from "../../../src/paper/providers/mineru/index.ts"
import { MINERU_ARCHIVE_SCRIPT } from "../../../src/paper/providers/mineru/archive-script.ts"

const setup = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ directory: path.resolve("data"), prefix: "archive-tests-" })
  const tempDirectory = path.join(root, "private")
  yield* fs.makeDirectory(tempDirectory, { mode: 0o700 })
  const pythonBin = path.resolve("data/python/.venv/bin/python")
  const source = path.resolve("tests/paper/mineru/fixtures/seaborn-download.zip")
  const service = yield* MineruArchiveReader.pipe(Effect.provide(MineruArchiveReader.layer({ pythonBin, tempDirectory })))
  return { fs, path, root, source, tempDirectory, pythonBin, service }
})
const command = Effect.fnUntraced(function* (executable: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const process = yield* spawner.spawn(ChildProcess.make(executable, args))
  return yield* Effect.all({ code: process.exitCode, output: process.all.pipe(Stream.decodeText(), Stream.mkString) }, { concurrency: "unbounded" })
})
const waitForWorker = (fs: FileSystem.FileSystem, path: Path.Path, tempDirectory: string, pidsFile: string) => Effect.gen(function* () {
  while (!(yield* fs.exists(pidsFile))) yield* Effect.sleep("10 millis")
  const pids = (yield* fs.readFileString(pidsFile)).trim().split("\n")
  expect(pids).toHaveLength(2)
  expect(new Set(pids).size).toBe(2)
  for (const pid of pids) expect(pid).toMatch(/^[1-9]\d*$/u)
  const directories = yield* fs.readDirectory(tempDirectory)
  expect(directories).toHaveLength(1)
  const directory = directories[0]
  if (directory === undefined) return yield* Effect.die("Archive fixture output directory is missing")
  expect(yield* fs.readFileString(path.join(tempDirectory, directory, "middle.json"))).toBe("partial")
  return pids
}).pipe(Effect.timeout("5 seconds"))

describe("real private MinerU archive decoder", () => {
  it.effect("rejects oversized compressed input and unavailable Python without exposing private paths", () => Effect.gen(function* () {
    const f = yield* setup()
    expect(yield* Effect.result(f.service.decode(new Uint8Array(50 * 1024 * 1024 + 1)))).toMatchObject({ _tag: "Failure", failure: { code: "limit-exceeded" } })
    expect(yield* Effect.result(f.service.decode(new Uint8Array([1, 2, 3])))).toMatchObject({ _tag: "Failure", failure: { code: "invalid-archive" } })
    const missing = yield* MineruArchiveReader.pipe(Effect.provide(MineruArchiveReader.layer({ pythonBin: f.path.join(f.root, "missing"), tempDirectory: f.tempDirectory })))
    const outcome = yield* Effect.result(missing.decode(yield* f.fs.readFile(f.source)))
    expect(outcome).toMatchObject({ _tag: "Failure", failure: { code: "processing-unavailable" } })
    expect(JSON.stringify(outcome)).not.toContain(f.root)
    expect(yield* f.fs.readDirectory(f.tempDirectory)).toEqual([])
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { timeout: 30000 })

  it.live("supervises actual child RSS and kills an over-limit worker", () => Effect.gen(function* () {
    const f = yield* setup()
    // Exercise the production supervisor with a lowered test threshold, avoiding a 1 GiB allocation.
    const script = MINERU_ARCHIVE_SCRIPT.replace("MEMORY_BYTES = 1024 ** 3", "MEMORY_BYTES = 32 * 1024 * 1024").replace("supervise(sys.argv[1])", 'def worker(root):\n    with open(os.path.join(root, "memory-pid"), "w") as output: output.write(str(os.getpid()))\n    allocation = bytearray(80 * 1024 * 1024)\n    time.sleep(60)\nsupervise(sys.argv[1])')
    const result = yield* command(f.pythonBin, ["-I", "-c", script, f.root]).pipe(Effect.timeout("5 seconds"))
    expect(result.code).toBe(0)
    expect(JSON.parse(result.output)).toEqual({ _tag: "Rejected", code: "limit-exceeded" })
    const pid = yield* f.fs.readFileString(f.path.join(f.root, "memory-pid"))
    expect((yield* command("/bin/ps", ["-o", "pid=", "-p", pid])).output.trim()).toBe("")
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  for (const mode of ["cancel", "deadline"] as const) {
    it.live(`cleans archive worker process groups and private output on ${mode}`, () => Effect.gen(function* () {
      const f = yield* setup()
      const wrapper = f.path.join(f.root, "waiting-runtime")
      const pidsFile = f.path.join(f.root, "worker-pids")
      yield* f.fs.writeFileString(wrapper, `#!/bin/sh\nprintf '%s\\n' "$$" >> '${pidsFile}.starts'\nprintf partial > "$4/middle.json"\n/bin/sleep 60 &\nprintf '%s\\n%s\\n' "$$" "$!" > '${pidsFile}.pending'\n/bin/mv '${pidsFile}.pending' '${pidsFile}'\nwait\n`, { mode: 0o700 })
      const reader = yield* MineruArchiveReader.pipe(Effect.provide(MineruArchiveReader.layer({ pythonBin: wrapper, tempDirectory: f.tempDirectory })))
      const clock = yield* Clock.Clock
      const deadlines: Array<number> = []
      const ready = waitForWorker(f.fs, f.path, f.tempDirectory, pidsFile)
      const accelerated: Clock.Clock = {
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(), currentTimeMillis: clock.currentTimeMillis,
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(), currentTimeNanos: clock.currentTimeNanos,
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(), monotonicTimeNanos: clock.monotonicTimeNanos,
        sleep: (duration) => {
          const milliseconds = Duration.toMillis(duration)
          if (milliseconds !== 30000) return clock.sleep(duration)
          deadlines.push(milliseconds)
          return ready.pipe(Effect.asVoid, Effect.orDie)
        },
      }
      const operation = reader.decode(yield* f.fs.readFile(f.source))
      if (mode === "deadline") {
        expect(yield* operation.pipe(Effect.provideService(Clock.Clock, accelerated), Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: "limit-exceeded" } })
        expect(deadlines).toEqual([30000])
      }
      else {
        const fiber = yield* operation.pipe(Effect.forkScoped)
        const pids = yield* ready
        for (const pid of pids) expect((yield* command("/bin/ps", ["-o", "pid=", "-p", pid])).output.trim()).toBe(pid)
        yield* Fiber.interrupt(fiber)
      }
      const pids = (yield* f.fs.readFileString(pidsFile)).trim().split("\n")
      expect(pids).toHaveLength(2)
      expect((yield* f.fs.readFileString(pidsFile + ".starts")).trim()).toBe(pids[0])
      for (const pid of pids) expect((yield* command("/bin/ps", ["-o", "pid=", "-p", pid])).output.trim()).toBe("")
      expect(yield* f.fs.readDirectory(f.tempDirectory)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
  }
})
