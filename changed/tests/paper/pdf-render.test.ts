import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Clock, Crypto, Duration, Effect, Fiber, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { ArtifactHash, SourceHash } from "../../src/domain/index.ts"
import { extractionPage } from "../../src/paper/extraction/index.ts"
import { PdfRenderer, PdfRenderLimits } from "../../src/paper/pdf/render.ts"

const GENERATE = String.raw`
import os
import sys
from pathlib import Path
import pymupdf
root = Path(sys.argv[1])
os.umask(0o077)

def quadrants(width, height, rotation):
    document = pymupdf.open()
    page = document.new_page(width=width, height=height)
    for box, color in [((0,0,width/2,height/2),(1,0,0)), ((width/2,0,width,height/2),(0,1,0)),
                       ((0,height/2,width/2,height),(0,0,1)), ((width/2,height/2,width,height),(1,1,0))]:
        page.draw_rect(pymupdf.Rect(box), color=color, fill=color)
    page.set_rotation(rotation)
    return document

with quadrants(240,120,0) as document:
    document.save(root / "rectangle-0.pdf")
with quadrants(2000,1000,0) as document:
    document.save(root / "large.pdf")
with quadrants(240,120,0) as document:
    document.new_page(width=240,height=120)
    document.save(root / "mixed.pdf")
with quadrants(240,120,0) as document:
    document.save(root / "encrypted.pdf", encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="")
with pymupdf.open() as document:
    pixels=pymupdf.Pixmap(pymupdf.csRGB,pymupdf.IRect(0,0,8,8),False)
    pixels.clear_with(0)
    page=document.new_page(width=120,height=120)
    page.insert_image(pymupdf.Rect(30,30,90,90),pixmap=pixels)
    document.save(root / "scan.pdf")
`

const INSPECT = String.raw`
import hashlib
import json
import os
import sys
import pymupdf
results=[]
for path in json.loads(sys.argv[1]):
    image=pymupdf.Pixmap(path)
    with open(path,"rb") as source:
        data=source.read()
    results.append({"width":image.width,"height":image.height,"dpi":image.xres,"bytes":len(data),
                    "mode":os.stat(path).st_mode & 0o777,"hash":hashlib.sha256(data).hexdigest(),
                    "corners":[list(image.pixel(int(image.width*x),int(image.height*y)))
                               for x,y in [(0.1,0.1),(0.9,0.1),(0.1,0.9),(0.9,0.9)]],
                    "center":list(image.pixel(image.width//2,image.height//2))})
print(json.dumps(results))
`

const PngInspection = Schema.Array(Schema.Struct({
  width: Schema.Int, height: Schema.Int, dpi: Schema.Int, bytes: Schema.Int, mode: Schema.Int,
  hash: Schema.String, corners: Schema.Array(Schema.Array(Schema.Int)), center: Schema.Array(Schema.Int),
}))

const command = Effect.fnUntraced(function* (executable: string, args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const process = yield* spawner.spawn(ChildProcess.make(executable, args, { forceKillAfter: "100 millis" }))
  const output = yield* process.all.pipe(Stream.decodeText(), Stream.mkString)
  return { output, code: yield* process.exitCode }
}, Effect.scoped)

const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-render-" })
  const pythonBin = path.resolve("data/python/.venv/bin/python")
  expect(yield* command(pythonBin, ["-I", "-c", GENERATE, root])).toEqual({ code: 0, output: "" })
  const input = Effect.fnUntraced(function* (name: string, pageCount = 1) {
    const privatePath = path.join(root, name + ".pdf")
    const bytes = yield* fs.readFile(privatePath)
    const digest = yield* crypto.digest("SHA-256", bytes)
    const sourceHash = yield* Schema.decodeUnknownEffect(SourceHash)(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""))
    const outputDirectory = path.join(root, name + "-run")
    yield* fs.makeDirectory(outputDirectory, { mode: 0o700 })
    return { privatePath, byteCount: bytes.length, sourceHash, pageCount, outputDirectory }
  })
  const inspect = Effect.fnUntraced(function* (paths: readonly string[]) {
    const result = yield* command(pythonBin, ["-I", "-c", INSPECT, JSON.stringify(paths)])
    expect(result.code).toBe(0)
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PngInspection))(result.output)
  })
  return { fs, path, root, pythonBin, input, inspect }
})

const red = [255, 0, 0]
const green = [0, 255, 0]
const blue = [0, 0, 255]
const yellow = [255, 255, 0]

const cancellationScript = (pidsFile: string, partialFile: string) => `#!/bin/sh\nprintf '%s\\n' "$$" >> '${pidsFile}.starts'\nprintf partial > '${partialFile}'\n/bin/sleep 60 &\nprintf '%s\\n%s\\n' "$$" "$!" > '${pidsFile}.pending'\n/bin/mv '${pidsFile}.pending' '${pidsFile}'\nwait\n`
const waitForPids = (fs: FileSystem.FileSystem, pidsFile: string) => Effect.gen(function* () {
  while (!(yield* fs.exists(pidsFile))) yield* Effect.sleep("10 millis")
  const pids = (yield* fs.readFileString(pidsFile)).trim().split("\n")
  expect(pids).toHaveLength(2)
  expect(new Set(pids).size).toBe(2)
  for (const pid of pids) expect(pid).toMatch(/^[1-9]\d*$/u)
  return pids
}).pipe(Effect.timeout("5 seconds"))

describe("private PDF page rendering", () => {
  it.effect("bounds the longest side and records reduced scaling DPI", () => Effect.gen(function* () {
    const f = yield* fixture()
    const request = yield* f.input("large")
    const pages = yield* Effect.gen(function* () { return yield* (yield* PdfRenderer).render(request) }).pipe(Effect.provide(PdfRenderer.layer(f)))
    expect(pages[0]).toMatchObject({ width: 3300, height: 1650, dpi: 118.8, widthPoints: 2000, heightPoints: 1000, physicalRotation: 0 })
    const [actual] = yield* f.inspect([f.path.join(request.outputDirectory, "pages/page-001.png")])
    expect(actual).toMatchObject({ width: 3300, height: 1650, dpi: 119, corners: [red, green, blue, yellow] })
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("keeps scans and blank physical pages with verified PNG hashes", () => Effect.gen(function* () {
    const f = yield* fixture()
    const renderer = yield* PdfRenderer.pipe(Effect.provide(PdfRenderer.layer(f)))
    const scan = yield* f.input("scan")
    const mixed = yield* f.input("mixed", 2)
    expect(yield* renderer.render(scan)).toHaveLength(1)
    const mixedPages = yield* renderer.render(mixed)
    expect(mixedPages.map((page) => page.pageNumber)).toEqual([1, 2])
    const [actualScan, blank] = yield* f.inspect([f.path.join(scan.outputDirectory, "pages/page-001.png"), f.path.join(mixed.outputDirectory, "pages/page-002.png")])
    expect(actualScan).toMatchObject({ center: [0, 0, 0], corners: [[255, 255, 255], [255, 255, 255], [255, 255, 255], [255, 255, 255]] })
    expect(blank).toMatchObject({ center: [255, 255, 255], hash: mixedPages[1]?.image.hash })
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("renders only the selected original page with its physical page number", () => Effect.gen(function* () {
    const f = yield* fixture()
    const renderer = yield* PdfRenderer.pipe(Effect.provide(PdfRenderer.layer(f)))
    const request = yield* f.input("mixed", 2)
    for (const pageNumber of [0, 3, 1.5]) expect(yield* Effect.result(renderer.render({ ...request, pageNumber }))).toMatchObject({ _tag: "Failure", failure: { code: "invalid-input" } })
    const pages = yield* renderer.render({ ...request, pageNumber: 2 })
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ pageNumber: 2, image: { path: "pages/page-002.png" } })
    expect(yield* f.fs.readDirectory(f.path.join(request.outputDirectory, "pages"))).toEqual(["page-002.png"])
    const [image] = yield* f.inspect([f.path.join(request.outputDirectory, "pages/page-002.png")])
    expect(image).toMatchObject({ center: [255, 255, 255], corners: [[255, 255, 255], [255, 255, 255], [255, 255, 255], [255, 255, 255]] })
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("rejects changed bytes, wrong page count, encryption, and unsafe private sources without output", () => Effect.gen(function* () {
    const f = yield* fixture()
    const renderer = yield* PdfRenderer.pipe(Effect.provide(PdfRenderer.layer(f)))
    const normal = yield* f.input("rectangle-0")
    for (const request of [{ ...normal, byteCount: 1 }, { ...normal, sourceHash: SourceHash.make("0".repeat(64)) }, { ...normal, pageCount: 2 }]) {
      expect(yield* Effect.result(renderer.render(request))).toMatchObject({ _tag: "Failure", failure: { code: "invalid-input" } })
      expect(yield* f.fs.readDirectory(normal.outputDirectory)).toEqual([])
    }
    const encrypted = yield* f.input("encrypted")
    expect(yield* Effect.result(renderer.render(encrypted))).toMatchObject({ _tag: "Failure", failure: { code: "encrypted-pdf" } })
    yield* f.fs.symlink(normal.privatePath, f.path.join(f.root, "link.pdf"))
    expect(yield* Effect.result(renderer.render({ ...normal, privatePath: f.path.join(f.root, "link.pdf") }))).toMatchObject({ _tag: "Failure", failure: { code: "storage-failed" } })
    yield* f.fs.chmod(normal.privatePath, 0o644)
    expect(yield* Effect.result(renderer.render(normal))).toMatchObject({ _tag: "Failure", failure: { code: "storage-failed" } })
    expect(yield* f.fs.readDirectory(normal.outputDirectory)).toEqual([])
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("refuses existing or symlinked output and preserves unrelated files", () => Effect.gen(function* () {
    const f = yield* fixture()
    const renderer = yield* PdfRenderer.pipe(Effect.provide(PdfRenderer.layer(f)))
    const request = yield* f.input("rectangle-0")
    const output = f.path.join(request.outputDirectory, "pages")
    yield* f.fs.makeDirectory(output, { mode: 0o700 })
    yield* f.fs.writeFileString(f.path.join(output, "keep.txt"), "existing")
    expect(yield* Effect.result(renderer.render(request))).toMatchObject({ _tag: "Failure", failure: { code: "storage-failed" } })
    expect(yield* f.fs.readFileString(f.path.join(output, "keep.txt"))).toBe("existing")
    const alias = f.path.join(f.root, "alias")
    yield* f.fs.symlink(request.outputDirectory, alias)
    expect(yield* Effect.result(renderer.render({ ...request, outputDirectory: alias }))).toMatchObject({ _tag: "Failure", failure: { code: "storage-failed" } })
    expect(yield* Effect.result(renderer.render({ ...request, outputDirectory: "relative" }))).toMatchObject({ _tag: "Failure", failure: { code: "invalid-input" } })
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("rejects crop source tampering, wrong dimensions, and unsafe sources before creating output", () => Effect.gen(function* () {
    const f = yield* fixture()
    const renderer = yield* PdfRenderer.pipe(Effect.provide(PdfRenderer.layer(f)))
    const request = yield* f.input("rectangle-0")
    const [rendered] = yield* renderer.render(request)
    if (rendered === undefined) return yield* Effect.die("Expected source page")
    const page = extractionPage(rendered)
    const privatePath = f.path.join(request.outputDirectory, page.image.path)
    const outputPath = f.path.join(request.outputDirectory, "figure.png")
    const crop = { privatePath, outputPath, page, box: { coordinateSystem: "rendered-page-top-left-pixels" as const, x: 10, y: 20, width: 100, height: 80 } }
    for (const changed of [{ ...page, image: { ...page.image, hash: ArtifactHash.make("0".repeat(64)) } }, { ...page, width: page.width - 1 }]) {
      expect(yield* Effect.result(renderer.crop({ ...crop, page: changed }))).toMatchObject({ _tag: "Failure", failure: { code: "invalid-input" } })
      expect(yield* f.fs.exists(outputPath)).toBe(false)
    }
    const link = f.path.join(request.outputDirectory, "source-link.png")
    yield* f.fs.symlink(privatePath, link)
    expect(yield* Effect.result(renderer.crop({ ...crop, privatePath: link }))).toMatchObject({ _tag: "Failure", failure: { code: "invalid-input" } })
    yield* f.fs.chmod(privatePath, 0o644)
    expect(yield* Effect.result(renderer.crop(crop))).toMatchObject({ _tag: "Failure", failure: { code: "invalid-input" } })
    expect(yield* f.fs.exists(outputPath)).toBe(false)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("preserves an existing crop output and writes a new bounded region privately", () => Effect.gen(function* () {
    const f = yield* fixture()
    const renderer = yield* PdfRenderer.pipe(Effect.provide(PdfRenderer.layer(f)))
    const request = yield* f.input("rectangle-0")
    const [rendered] = yield* renderer.render(request)
    if (rendered === undefined) return yield* Effect.die("Expected source page")
    const page = extractionPage(rendered)
    const outputPath = f.path.join(request.outputDirectory, "figure.png")
    const crop = { privatePath: f.path.join(request.outputDirectory, page.image.path), outputPath, page, box: { coordinateSystem: "rendered-page-top-left-pixels" as const, x: 10, y: 20, width: 100, height: 80 } }
    yield* f.fs.writeFileString(outputPath, "existing", { flag: "wx", mode: 0o600 })
    expect(yield* Effect.result(renderer.crop(crop))).toMatchObject({ _tag: "Failure", failure: { code: "processing-unavailable" } })
    expect(yield* f.fs.readFileString(outputPath)).toBe("existing")
    const fresh = f.path.join(request.outputDirectory, "fresh.png")
    const result = yield* renderer.crop({ ...crop, outputPath: fresh })
    const [actual] = yield* f.inspect([fresh])
    expect(actual).toMatchObject({ width: 100, height: 80, hash: result.hash, bytes: result.byteCount, mode: 0o600, center: red })
    expect(yield* f.fs.readFileString(outputPath)).toBe("existing")
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("fails closed on missing runtime, invalid response, or excess stdout/stderr and cleans output", () => Effect.gen(function* () {
    const f = yield* fixture()
    const request = yield* f.input("rectangle-0")
    const wrapper = f.path.join(f.root, "fake-runtime")
    for (const script of ["printf 'not-json'", "/usr/bin/head -c 65537 /dev/zero", "/usr/bin/head -c 65537 /dev/zero >&2"]) {
      yield* f.fs.writeFileString(wrapper, "#!/bin/sh\n" + script + "\n", { mode: 0o700 })
      const result = yield* Effect.gen(function* () { return yield* (yield* PdfRenderer).render(request) }).pipe(Effect.provide(PdfRenderer.layer({ pythonBin: wrapper })), Effect.result)
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: script.startsWith("printf") ? "processing-unavailable" : "limit-exceeded" } })
      expect(yield* f.fs.readDirectory(request.outputDirectory)).toEqual([])
    }
    expect(yield* Effect.gen(function* () { return yield* (yield* PdfRenderer).render(request) }).pipe(Effect.provide(PdfRenderer.layer({ pythonBin: "/missing-runtime" })), Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: "processing-unavailable" } })
    expect(yield* f.fs.readDirectory(request.outputDirectory)).toEqual([])
    expect(PdfRenderLimits.timeoutMs).toBe(120_000)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("cancels the whole process group before removing partially written pages", () => Effect.gen(function* () {
    const f = yield* fixture()
    const request = yield* f.input("rectangle-0")
    const wrapper = f.path.join(f.root, "wait-for-cancellation")
    const pidsFile = f.path.join(f.root, "pids")
    const partialFile = f.path.join(request.outputDirectory, "pages/page-001.png")
    yield* f.fs.writeFileString(wrapper, cancellationScript(pidsFile, partialFile), { mode: 0o700 })
    const fiber = yield* Effect.gen(function* () { return yield* (yield* PdfRenderer).render(request) }).pipe(Effect.provide(PdfRenderer.layer({ pythonBin: wrapper })), Effect.forkScoped)
    const pids = yield* waitForPids(f.fs, pidsFile)
    expect(yield* f.fs.readFileString(partialFile)).toBe("partial")
    for (const pid of pids) expect((yield* command("/bin/ps", ["-o", "pid=", "-p", pid])).output.trim()).toBe(pid)
    yield* Fiber.interrupt(fiber)
    expect((yield* f.fs.readFileString(pidsFile + ".starts")).trim()).toBe(pids[0])
    for (const pid of pids) expect((yield* command("/bin/ps", ["-o", "pid=", "-p", pid])).output.trim()).toBe("")
    expect(yield* f.fs.readDirectory(request.outputDirectory)).toEqual([])
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("enforces the configured deadline and removes partial output without retrying", () => Effect.gen(function* () {
    const f = yield* fixture()
    const request = yield* f.input("rectangle-0")
    const wrapper = f.path.join(f.root, "wait-for-timeout")
    const pidsFile = f.path.join(f.root, "timeout-pids")
    yield* f.fs.writeFileString(wrapper, cancellationScript(pidsFile, f.path.join(request.outputDirectory, "pages/page-001.png")), { mode: 0o700 })
    const clock = yield* Clock.Clock
    const deadlines: number[] = []
    const accelerated: Clock.Clock = {
      currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(), currentTimeMillis: clock.currentTimeMillis,
      currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(), currentTimeNanos: clock.currentTimeNanos,
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(), monotonicTimeNanos: clock.monotonicTimeNanos,
      sleep: (duration) => {
      const milliseconds = Duration.toMillis(duration)
      if (milliseconds === PdfRenderLimits.timeoutMs) {
        deadlines.push(milliseconds)
        return waitForPids(f.fs, pidsFile).pipe(Effect.asVoid, Effect.orDie)
      }
      return clock.sleep(duration)
    } }
    const result = yield* Effect.gen(function* () { return yield* (yield* PdfRenderer).render(request) }).pipe(
      Effect.provide(PdfRenderer.layer({ pythonBin: wrapper })), Effect.provideService(Clock.Clock, accelerated), Effect.result,
    )
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "limit-exceeded" } })
    expect(deadlines).toEqual([120_000])
    const pids = (yield* f.fs.readFileString(pidsFile)).trim().split("\n")
    expect(pids).toHaveLength(2)
    expect((yield* f.fs.readFileString(pidsFile + ".starts")).trim()).toBe(pids[0])
    for (const pid of pids) expect((yield* command("/bin/ps", ["-o", "pid=", "-p", pid])).output.trim()).toBe("")
    expect(yield* f.fs.readDirectory(request.outputDirectory)).toEqual([])
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
