import { Crypto, Effect, Schema } from "effect"
import { ArtifactEntry, ArtifactHash, ArtifactManifest, Figure, ImageArtifact, type CanonicalDocument, type SourceLocation, validateManifest } from "../../domain/index.ts"
import { executionFailure } from "../../processing/index.ts"
import { artifactLimits, Publication } from "../../storage/index.ts"
import { AssembledDocument } from "./assembly.ts"

export interface ExportedFile { readonly entry: ArtifactEntry; readonly bytes: Uint8Array }
export interface FigureImageBytes { readonly artifact: ImageArtifact; readonly bytes: Uint8Array }
export interface ExportedDocument { readonly publication: Publication; readonly files: ReadonlyArray<ExportedFile> }
const invalid = (message: string) => executionFailure("invalid-provider-response", message)
const locationLabel = (location: SourceLocation): string => `page ${location.pageNumber}/${location.pageId}${location._tag === "box" ? ` box(${location.box.x},${location.box.y},${location.box.width},${location.box.height})` : ""}`
const figureLines = (figure: Figure, document: CanonicalDocument): ReadonlyArray<string> => {
  const caption = figure.captionBlockIds.map((id) => document.blocks.find((block) => block.sourceBlockIds.includes(id))?.content ?? "").join("\n\n")
  const lines = [`[${figure.id}][figure] Locations: ${figure.locations.map(locationLabel).join("; ")}`, figure.asset._tag === "available" ? `Image: ${figure.asset.artifact.path}` : `Image unavailable: ${figure.asset.reason}`]
  if (figure.asset._tag === "available" && figure.asset.provenance !== undefined) lines.push(`Image origin: rendered source-page region; page ${figure.asset.provenance.pageNumber}; crop ${figure.asset.provenance.box.x},${figure.asset.provenance.box.y},${figure.asset.provenance.width},${figure.asset.provenance.height}; ${figure.asset.provenance.recipe}`)
  if (figure.originalCaption !== "") lines.push(caption === figure.originalCaption && figure.captionBlockIds.length > 0 ? `Author caption: see ${figure.captionBlockIds.map((id) => `[${id}]`).join(", ")}` : `Original author caption:\n${figure.originalCaption}`)
  lines.push(figure.description._tag === "generated" ? `AI-written description:\n${figure.description.text}` : `AI-written description unavailable: ${figure.description._tag === "unavailable" ? figure.description.reason : "No description was generated"}`)
  return lines
}

export const printNormalizedDocument = (document: CanonicalDocument): string => {
  const sections: Array<string> = []
  for (const page of document.pages) {
    const parts = [`== Page ${page.pageNumber} [${page.id}]`]
    const blocks = document.blocks.filter((block) => block.locations[0].pageId === page.id)
    const continued = document.blocks.filter((block) => block.locations[0].pageId !== page.id && block.locations.some((location) => location.pageId === page.id))
    if (continued.length > 0) parts.push(`Source content on this page is included in ${continued.map((block) => `[${block.id}]`).join(", ")}.`)
    if (!document.sourceBlocks.some((block) => block.locations.some((location) => location.pageId === page.id))) parts.push("[No extracted text blocks on this page.]")
    for (const block of blocks) {
      const captions = document.figures.filter((figure) => figure.captionBlockIds.some((id) => block.sourceBlockIds.includes(id)))
      const captionLabel = captions.length === 0 ? "" : `; author caption for ${captions.map((figure) => figure.id).join(", ")}`
      parts.push(`[${block.id}][${block.kind}; ${block.format}${captionLabel}] Sources: ${block.sourceBlockIds.join(", ")}\nLocations: ${block.locations.map(locationLabel).join("; ")}\n${block.content}`)
      for (const figure of document.figures.filter((item) => block.sourceBlockIds.includes(item.sourceBlockIds[0]))) parts.push(figureLines(figure, document).join("\n"))
    }
    sections.push(parts.join("\n\n"))
  }
  return `${sections.join("\n\n")}\n`
}

export const exportDocument = Effect.fn("exportDocument")(function* (raw: AssembledDocument, assets: ReadonlyArray<FigureImageBytes>) {
  const assembled = yield* Schema.decodeUnknownEffect(AssembledDocument)(raw, { onExcessProperty: "error" }).pipe(Effect.mapError(() => invalid("The assembly checkpoint is invalid")))
  const crypto = yield* Crypto.Crypto
  const { extraction, canonical, images } = assembled
  if (JSON.stringify(images.scope) !== JSON.stringify(canonical.scope) || JSON.stringify(assembled.report.scope) !== JSON.stringify(canonical.scope) || !Schema.toEquivalence(Schema.Array(Figure))(images.figures, canonical.figures)) return yield* invalid("Export objects must describe the same canonical revision")
  const report = { ...assembled.report, checks: [...assembled.report.checks.filter((check) => check.stage !== "export"), { stage: "export" as const, checkedPageIds: canonical.pages.map((page) => page.id), result: "passed" as const }] }
  const files: Array<ExportedFile> = []
  const add = Effect.fnUntraced(function* (path: string, mediaType: ArtifactEntry["mediaType"], bytes: Uint8Array) {
    if (bytes.byteLength > artifactLimits.objectBytes) return yield* executionFailure("limit-exceeded", "An exported artifact exceeds the private object limit")
    const hash = yield* crypto.digest("SHA-256", bytes).pipe(Effect.map((digest) => Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")), Effect.flatMap(Schema.decodeUnknownEffect(ArtifactHash)), Effect.mapError(() => invalid("Exported artifact hashing failed")))
    const entry = yield* Schema.decodeUnknownEffect(ArtifactEntry)({ path, mediaType, byteCount: bytes.byteLength, hash }).pipe(Effect.mapError(() => invalid("The exported artifact identity is invalid")))
    files.push({ entry, bytes })
    return entry
  })
  yield* add("normalized.txt", "text/plain; charset=utf-8", new TextEncoder().encode(printNormalizedDocument(canonical)))
  for (const [path, value] of [["document.json", canonical], ["images.json", images], ["processing-report.json", report]] as const) yield* add(path, "application/json", new TextEncoder().encode(JSON.stringify(value)))
  const expected = new Map(canonical.figures.flatMap((figure) => figure.asset._tag === "available" ? [[figure.asset.artifact.path, figure.asset.artifact] as const] : []))
  if (assets.length !== expected.size || new Set(assets.map((asset) => asset.artifact.path)).size !== assets.length) return yield* invalid("Export requires each available figure image exactly once")
  for (const asset of assets.toSorted((left, right) => left.artifact.path < right.artifact.path ? -1 : left.artifact.path > right.artifact.path ? 1 : 0)) {
    const original = expected.get(asset.artifact.path)
    if (original === undefined || !Schema.toEquivalence(ImageArtifact)(original, asset.artifact)) return yield* invalid("Export image metadata differs from its verified source")
    const entry = yield* add(original.path, original.mediaType, asset.bytes)
    if (entry.hash !== original.hash || entry.byteCount !== original.byteCount) return yield* invalid("Export image bytes differ from their verified source")
  }
  const manifest = yield* Schema.decodeUnknownEffect(ArtifactManifest)({ schemaVersion: "1", scope: canonical.scope, entries: files.map((file) => file.entry) }).pipe(Effect.mapError(() => invalid("The export manifest is invalid")))
  if (validateManifest(manifest, canonical).length > 0) return yield* invalid("The export manifest does not preserve the canonical images")
  return { publication: { extraction, canonical, images, report, manifest }, files } satisfies ExportedDocument
})
