import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, FileSystem, Path, Result, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { PdfInspector, PdfLimits } from "../../../src/paper/pdf/index.ts"

const command = Effect.fnUntraced(function* (executable: string, args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(ChildProcess.make(executable, args, { forceKillAfter: "100 millis" }))
  const output = yield* handle.all.pipe(Stream.decodeText(), Stream.mkString)
  return { output, code: yield* handle.exitCode }
}, Effect.scoped)

const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-pdf-" })
  const pythonBin = path.resolve("data/python/.venv/bin/python")
  const generation = yield* command(pythonBin, ["-I", path.resolve("tests/paper/pdf/generate-fixtures.py"), root])
  expect(generation, "Install the pinned Python environment documented in python/README.md").toEqual({ code: 0, output: "" })
  const inspect = Effect.fnUntraced(function* (name: string, byteCount?: number) {
    const privatePath = path.join(root, name + ".pdf")
    const info = yield* fs.stat(privatePath)
    const service = yield* PdfInspector
    return yield* service.inspect({ privatePath, byteCount: byteCount ?? Number(info.size) })
  })
  return { fs, path, root, pythonBin, inspect }
})

describe("real local PDF admission", () => {
  it.effect("accepts text, scanned images, mixed blank pages, and content without visible ink", () => Effect.gen(function* () {
    const f = yield* fixture()
    for (const name of ["normal", "scan", "mixed", "white", "annotation", "invisible", "repaired"]) {
      const result = yield* f.inspect(name).pipe(Effect.provide(PdfInspector.layer(f)))
      expect(result.pageCount).toBe(name === "mixed" ? 2 : 1)
      expect(result.pages).toHaveLength(result.pageCount)
      expect(result.repaired).toBe(name === "repaired")
    }
    expect(yield* f.inspect("rotated").pipe(Effect.provide(PdfInspector.layer(f)))).toMatchObject({ pages: [{ widthPoints: 700, heightPoints: 300, rotation: 90 }] })
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { timeout: 20000 })

  it.effect("rejects encrypted PDFs including empty passwords, malformed files, and empty content", () => Effect.gen(function* () {
    const f = yield* fixture()
    for (const [name, expected] of [
      ["encrypted", "encrypted-pdf"], ["empty-password", "encrypted-pdf"], ["wrong-magic", "unsupported-pdf"],
      ["malformed", "unsupported-pdf"], ["zero-byte", "empty-document"], ["zero-pages", "empty-document"],
      ["blank", "empty-document"], ["false-count", "unsupported-pdf"], ["damaged-content", "unsupported-pdf"],
    ] as const) {
      const result = yield* Effect.result(f.inspect(name).pipe(Effect.provide(PdfInspector.layer(f))))
      expect(result, name).toMatchObject({ _tag: "Failure", failure: { code: expected } })
      if (Result.isFailure(result)) expect(result.failure.message).not.toContain(f.root)
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { timeout: 20000 })

  it.effect("enforces exact byte and page ceilings and image/page resource ceilings", () => Effect.gen(function* () {
    const f = yield* fixture()
    expect((yield* f.inspect("fifty").pipe(Effect.provide(PdfInspector.layer(f)))).pageCount).toBe(50)
    for (const name of ["fifty-one", "huge-page", "huge-image"]) {
      expect(yield* Effect.result(f.inspect(name).pipe(Effect.provide(PdfInspector.layer(f)))), name).toMatchObject({ _tag: "Failure", failure: { code: "limit-exceeded" } })
    }
    const privatePath = f.path.join(f.root, "normal.pdf")
    yield* f.fs.truncate(privatePath, PdfLimits.maxBytes)
    expect((yield* f.inspect("normal").pipe(Effect.provide(PdfInspector.layer(f)))).pageCount).toBe(1)
    yield* f.fs.truncate(privatePath, PdfLimits.maxBytes + 1)
    expect(yield* Effect.result(f.inspect("normal").pipe(Effect.provide(PdfInspector.layer(f))))).toMatchObject({ _tag: "Failure", failure: { code: "limit-exceeded" } })
    expect(yield* Effect.result(f.inspect("normal", 200).pipe(Effect.provide(PdfInspector.layer(f))))).toMatchObject({ _tag: "Failure", failure: { code: "limit-exceeded" } })
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { timeout: 20000 })

  it.effect("requires the staged byte count, an absolute path, and a private regular file", () => Effect.gen(function* () {
    const f = yield* fixture()
    const layer = PdfInspector.layer(f)
    expect(yield* Effect.result(f.inspect("normal", 1).pipe(Effect.provide(layer)))).toMatchObject({ _tag: "Failure", failure: { code: "invalid-input" } })
    yield* f.fs.symlink(f.path.join(f.root, "normal.pdf"), f.path.join(f.root, "link.pdf"))
    expect(yield* Effect.result(f.inspect("link").pipe(Effect.provide(layer)))).toMatchObject({ _tag: "Failure", failure: { code: "storage-failed" } })
    yield* f.fs.chmod(f.path.join(f.root, "normal.pdf"), 0o644)
    expect(yield* Effect.result(f.inspect("normal").pipe(Effect.provide(layer)))).toMatchObject({ _tag: "Failure", failure: { code: "storage-failed" } })
    for (const privatePath of ["relative.pdf", "file:///private.pdf", "https://example.test/document.pdf", "bad\0path"]) {
      const result = yield* Effect.gen(function* () { return yield* (yield* PdfInspector).inspect({ privatePath, byteCount: 1 }) }).pipe(Effect.provide(layer), Effect.result)
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "invalid-input" } })
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("reports unavailable runtime and rejects corrupt subprocess output", () => Effect.gen(function* () {
    const f = yield* fixture()
    for (const pythonBin of [f.path.join(f.root, "missing-python"), "/usr/bin/false"]) {
      expect(yield* Effect.result(f.inspect("normal").pipe(Effect.provide(PdfInspector.layer({ pythonBin }))))).toMatchObject({ _tag: "Failure", failure: { code: "processing-unavailable" } })
    }
    const wrapper = f.path.join(f.root, "invalid-output")
    yield* f.fs.writeFileString(wrapper, "#!/bin/sh\nprintf 'not-json'\n", { mode: 0o700 })
    expect(yield* Effect.result(f.inspect("normal").pipe(Effect.provide(PdfInspector.layer({ pythonBin: wrapper }))))).toMatchObject({ _tag: "Failure", failure: { code: "processing-unavailable" } })
    yield* f.fs.writeFileString(wrapper, "#!/bin/sh\n/usr/bin/head -c 65537 /dev/zero\n")
    expect(yield* Effect.result(f.inspect("normal").pipe(Effect.provide(PdfInspector.layer({ pythonBin: wrapper }))))).toMatchObject({ _tag: "Failure", failure: { code: "limit-exceeded" } })
    yield* f.fs.writeFileString(wrapper, "#!/bin/sh\n/usr/bin/head -c 65537 /dev/zero >&2\n")
    expect(yield* Effect.result(f.inspect("normal").pipe(Effect.provide(PdfInspector.layer({ pythonBin: wrapper }))))).toMatchObject({ _tag: "Failure", failure: { code: "limit-exceeded" } })
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("requires the installed PyMuPDF version without installing dependencies at runtime", () => Effect.gen(function* () {
    const f = yield* fixture()
    const emptyEnvironment = f.path.join(f.root, "empty-environment")
    expect((yield* command(f.pythonBin, ["-I", "-m", "venv", "--without-pip", emptyEnvironment])).code).toBe(0)
    const pythonBin = f.path.join(emptyEnvironment, "bin", "python")
    expect(yield* Effect.result(f.inspect("normal").pipe(Effect.provide(PdfInspector.layer({ pythonBin }))))).toMatchObject({ _tag: "Failure", failure: { code: "processing-unavailable" } })
    const metadata = f.path.join(emptyEnvironment, "lib", "python3.14", "site-packages", "pymupdf-1.0.dist-info")
    yield* f.fs.makeDirectory(metadata)
    yield* f.fs.writeFileString(f.path.join(metadata, "METADATA"), "Metadata-Version: 2.1\nName: pymupdf\nVersion: 1.0\n")
    expect(yield* Effect.result(f.inspect("normal").pipe(Effect.provide(PdfInspector.layer({ pythonBin }))))).toMatchObject({ _tag: "Failure", failure: { code: "processing-unavailable" } })
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("kills the inspector process group when the caller cancels", () => Effect.gen(function* () {
    const f = yield* fixture()
    const wrapper = f.path.join(f.root, "wait-for-cancellation")
    const pidsFile = f.path.join(f.root, "pids")
    yield* f.fs.writeFileString(wrapper, `#!/bin/sh\necho $$ > '${pidsFile}'\n/bin/sleep 60 &\necho $! >> '${pidsFile}'\nwait\n`, { mode: 0o700 })
    const fiber = yield* f.inspect("normal").pipe(Effect.provide(PdfInspector.layer({ pythonBin: wrapper })), Effect.forkScoped)
    yield* Effect.sleep("100 millis")
    const pids = (yield* f.fs.readFileString(pidsFile)).trim().split("\n")
    expect(pids).toHaveLength(2)
    yield* Fiber.interrupt(fiber)
    for (const pid of pids) expect((yield* command("/bin/ps", ["-o", "pid=", "-p", pid])).output.trim()).toBe("")
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("times out once and kills descendants without retrying", () => Effect.gen(function* () {
    const f = yield* fixture()
    const wrapper = f.path.join(f.root, "wait-for-timeout")
    const pidsFile = f.path.join(f.root, "pids")
    yield* f.fs.writeFileString(wrapper, `#!/bin/sh\necho $$ >> '${pidsFile}'\n/bin/sleep 60 &\necho $! >> '${pidsFile}'\nwait\n`, { mode: 0o700 })
    expect(yield* Effect.result(f.inspect("normal").pipe(Effect.provide(PdfInspector.layer({ pythonBin: wrapper }))))).toMatchObject({ _tag: "Failure", failure: { code: "limit-exceeded" } })
    const pids = (yield* f.fs.readFileString(pidsFile)).trim().split("\n")
    expect(pids).toHaveLength(2)
    for (const pid of pids) expect((yield* command("/bin/ps", ["-o", "pid=", "-p", pid])).output.trim()).toBe("")
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { timeout: 15000 })
})
