import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Clock, Duration, Effect, Fiber, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { convertMineruResponse, MineruArchiveReader, type RenderedPage } from "../../../src/paper/providers/mineru/index.ts"
import { MINERU_ARCHIVE_SCRIPT } from "../../../src/paper/providers/mineru/archive-script.ts"
import { ArtifactHash } from "../../../src/domain/index.ts"
import { contractFixture } from "../../fixtures/contracts.ts"
import middle from "./fixtures/document_middle.json" with { type: "json" }
import manifest from "./fixtures/seaborn-archive-manifest.json" with { type: "json" }

const setup = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ directory: path.resolve("data"), prefix: "archive-tests-" })
  const tempDirectory = path.join(root, "private")
  yield* fs.makeDirectory(tempDirectory, { mode: 0o700 })
  const pythonBin = path.resolve("data/python/.venv/bin/python")
  const source = path.resolve("tests/paper/mineru/fixtures/seaborn-download.zip")
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const process = yield* spawner.spawn(ChildProcess.make(pythonBin, ["-I", path.resolve("tests/paper/mineru/archive-fixtures.py"), source, root]))
  const result = yield* Effect.all({ code: process.exitCode, output: process.all.pipe(Stream.decodeText(), Stream.mkString) }, { concurrency: "unbounded" })
  expect(result).toEqual({ code: 0, output: "" })
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
  it.effect("decodes the saved nested archive, binds native bytes, and cleans temporary files", () => Effect.gen(function* () {
    const f = yield* setup()
    const result = yield* f.service.decode(yield* f.fs.readFile(f.source))
    expect(result.middle).toEqual(middle)
    expect(result.manifest.entries).toEqual(manifest.entries)
    expect(result.manifest.compressedByteCount).toBe(330659)
    expect(result.assets).toHaveLength(1)
    expect(result.assets[0]?.artifact.mediaType).toBe("image/jpeg")
    expect(result.assets[0]?.artifact.path.endsWith(".jpeg")).toBe(true)
    expect(result.assets[0]?.artifact.hash).toBe(manifest.nativeAssets[0]?.artifact.hash)
    expect(result.assets[0]?.bytes).toEqual(new Uint8Array(yield* f.fs.readFile(f.path.resolve("tests/paper/mineru/fixtures/page_1_image_4.jpg"))))
    expect(yield* f.fs.readDirectory(f.tempDirectory)).toEqual([])
    expect((yield* f.service.decode(yield* f.fs.readFile(f.path.join(f.root, "empty-ancillary.zip"))))).toBeDefined()
    const unreferenced = yield* f.service.decode(yield* f.fs.readFile(f.path.join(f.root, "unreferenced-image.zip")))
    expect(unreferenced.assets).toHaveLength(1)
    expect(unreferenced.manifest.entries.some((entry) => entry.path === "images/other.jpg")).toBe(true)
    const base = contractFixture()
    const renderedPages = middle.extensions.docvortex_layout.pages.map((page): RenderedPage => ({ pageNumber: page.page_idx + 1, width: 2481, height: 3508, dpi: 300, widthPoints: page.width_pt, heightPoints: page.height_pt, rotation: 0, image: { path: `pages/page-${page.page_idx + 1}.png`, mediaType: "image/png", byteCount: 100, hash: ArtifactHash.make("a".repeat(64)) } }))
    const converted = yield* convertMineruResponse({ document: { ...base.document, pageCount: 4 }, runId: base.run.id, middle: unreferenced.middle, archive: unreferenced.manifest, renderedPages })
    expect(converted.extraction.sourceBlocks).toHaveLength(62)
    expect(converted.extraction.figures).toHaveLength(1)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { timeout: 30000 })

  it.effect("fails whole hostile archives before returning materialized members", () => Effect.gen(function* () {
    const f = yield* setup()
    for (const name of ["traversal", "absolute", "backslash", "case-collision", "parent-case-collision", "file-parent", "parent-file", "symlink", "unexpected-zip", "disguised-zip", "embedded-pdf", "nested-zip", "native-disagreement", "missing-middle", "encrypted", "bad-crc", "corrupt-image", "duplicate-json"]) {
      const outcome = yield* Effect.result(f.service.decode(yield* f.fs.readFile(f.path.join(f.root, `${name}.zip`))))
      expect(outcome, name).toMatchObject({ _tag: "Failure", failure: { code: "invalid-archive" } })
      expect(yield* f.fs.readDirectory(f.tempDirectory)).toEqual([])
    }
    for (const name of ["too-many", "aggregate-expansion"]) expect(yield* Effect.result(f.service.decode(yield* f.fs.readFile(f.path.join(f.root, `${name}.zip`))))).toMatchObject({ _tag: "Failure", failure: { code: "limit-exceeded" } })
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { timeout: 30000 })

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
