import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Crypto, Effect, Schema } from "effect"
import { Figure, ProviderAttemptId, validatePublication, type StageReceipt } from "../../../src/domain/index.ts"
import { assembleDocument, exportDocument, printNormalizedDocument } from "../../../src/paper/reading/index.ts"
import { fixtureTime } from "../../fixtures/contracts.ts"
import { completeFixture, imageFixture } from "./fixtures.ts"

describe("deterministic reading export", () => {
  it.effect("prints every full block once, with all page/source locations and intact table markup", () => Effect.gen(function* () {
    const input = yield* completeFixture
    const assembled = yield* Effect.fromResult(assembleDocument(input))
    const result = yield* exportDocument(assembled, [])
    const text = new TextDecoder().decode(result.files[0]?.bytes)
    expect(text).toBe(printNormalizedDocument(result.publication.canonical))
    for (const block of assembled.canonical.blocks) expect(text.split(block.content)).toHaveLength(2)
    expect(text.match(/^== Page /gmu)).toHaveLength(3)
    expect(text).toContain("Sources: block-2, block-3\nLocations: page 1/page-1; page 2/page-2\nmicroscope")
    expect(text).toContain("Source content on this page is included in [block-2].")
    expect(text).toContain("[No extracted text blocks on this page.]")
    expect(text).toContain('<table>\n  <tr><td rowspan="2">α &amp; β</td><td>12</td></tr>\n</table>')
    expect(text).toContain("E = mc^2\n\\frac{α}{β} = 0.5")
    expect(result.files.map((file) => file.entry.path)).toEqual(["normalized.txt", "document.json", "images.json", "processing-report.json"])
    expect(validatePublication({ document: input.document, run: { ...input.run, state: { _tag: "succeeded-with-issues", startedAt: fixtureTime, finishedAt: fixtureTime, revisionId: input.revisionId } }, ...result.publication })).toEqual([])
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("hashes exact stable UTF-8 and native bytes without changing the assembly checkpoint", () => Effect.gen(function* () {
    const f = yield* imageFixture
    const assembled = yield* Effect.fromResult(assembleDocument(f.input))
    const before = JSON.stringify(assembled)
    const first = yield* exportDocument(assembled, [f.asset])
    const replay = yield* exportDocument(assembled, [f.asset])
    expect(replay).toEqual(first)
    expect(JSON.stringify(assembled)).toBe(before)
    const crypto = yield* Crypto.Crypto
    for (const file of first.files) {
      expect(file.entry.byteCount).toBe(file.bytes.byteLength)
      const digest = yield* crypto.digest("SHA-256", file.bytes)
      expect(file.entry.hash).toBe(Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join(""))
      const object = file.entry.path === "document.json" ? first.publication.canonical : file.entry.path === "images.json" ? first.publication.images : file.entry.path === "processing-report.json" ? first.publication.report : undefined
      if (object !== undefined) expect(new TextDecoder().decode(file.bytes)).toBe(JSON.stringify(object))
    }
    expect(first.files.at(-1)?.bytes).toEqual(f.asset.bytes)
    expect(first.files.at(-1)?.entry).toEqual(f.asset.artifact)
    const text = new TextDecoder().decode(first.files[0]?.bytes)
    expect(text).toContain("Image: images/native.jpeg")
    expect(text).toContain("AI-written description unavailable:")
    expect(text).toContain("author caption for figure-1")
    expect(text.split("Figure 1. A synthetic black square.")).toHaveLength(2)
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("labels generated descriptions separately from retained author captions", () => Effect.gen(function* () {
    const f = yield* imageFixture
    const first = f.input.receiptUses[0]?.receipt
    const figure = f.input.figures[0]
    if (first === undefined || figure === undefined) return yield* Effect.die("Missing figure fixture")
    const receipt: StageReceipt = { ...first, id: ProviderAttemptId.make("figure-description"), stage: "figures", figureId: figure.id }
    const generated = yield* Schema.decodeUnknownEffect(Figure)({ ...figure, description: { _tag: "generated", text: "A square represents the measured region.", label: "AI-written", providerAttemptId: receipt.id } })
    const assembled = yield* Effect.fromResult(assembleDocument({ ...f.input, figures: [generated], receiptUses: [...f.input.receiptUses, { delivery: "performed", receipt }] }))
    const result = yield* exportDocument(assembled, [f.asset])
    const text = new TextDecoder().decode(result.files[0]?.bytes)
    expect(text).toContain("Author caption: see [block-2]")
    expect(text).toContain("AI-written description:\nA square represents the measured region.")
    expect(text.split(generated.originalCaption)).toHaveLength(2)
    expect(result.publication.report.issues).toEqual([])
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects missing, extra, duplicate and mutated image bytes", () => Effect.gen(function* () {
    const f = yield* imageFixture
    const assembled = yield* Effect.fromResult(assembleDocument(f.input))
    for (const assets of [[], [f.asset, f.asset], [{ ...f.asset, bytes: new Uint8Array(f.asset.bytes.byteLength) }], [{ ...f.asset, artifact: { ...f.asset.artifact, path: "images/foreign.jpeg" } }]]) expect(yield* Effect.result(exportDocument(assembled, assets))).toMatchObject({ _tag: "Failure" })
    const noImage = yield* Effect.fromResult(assembleDocument(yield* completeFixture))
    expect(yield* Effect.result(exportDocument(noImage, [f.asset]))).toMatchObject({ _tag: "Failure" })
  }).pipe(Effect.provide(NodeServices.layer)))
})
