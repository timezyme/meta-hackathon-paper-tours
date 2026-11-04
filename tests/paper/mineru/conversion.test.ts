import { Crypto, Effect, FileSystem, Predicate, Schema } from "effect"
import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ArtifactHash, RunId, validateExtraction } from "../../../src/domain/index.ts"
import { convertMineruResponse, MineruLimits } from "../../../src/paper/providers/mineru/index.ts"
import type { MineruArchiveManifest, RenderedPage } from "../../../src/paper/providers/mineru/index.ts"
import { contractFixture } from "../../fixtures/contracts.ts"
import savedMiddle from "./fixtures/document_middle.json" with { type: "json" }
import savedArchive from "./fixtures/seaborn-archive-manifest.json" with { type: "json" }
import { MineruArchiveManifest as ArchiveSchema } from "../../../src/paper/providers/mineru/index.ts"

const hash = ArtifactHash.make("a".repeat(64))
const text = (content: string, index = 0) => ({ type: "text", index, bbox: [0.1, 0.2, 0.4, 0.6], content: [{ type: "text", content }] })
const makeInput = (blocks: ReadonlyArray<unknown> = [text("Original text.")]) => {
  const fixture = contractFixture()
  const archive: MineruArchiveManifest = { compressedByteCount: 10, middlePath: "document_middle.json", entries: [{ _tag: "file", path: "document_middle.json", byteCount: 10, hash }], nativeAssets: [] }
  const renderedPages: ReadonlyArray<RenderedPage> = [{ pageNumber: 1, width: 1200, height: 1600, dpi: 144, widthPoints: 600, heightPoints: 800, rotation: 0, image: { path: "pages/page-001.png", mediaType: "image/png", byteCount: 10, hash } }]
  return {
    document: { ...fixture.document, pageCount: 1 }, runId: fixture.run.id, archive, renderedPages,
    middle: { schema: "docvortex.middle", schema_version: "2.0", metadata: { file_suffix: "pdf", producer: { name: "mineru", version: "4.0.12" }, document: { page_count: 1, page_count_kind: "physical" } }, extensions: { docvortex_layout: { version: 1, pages: [{ page_idx: 0, width_pt: 600, height_pt: 800 }] } }, is_full_document: true, pages: [{ page_idx: 0, blocks }] },
  }
}

const figure = { type: "image", index: 0, bbox: [0.1, 0.2, 0.4, 0.6], content: [
  { type: "image_body", index: 0, bbox: [0.1, 0.2, 0.4, 0.6], image_path: "images/figure.jpg", content: "" },
  { type: "image_caption", index: 1, bbox: [0.1, 0.7, 0.4, 0.8], content: [{ type: "text", content: "Figure 1. Author's caption." }] },
] }
const figureArchive = (archive: MineruArchiveManifest): MineruArchiveManifest => ({ ...archive, entries: [...archive.entries, { _tag: "file", path: "images/figure.jpg", byteCount: 20, hash }], nativeAssets: [{ archivePath: "images/figure.jpg", artifact: { path: "images/figure.jpeg", mediaType: "image/jpeg", byteCount: 20, hash } }] })
const convertFailure = (input: unknown) => convertMineruResponse(input).pipe(Effect.result)

const sourceStrings = (value: unknown): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.flatMap(sourceStrings)
  if (Predicate.isObject(value)) return Object.entries(value).flatMap(([key, child]) => key === "content" && typeof child === "string" ? [child] : sourceStrings(child))
  return []
}

describe("saved MinerU 4.0.12 response", () => {
  it.effect("ties copied middle JSON and native figure bytes to the actual saved archive", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const crypto = yield* Crypto.Crypto
    for (const [local, archived] of [["document_middle.json", "document_middle.json"], ["page_1_image_4.jpg", "images/page_1_image_4.jpg"]]) {
      const bytes = yield* fs.readFile(new URL(`./fixtures/${local}`, import.meta.url).pathname)
      const metadata = savedArchive.entries.find((entry) => entry.path === archived)
      expect(bytes.byteLength).toBe(metadata?.byteCount)
      const digest = yield* crypto.digest("SHA-256", bytes)
      expect(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(metadata?.hash)
    }
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("retains every source page, textual leaf, reference, caption, and native figure", () => Effect.gen(function* () {
    const base = makeInput()
    const archive = yield* Schema.decodeUnknownEffect(ArchiveSchema)(savedArchive)
    const renderedPages = savedMiddle.extensions.docvortex_layout.pages.map((page): RenderedPage => ({ pageNumber: page.page_idx + 1, width: 2481, height: 3508, dpi: 300, widthPoints: page.width_pt, heightPoints: page.height_pt, rotation: 0, image: { path: `pages/page-${page.page_idx + 1}.png`, mediaType: "image/png", byteCount: 100, hash } }))
    const input = { ...base, document: { ...base.document, pageCount: 4 }, middle: savedMiddle, archive, renderedPages }
    const result = yield* convertMineruResponse(input)
    expect(result.extraction.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3, 4])
    expect(result.extraction.sourceBlocks).toHaveLength(62)
    expect(result.accounting).toHaveLength(67)
    expect(new Set(result.accounting.map((entry) => entry.sourcePath)).size).toBe(67)
    const sourcePaths: Array<string> = []
    const inspectPaths = (value: unknown, path: string): void => {
      if (Array.isArray(value)) for (const [index, child] of value.entries()) inspectPaths(child, `${path}/${index}`)
      else if (Predicate.isObject(value)) {
        if ("index" in value && "type" in value) sourcePaths.push(path)
        for (const [key, child] of Object.entries(value)) if (key === "blocks" || key === "content") inspectPaths(child, `${path}/${key}`)
      }
    }
    inspectPaths(savedMiddle.pages, "pages")
    expect(result.accounting.map((entry) => entry.sourcePath)).toEqual(sourcePaths)
    expect(result.extraction.sourceBlocks.filter((block) => block.kind === "reference")).toHaveLength(8)
    expect(result.extraction.sourceBlocks.filter((block) => block.kind === "list")).toHaveLength(5)
    expect(result.extraction.sourceBlocks.map((block) => block.content).join("")).toBe(sourceStrings(savedMiddle.pages).join(""))
    expect(result.extraction.figures).toHaveLength(1)
    expect(result.extraction.figures[0]).toMatchObject({ asset: { _tag: "available", artifact: savedArchive.nativeAssets[0]?.artifact }, originalCaption: "Figure 1: An example seaborn figure demonstrating some of its key features. The image was generated using seaborn v0.11.1.", description: { _tag: "pending" } })
    expect(result.extraction.sourceBlocks.some((block) => block.content.includes("joss.103021"))).toBe(true)
    expect(validateExtraction(input.document, result.extraction)).toEqual([])
    const firstLocation = result.extraction.sourceBlocks[0]?.locations[0]
    expect(firstLocation?._tag).toBe("box")
    if (firstLocation?._tag === "box") {
      expect(firstLocation.box.x).toBeCloseTo(74.43)
      expect(firstLocation.box.y).toBeCloseTo(42.096)
      expect(firstLocation.box.width).toBeCloseTo(652.503)
      expect(firstLocation.box.height).toBeCloseTo(217.496)
    }
    for (const source of result.extraction.sourceBlocks) expect(result.accounting.some((entry) => entry.sourceBlockIds.includes(source.id))).toBe(true)
    const replay = yield* convertMineruResponse({ ...input, runId: RunId.make("different-run") })
    expect(replay.extraction.sourceBlocks).toEqual(result.extraction.sourceBlocks)
    expect(replay.extraction.figures).toEqual(result.extraction.figures)
    expect(replay.accounting).toEqual(result.accounting)
  }))
})

describe("source semantics", () => {
  it.effect("classifies only the emitted native furniture node, never a descendant of unknown substantive content", () => Effect.gen(function* () {
    const header = { type: "header", content: [{ type: "text", content: "JOSS" }] }
    const unknown = { type: "future_wrapper", index: 1, content: [header, { type: "future_substantive", content: "DO NOT SKIP THIS CONTENT" }] }
    const result = yield* convertMineruResponse(makeInput([{ ...header, index: 0 }, unknown, { type: "footer", index: 2, content: [{ type: "text", content: "Author DOI" }] }]))
    expect(result.extraction.pageFurniture).toEqual([{ blockId: "block-p1-b0", role: "header" }, { blockId: "block-p1-b2", role: "footer" }])
    expect(result.extraction.sourceBlocks[1]?.content).toContain("DO NOT SKIP THIS CONTENT")
    expect(result.issues).toMatchObject([{ code: "unclassified-content", blockIds: ["block-p1-b1"] }])
  }))

  it.effect("keeps table HTML, LaTeX, notes, references, captions, lists, and unknown content", () => Effect.gen(function* () {
    const html = '<table><tr><td rowspan="2">α &amp; β</td></tr></table>'
    const blocks = [
      { type: "table", index: 0, content: [{ type: "table_body", content: html }, { type: "table_caption", content: [{ type: "text", content: "Table 1." }] }, { type: "table_footnote", content: [{ type: "text", content: "Original note." }] }] },
      { type: "equation", index: 1, content: "E = mc^2" },
      { type: "page_footnote", index: 2, content: [{ type: "text", content: "Footnote." }] },
      { type: "list", index: 3, sub_type: "ref_text", content: [{ type: "ref_text", content: [{ type: "text", content: "[1] A. Author." }] }] },
      { type: "future_kind", index: 4, content: [{ type: "future_child", index: 1, content: "Retain this.", custom: { value: 42 } }], extra: "Retain metadata." },
    ]
    const result = yield* convertMineruResponse(makeInput(blocks))
    expect(result.extraction.sourceBlocks.map(({ kind, content, format }) => ({ kind, content, format }))).toEqual([
      { kind: "table", content: html, format: "html" }, { kind: "caption", content: "Table 1.", format: "text" }, { kind: "note", content: "Original note.", format: "text" },
      { kind: "equation", content: "E = mc^2", format: "latex" }, { kind: "note", content: "Footnote.", format: "text" }, { kind: "reference", content: "[1] A. Author.", format: "text" },
      { kind: "unclassified", content: JSON.stringify(blocks[4]), format: "text" },
    ])
    expect(result.accounting).toHaveLength(10)
    expect(result.issues).toMatchObject([{ code: "unclassified-content", blockIds: ["block-p1-b4"] }])
    expect(result.extraction.sourceBlocks[0]?.locations).toEqual([{ _tag: "page", pageId: "page-1", pageNumber: 1 }])
  }))

  it.effect("retains typed inline math, links, code, and styled text as escaped Markdown", () => Effect.gen(function* () {
    const input = makeInput([{ type: "text", index: 0, content: [
      { type: "text", content: "literal <script> and $ ", styles: ["bold"] },
      { type: "equation_inline", content: "x_1 < y" },
      { type: "code_inline", content: "a`b" },
      { type: "hyperlink", url: "https://example.test/a(b)", content: [{ type: "text", content: "Source" }] },
      { type: "text", content: "2", styles: ["superscript"] },
    ] }])
    const result = yield* convertMineruResponse(input)
    expect(result.extraction.sourceBlocks[0]).toMatchObject({ format: "markdown", content: "<strong>literal &lt;script&gt; and $ </strong>$x_1 < y$``a`b``[Source](https://example.test/a%28b%29)<sup>2</sup>" })
  }))

  it.effect("keeps native and unavailable figure assets separate from their captions", () => Effect.gen(function* () {
    const input = makeInput([figure])
    const available = yield* convertMineruResponse({ ...input, archive: figureArchive(input.archive) })
    const missing = yield* convertMineruResponse(input)
    expect(available.extraction.figures[0]?.asset).toEqual({ _tag: "available", artifact: figureArchive(input.archive).nativeAssets[0]?.artifact })
    expect(missing.extraction.figures[0]?.asset._tag).toBe("unavailable")
    expect(missing.issues).toMatchObject([{ code: "figure-asset-unavailable", figureId: "figure-p1-b0", blockIds: ["block-p1-b0-c0"] }])
    expect(missing.extraction.sourceBlocks).toEqual(available.extraction.sourceBlocks)
    expect(missing.extraction.figures[0]?.captionBlockIds).toEqual(["block-p1-b0-c1"])
    expect(available.extraction.figures[0]?.sourceBlockIds).toEqual(["block-p1-b0-c0"])
    expect(available.accounting[0]?.sourceBlockIds).toEqual(["block-p1-b0-c0", "block-p1-b0-c1"])
  }))

  it.effect("fails image-only tables and equations instead of deleting their substantive content", () => Effect.gen(function* () {
    for (const block of [ { type: "equation", index: 0, image_path: "images/equation.jpg", content: "" }, { type: "table", index: 0, content: [{ type: "table_body", image_path: "images/table.jpg", content: "" }] } ]) expect(yield* convertFailure(makeInput([block]))).toMatchObject({ _tag: "Failure", failure: { code: "content" } })
  }))
})

describe("source-to-rendered coordinates", () => {
  it.effect.each([
    { rotation: 0, width: 1200, height: 1600, widthPoints: 600, heightPoints: 800, box: { x: 120, y: 320, width: 360, height: 640 } },
    { rotation: 90, width: 1600, height: 1200, widthPoints: 800, heightPoints: 600, box: { x: 640, y: 120, width: 640, height: 360 } },
    { rotation: 180, width: 1200, height: 1600, widthPoints: 600, heightPoints: 800, box: { x: 720, y: 640, width: 360, height: 640 } },
    { rotation: 270, width: 1600, height: 1200, widthPoints: 800, heightPoints: 600, box: { x: 320, y: 720, width: 640, height: 360 } },
  ] as const)("converts all corners under $rotation degrees", (expected) => Effect.gen(function* () {
    const input = makeInput()
    const result = yield* convertMineruResponse({ ...input, renderedPages: input.renderedPages.map((page) => ({ ...page, rotation: expected.rotation, width: expected.width, height: expected.height, widthPoints: expected.widthPoints, heightPoints: expected.heightPoints })) })
    expect(result.extraction.sourceBlocks[0]?.locations[0]).toMatchObject({ _tag: "box", box: expected.box })
    expect(result.extraction.pages[0]).toMatchObject({ sourceUnit: "fraction", sourceWidth: 1, sourceHeight: 1, sourceOrigin: "top-left", clockwiseRotation: expected.rotation })
  }))

  it.effect("rejects unsupported dimensions, DPI, coordinates, and rotation metadata", () => Effect.gen(function* () {
    const input = makeInput()
    for (const changes of [{ width: 1202 }, { dpi: 300 }, { widthPoints: 800 }, { rotation: 90 }]) expect(yield* convertFailure({ ...input, renderedPages: input.renderedPages.map((page) => ({ ...page, ...changes })) })).toMatchObject({ _tag: "Failure", failure: { code: "coordinates" } })
    for (const bbox of [[0.4, 0.2, 0.1, 0.6], [-0.1, 0, 1, 1], [0, 0, 1000, 1000], [0, 0, 0, 1], [0, 0, Infinity, 1], [0, 0, 1]]) expect(yield* convertFailure(makeInput([{ ...text("Text."), bbox }]))).toMatchObject({ _tag: "Failure" })
  }))
})

describe("response and archive boundary failures", () => {
  it.effect("keeps blank pages while retaining content on another page and stable IDs after text edits", () => Effect.gen(function* () {
    const input = makeInput()
    const first = input.renderedPages[0]
    if (first === undefined) throw new Error("Fixture page missing")
    const middle = { ...input.middle, metadata: { ...input.middle.metadata, document: { page_count: 2, page_count_kind: "physical" } }, pages: [...input.middle.pages, { page_idx: 1, blocks: [] }], extensions: { docvortex_layout: { version: 1, pages: [{ page_idx: 0, width_pt: 600, height_pt: 800 }, { page_idx: 1, width_pt: 600, height_pt: 800 }] } } }
    const complete = { ...input, document: { ...input.document, pageCount: 2 }, middle, renderedPages: [first, { ...first, pageNumber: 2, image: { ...first.image, path: "pages/page-002.png" } }] }
    const original = yield* convertMineruResponse(complete)
    expect(original.extraction.pages).toHaveLength(2)
    expect(original.extraction.sourceBlocks).toHaveLength(1)
    const revised = yield* convertMineruResponse({ ...complete, middle: { ...middle, pages: [{ page_idx: 0, blocks: [text("Changed text.")] }, { page_idx: 1, blocks: [] }] } })
    expect(revised.extraction.sourceBlocks[0]?.id).toBe(original.extraction.sourceBlocks[0]?.id)
    expect(yield* convertFailure({ ...complete, renderedPages: [first, { ...first, pageNumber: 2 }] })).toMatchObject({ _tag: "Failure", failure: { code: "page-coverage" } })
  }))

  it.effect("rejects mismatched visual bodies, child indices, and retained embedded bytes", () => Effect.gen(function* () {
    const body = figure.content[0]
    if (body === undefined) throw new Error("Fixture body missing")
    for (const content of [[{ ...body, index: 3 }], [{ ...body, bbox: [0.2, 0.2, 0.4, 0.6] }]]) expect(yield* convertFailure(makeInput([{ ...figure, content }]))).toMatchObject({ _tag: "Failure", failure: { code: "coordinates" } })
    expect(yield* convertFailure(makeInput([{ type: "list", index: 0, content: [text("First", 1), text("Second", 1)] }]))).toMatchObject({ _tag: "Failure", failure: { code: "content" } })
    expect(yield* convertFailure(makeInput([{ ...text("Text"), image_base64: "unsaved bytes" }]))).toMatchObject({ _tag: "Failure", failure: { code: "content" } })
  }))

  it.effect("rejects missing, duplicate, unordered, partial, and wrong-version pages", () => Effect.gen(function* () {
    const input = makeInput()
    for (const middle of [ { ...input.middle, pages: [] }, { ...input.middle, pages: [...input.middle.pages, ...input.middle.pages] }, { ...input.middle, pages: [{ page_idx: 1, blocks: [text("wrong page")] }] }, { ...input.middle, is_full_document: false } ]) expect(yield* convertFailure({ ...input, middle })).toMatchObject({ _tag: "Failure" })
    expect(yield* convertFailure({ ...input, middle: { ...input.middle, schema_version: "1.0" } })).toMatchObject({ _tag: "Failure", failure: { code: "unsupported-version" } })
    expect(yield* convertFailure({ ...input, middle: { ...input.middle, metadata: { ...input.middle.metadata, producer: { name: "mineru", version: "4.0.13" } } } })).toMatchObject({ _tag: "Failure", failure: { code: "unsupported-version" } })
    expect(yield* convertFailure({ ...input, document: { ...input.document, pageCount: 2 } })).toMatchObject({ _tag: "Failure", failure: { code: "page-coverage" } })
    expect(yield* convertFailure({ ...input, renderedPages: [...input.renderedPages, ...input.renderedPages] })).toMatchObject({ _tag: "Failure", failure: { code: "page-coverage" } })
  }))

  it.effect("rejects malformed content, duplicate indices, unsafe links, and structural overload", () => Effect.gen(function* () {
    for (const blocks of [ [text("first"), text("second")], [{ type: "text", content: [{ type: "text", content: "missing index" }] }], [{ type: "text", index: 0, content: "untyped text" }], [{ type: "image", index: 0, content: [] }], [{ type: "text", index: 0, content: [{ type: "hyperlink", url: "javascript:alert(1)", content: [{ type: "text", content: "click" }] }] }], [] ]) expect(yield* convertFailure(makeInput(blocks))).toMatchObject({ _tag: "Failure", failure: { code: "content" } })
    let node: unknown = text("deep")
    for (let index = 0; index < 40; index += 1) node = { type: "list", index, content: [node] }
    expect(yield* convertFailure(makeInput([node]))).toMatchObject({ _tag: "Failure", failure: { code: "limit-exceeded" } })
    const wide = makeInput()
    expect(yield* convertFailure({ ...wide, middle: { ...wide.middle, extra: Array.from({ length: MineruLimits.maxNodes }, () => 0) } })).toMatchObject({ _tag: "Failure", failure: { code: "limit-exceeded" } })
  }))

  it.effect("rejects malformed paths and collisions instead of removing archive entries", () => Effect.gen(function* () {
    const input = makeInput()
    for (const path of ["../escape", "/absolute", "images/../escape.jpg", "images//empty.jpg", "C:/drive", "images\\escape.jpg", "images/%2e%2e/escape.jpg", "images/control\n.jpg", "images/./dot.jpg"]) expect(yield* convertFailure({ ...input, archive: { ...input.archive, entries: [...input.archive.entries, { _tag: "file", path, byteCount: 1, hash }] } })).toMatchObject({ _tag: "Failure" })
    for (const entries of [ [...input.archive.entries, ...input.archive.entries], [...input.archive.entries, { _tag: "file", path: "DOCUMENT_MIDDLE.JSON", byteCount: 1, hash }], [...input.archive.entries, { _tag: "file", path: "images", byteCount: 1, hash }, { _tag: "file", path: "images/a.png", byteCount: 1, hash }], [...input.archive.entries, { _tag: "file", path: "images/a.png", byteCount: 1, hash }, { _tag: "file", path: "images", byteCount: 1, hash }] ]) expect(yield* convertFailure({ ...input, archive: { ...input.archive, entries } })).toMatchObject({ _tag: "Failure", failure: { code: "archive-manifest" } })
  }))

  it.effect("enforces all declared archive limits and rejects missing critical data", () => Effect.gen(function* () {
    const input = makeInput()
    for (const archive of [ { ...input.archive, compressedByteCount: MineruLimits.maxCompressedBytes + 1 }, { ...input.archive, entries: [{ _tag: "file", path: "document_middle.json", byteCount: MineruLimits.maxExpandedBytes + 1, hash }] }, { ...input.archive, entries: Array.from({ length: MineruLimits.maxEntries + 1 }, (_, index) => ({ _tag: "file", path: `file-${index}`, byteCount: 1, hash })) } ]) expect(yield* convertFailure({ ...input, archive })).toMatchObject({ _tag: "Failure", failure: { code: "limit-exceeded" } })
    expect(yield* convertFailure({ ...input, archive: { ...input.archive, entries: [{ _tag: "file", path: "document_middle.json", byteCount: 0, hash }] } })).toMatchObject({ _tag: "Failure", failure: { code: "archive-manifest" } })
    const accepted = yield* convertMineruResponse({ ...input, archive: { ...input.archive, entries: [...input.archive.entries, { _tag: "file", path: "empty.txt", byteCount: 0, hash }, { _tag: "directory", path: "empty-directory", byteCount: 0 }] } })
    expect(accepted.extraction.sourceBlocks[0]?.content).toBe("Original text.")
  }))

  it.effect("requires image mappings to match source files, hashes, byte counts, and extensions", () => Effect.gen(function* () {
    const input = makeInput([figure])
    const archive = figureArchive(input.archive)
    for (const modified of [ { ...archive, nativeAssets: [] }, { ...archive, nativeAssets: [...archive.nativeAssets, ...archive.nativeAssets] }, { ...archive, nativeAssets: archive.nativeAssets.map((asset) => ({ ...asset, artifact: { ...asset.artifact, byteCount: 21 } })) }, { ...archive, nativeAssets: archive.nativeAssets.map((asset) => ({ ...asset, artifact: { ...asset.artifact, hash: "b".repeat(64) } })) }, { ...archive, nativeAssets: archive.nativeAssets.map((asset) => ({ ...asset, artifact: { ...asset.artifact, path: "images/figure.png" } })) } ]) expect(yield* convertFailure({ ...input, archive: modified })).toMatchObject({ _tag: "Failure", failure: { code: "archive-manifest" } })
  }))
})
