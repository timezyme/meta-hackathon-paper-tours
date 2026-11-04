import { Effect, Predicate, Schema } from "effect"
import { BlockId, FigureId, PageId, PageFurniture, validateExtraction } from "../../../domain/index.ts"
import type { Figure, Issue, Page, SourceBlock, SourceLocation } from "../../../domain/index.ts"
import { MineruConversion, MineruConversionError, MineruConversionInput, MineruLimits, MineruMiddle, MINERU_VERSION } from "./contracts.ts"
import type { MineruArchiveManifest, MineruBox, MineruNode, RenderedPage, SourceAccounting } from "./contracts.ts"

const failure = (code: MineruConversionError["code"], path: string, message: string) => new MineruConversionError({ code, path, message })
const textTypes = new Set(["text", "ref_text", "doc_title", "paragraph_title", "header", "footer", "page_number", "aside_text", "page_footnote", "image_caption", "image_footnote", "table_caption", "table_footnote", "chart_caption", "chart_footnote", "code_caption", "code_footnote", "algorithm_body"])
const stringTypes = new Set(["equation", "code_body", "table_body", "image_body", "chart_body"])
const containerTypes = new Set(["list", "index", "image", "table", "chart", "code"])
const inlineTypes = new Set(["text", "equation_inline", "code_inline", "hyperlink"])
const visualBodies: Readonly<Record<string, string>> = { image: "image_body", table: "table_body", chart: "chart_body" }
const kindByType: Readonly<Record<string, SourceBlock["kind"]>> = {
  text: "paragraph", ref_text: "reference", doc_title: "heading", paragraph_title: "heading", equation: "equation",
  aside_text: "note", page_footnote: "note", image_body: "figure", chart_body: "figure", table_body: "table",
  image_caption: "caption", table_caption: "caption", chart_caption: "caption", code_caption: "caption",
  image_footnote: "note", table_footnote: "note", chart_footnote: "note", code_footnote: "note",
}

const checkJsonBounds = (input: unknown): MineruConversionError | undefined => {
  const pending = [{ value: input, depth: 0 }]
  let count = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    count += 1
    if (count > MineruLimits.maxNodes || current.depth > MineruLimits.maxDepth) return failure("limit-exceeded", "middle", "The response exceeds the structural node or nesting limit")
    const value = current.value
    if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) continue
    if (!Array.isArray(value) && !Predicate.isObject(value)) return failure("invalid-response", "middle", "The response must be finite JSON without unsupported values")
    const children = Array.isArray(value) ? value : Object.values(value)
    if (count + pending.length + children.length > MineruLimits.maxNodes) return failure("limit-exceeded", "middle", "The response exceeds the structural node limit")
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 })
  }
  return undefined
}

const checkArchive = (archive: MineruArchiveManifest): MineruConversionError | undefined => {
  if (archive.compressedByteCount > MineruLimits.maxCompressedBytes || archive.entries.length > MineruLimits.maxEntries || archive.entries.reduce((sum, entry) => sum + entry.byteCount, 0) > MineruLimits.maxExpandedBytes) return failure("limit-exceeded", "archive", "The archive exceeds its compressed, expanded, or entry limit")
  const paths = new Map<string, MineruArchiveManifest["entries"][number]>()
  for (const entry of archive.entries) {
    const key = entry.path.toLowerCase()
    if (paths.has(key)) return failure("archive-manifest", entry.path, "Archive paths must be unique, including case")
    paths.set(key, entry)
  }
  for (const entry of archive.entries) {
    const segments = entry.path.toLowerCase().split("/")
    for (let index = 1; index < segments.length; index += 1) {
      if (paths.get(segments.slice(0, index).join("/"))?._tag === "file") return failure("archive-manifest", entry.path, "An archive file cannot also be a parent directory")
    }
  }
  const middle = paths.get(archive.middlePath.toLowerCase())
  if (middle?._tag !== "file" || middle.path !== archive.middlePath || middle.byteCount === 0 || !middle.path.endsWith(".json")) return failure("archive-manifest", "archive.middlePath", "The middle JSON must identify an actual archive file")
  const sources = new Set<string>()
  const destinations = new Set<string>()
  for (const asset of archive.nativeAssets) {
    const source = paths.get(asset.archivePath.toLowerCase())
    const destination = asset.artifact.path.toLowerCase()
    if (sources.has(asset.archivePath.toLowerCase()) || destinations.has(destination)) return failure("archive-manifest", asset.archivePath, "Native image source and destination paths must be unique")
    sources.add(asset.archivePath.toLowerCase())
    destinations.add(destination)
    const expectedType = /\.jpe?g$/i.test(asset.archivePath) ? "image/jpeg" : /\.png$/i.test(asset.archivePath) ? "image/png" : /\.webp$/i.test(asset.archivePath) ? "image/webp" : undefined
    const expectedExtension = asset.artifact.mediaType === "image/jpeg" ? ".jpeg" : asset.artifact.mediaType === "image/png" ? ".png" : ".webp"
    if (source?._tag !== "file" || source.path !== asset.archivePath || source.byteCount !== asset.artifact.byteCount || source.hash !== asset.artifact.hash || expectedType !== asset.artifact.mediaType || !asset.artifact.path.endsWith(expectedExtension)) return failure("archive-manifest", asset.archivePath, "A native image must match its archive file bytes, hash, type, and canonical extension")
  }
  return undefined
}

const checkSpans = (nodes: ReadonlyArray<MineruNode>, path: string, insideLink = false): MineruConversionError | undefined => {
  for (const [index, node] of nodes.entries()) {
    const sourcePath = `${path}/${index}`
    if (!inlineTypes.has(node.type) || node.index !== undefined || node.bbox !== undefined || node.image_path !== undefined) return failure("content", sourcePath, "Text content must contain typed inline spans")
    if (node.type === "hyperlink") {
      if (insideLink || node.url === undefined || !/^(?:https?:\/\/|mailto:)[^\s<>]+$/u.test(node.url) || [...node.url].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || typeof node.content === "string" || node.content.length === 0) return failure("content", sourcePath, "Hyperlinks need a safe URL and nonempty inline content without nested links")
      const issue = checkSpans(node.content, `${sourcePath}/content`, true)
      if (issue !== undefined) return issue
    } else if (typeof node.content !== "string" || node.content.length === 0 || (node.type === "equation_inline" && node.content.trim() === "")) return failure("content", sourcePath, "Inline spans need their declared nonempty string content")
    if (node.styles?.includes("superscript") && node.styles.includes("subscript")) return failure("content", sourcePath, "A text span cannot be both superscript and subscript")
  }
  return undefined
}

const checkNode = (node: MineruNode, path: string): MineruConversionError | undefined => {
  if (node.image_base64 !== undefined) return failure("content", path, "Embedded image bytes must be materialized by the archive owner")
  if (textTypes.has(node.type)) {
    if (typeof node.content === "string") return failure("content", path, "This block requires typed inline spans")
    return checkSpans(node.content, `${path}/content`)
  }
  if (stringTypes.has(node.type)) {
    if (typeof node.content !== "string") return failure("content", path, "This block requires its native string content")
    if ((node.type === "table_body" || node.type === "equation") && node.content.trim() === "") return failure("content", path, "An image-only table or equation cannot be retained by the current shared text representation")
    return undefined
  }
  if (!containerTypes.has(node.type)) return undefined
  if (typeof node.content === "string" || node.content.length === 0) return failure("content", path, "A structural container must have child blocks")
  const bodyType = node.type === "code" ? node.sub_type === "algorithm" ? "algorithm_body" : "code_body" : visualBodies[node.type]
  if (bodyType !== undefined && node.content.filter((child) => child.type === bodyType).length !== 1) return failure("content", path, "A visual or code container must have exactly one matching body")
  let previousIndex = -1
  for (const [index, child] of node.content.entries()) {
    if (child.index !== undefined) {
      if (child.index <= previousIndex) return failure("content", `${path}/content/${index}`, "Child source indices must be unique and increasing")
      previousIndex = child.index
    }
    if (child.type === bodyType && ((child.index !== undefined && node.index !== undefined && child.index !== node.index) || (child.bbox !== undefined && node.bbox !== undefined && child.bbox.some((value, corner) => value !== node.bbox?.[corner])))) return failure("coordinates", `${path}/content/${index}`, "A visual body must retain its parent's source index and box")
    if (bodyType !== undefined && child.type !== bodyType && child.type !== `${node.type}_caption` && child.type !== `${node.type}_footnote`) return failure("content", `${path}/content/${index}`, "A visual container has an unsupported child type")
    if (node.type === "list" && child.type !== "text" && child.type !== "ref_text" && child.type !== "list") return failure("content", `${path}/content/${index}`, "A list has an unsupported child type")
    if (node.type === "index" && !["text", "doc_title", "paragraph_title", "index"].includes(child.type)) return failure("content", `${path}/content/${index}`, "An index has an unsupported child type")
    const issue = checkNode(child, `${path}/content/${index}`)
    if (issue !== undefined) return issue
  }
  return undefined
}

const escapeMarkdown = (text: string) => text.replace(/([\\`*_{}[\]()#+.!|~$<>])/g, "\\$1")
const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
const inlineMarkdown = (node: MineruNode): string => {
  if (node.type === "hyperlink") return `[${typeof node.content === "string" ? escapeMarkdown(node.content) : node.content.map(inlineMarkdown).join("")}](${node.url?.replaceAll("(", "%28").replaceAll(")", "%29")})`
  const text = typeof node.content === "string" ? node.content : ""
  if (node.type === "equation_inline") return `$${text}$`
  if (node.type === "code_inline") {
    let longestRun = 0
    for (const match of text.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length)
    const delimiter = "`".repeat(longestRun + 1)
    const padding = text.startsWith("`") || text.endsWith("`") || (text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "") ? " " : ""
    return `${delimiter}${padding}${text}${padding}${delimiter}`
  }
  if ((node.styles?.length ?? 0) === 0) return escapeMarkdown(text)
  const tags: Readonly<Record<string, string>> = { bold: "strong", italic: "em", emphasis: "em", strikethrough: "s", underline: "u", superscript: "sup", subscript: "sub" }
  let rendered = escapeHtml(text)
  for (const style of node.styles ?? []) {
    const tag = tags[style]
    if (tag !== undefined) rendered = `<${tag}>${rendered}</${tag}>`
  }
  return rendered
}

const blockContent = (node: MineruNode): Pick<SourceBlock, "content" | "format"> => {
  if (!textTypes.has(node.type) && !stringTypes.has(node.type)) return { content: JSON.stringify(node), format: "text" }
  if (typeof node.content === "string") return { content: node.content, format: node.type === "equation" ? "latex" : (node.type === "table_body" || node.type === "chart_body") && /^\s*</.test(node.content) ? "html" : "text" }
  if (node.content.every((span) => span.type === "text" && (span.styles?.length ?? 0) === 0)) return { content: node.content.map((span) => span.content).join(""), format: "text" }
  return { content: node.content.map(inlineMarkdown).join(""), format: "markdown" }
}

const transformFor = (page: RenderedPage): Page["sourceToRendered"] => {
  switch (page.rotation) {
    case 0: return { a: page.width, b: 0, c: 0, d: page.height, e: 0, f: 0 }
    case 90: return { a: 0, b: page.height, c: -page.width, d: 0, e: page.width, f: 0 }
    case 180: return { a: -page.width, b: 0, c: 0, d: -page.height, e: page.width, f: page.height }
    case 270: return { a: 0, b: -page.height, c: page.width, d: 0, e: 0, f: page.height }
  }
}

const locationFor = (page: Page, box: MineruBox | undefined): SourceLocation => {
  const base = { pageId: page.id, pageNumber: page.pageNumber }
  if (box === undefined) return { _tag: "page", ...base }
  const { a, b, c, d, e, f } = page.sourceToRendered
  const [x0, y0, x1, y1] = box
  const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as const
  const xs = corners.map(([x, y]) => a * x + c * y + e)
  const ys = corners.map(([x, y]) => b * x + d * y + f)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return { _tag: "box", ...base, box: { coordinateSystem: "rendered-page-top-left-pixels", x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top } }
}

interface ConvertedPage {
  readonly blocks: Array<SourceBlock>
  readonly figures: Array<Figure>
  readonly accounting: Array<SourceAccounting>
  readonly issues: Array<Issue>
  readonly pageFurniture: Array<typeof PageFurniture.Type>
}

const convertPage = (page: Page, nodes: ReadonlyArray<MineruNode>, archive: MineruArchiveManifest, firstOrder: number): ConvertedPage => {
  const output: ConvertedPage = { blocks: [], figures: [], accounting: [], issues: [], pageFurniture: [] }
  const accountUnknown = (node: MineruNode, path: string, ids: readonly [BlockId]) => {
    output.accounting.push({ sourcePath: path, sourceType: node.type, pageNumber: page.pageNumber, sourceBlockIds: ids })
    if (typeof node.content !== "string") for (const [index, child] of node.content.entries()) if (child.index !== undefined || child.bbox !== undefined || !inlineTypes.has(child.type)) accountUnknown(child, `${path}/content/${index}`, ids)
  }
  const visit = (node: MineruNode, path: string, idPath: string, listItem = false): ReadonlyArray<BlockId> => {
    const accountingIndex = output.accounting.length
    if (containerTypes.has(node.type) && typeof node.content !== "string") {
      const ids = node.content.flatMap((child, index) => visit(child, `${path}/content/${index}`, `${idPath}-c${index}`, node.type === "list"))
      const firstId = ids[0]
      if (firstId !== undefined) output.accounting.splice(accountingIndex, 0, { sourcePath: path, sourceType: node.type, pageNumber: page.pageNumber, sourceBlockIds: [firstId, ...ids.slice(1)] })
      if (node.type === "image" || node.type === "chart") {
        const source = output.blocks.find((block) => ids.includes(block.id) && block.kind === "figure")
        const body = node.content.find((child) => child.type === `${node.type}_body`)
        if (source !== undefined && body !== undefined) {
          const captions = output.blocks.filter((block) => ids.includes(block.id) && block.kind === "caption")
          const figureId = FigureId.make(`figure-${idPath}`)
          const asset = archive.nativeAssets.find((entry) => entry.archivePath === body.image_path)
          const reason = body.image_path === undefined ? "MinerU did not provide a native figure asset" : `Native figure asset is missing from the archive: ${body.image_path}`
          const figure: Figure = { id: figureId, sourceBlockIds: [source.id], locations: source.locations, captionBlockIds: captions.map((caption) => caption.id), originalCaption: captions.map((caption) => caption.content).join("\n\n"), asset: asset === undefined ? { _tag: "unavailable", reason } : { _tag: "available", artifact: asset.artifact }, description: { _tag: "pending" } }
          output.figures.push(figure)
          if (asset === undefined) output.issues.push({ code: "figure-asset-unavailable", message: reason, stage: "extraction", locations: source.locations, blockIds: [source.id], figureId })
        }
      }
      return ids
    }
    const id = BlockId.make(`block-${idPath}`)
    const kind = listItem && node.type === "text" ? "list" : kindByType[node.type] ?? "unclassified"
    const block: SourceBlock = { id, kind, readingOrder: firstOrder + output.blocks.length, ...blockContent(node), locations: [locationFor(page, node.bbox)] }
    output.blocks.push(block)
    if (Schema.is(PageFurniture.fields.role)(node.type)) output.pageFurniture.push({ blockId: id, role: node.type })
    accountUnknown(node, path, [id])
    if (kind === "unclassified" && !Schema.is(PageFurniture.fields.role)(node.type)) output.issues.push({ code: "unclassified-content", message: `Preserved MinerU ${node.type} content without a shared classification`, stage: "extraction", locations: block.locations, blockIds: [id], figureId: null })
    return [id]
  }
  for (const [index, node] of nodes.entries()) visit(node, `pages/${page.pageNumber - 1}/blocks/${index}`, `p${page.pageNumber}-b${index}`)
  return output
}

export const convertMineruResponse = Effect.fn("convertMineruResponse")(function* (unknownInput: unknown) {
  const input = yield* Schema.decodeUnknownEffect(MineruConversionInput, { onExcessProperty: "error" })(unknownInput).pipe(Effect.mapError((error) => failure("invalid-response", "input", error.message)))
  const boundsError = checkJsonBounds(input.middle)
  if (boundsError !== undefined) return yield* boundsError
  const archiveError = checkArchive(input.archive)
  if (archiveError !== undefined) return yield* archiveError
  const identity = yield* Schema.decodeUnknownEffect(Schema.Struct({ schema: Schema.String, schema_version: Schema.String, metadata: Schema.Struct({ producer: Schema.Struct({ name: Schema.String, version: Schema.String }) }) }))(input.middle).pipe(Effect.mapError((error) => failure("invalid-response", "middle", error.message)))
  if (identity.schema !== "docvortex.middle" || identity.schema_version !== "2.0" || identity.metadata.producer.name !== "mineru" || identity.metadata.producer.version !== MINERU_VERSION) return yield* failure("unsupported-version", "middle.metadata.producer", "The converter requires MinerU 4.0.12 docvortex.middle 2.0")
  const middle = yield* Schema.decodeUnknownEffect(MineruMiddle)(input.middle).pipe(Effect.mapError((error) => failure("invalid-response", "middle", error.message)))
  const count = input.document.pageCount
  const layout = middle.extensions.docvortex_layout.pages
  if (middle.metadata.document.page_count !== count || middle.pages.length !== count || layout.length !== count || input.renderedPages.length !== count || middle.pages.some((page, index) => page.page_idx !== index) || layout.some((page, index) => page.page_idx !== index) || input.renderedPages.some((page, index) => page.pageNumber !== index + 1)) return yield* failure("page-coverage", "pages", "Admission, response, source layout, and rendered images must cover every page exactly once in order")
  const pages: Array<Page> = []
  const result: { sourceBlocks: Array<SourceBlock>; figures: Array<Figure>; accounting: Array<SourceAccounting>; issues: Array<Issue>; pageFurniture: Array<typeof PageFurniture.Type> } = { sourceBlocks: [], figures: [], accounting: [], issues: [], pageFurniture: [] }
  const imagePaths = new Set<string>()
  for (const [index, sourcePage] of middle.pages.entries()) {
    const rendered = input.renderedPages[index]
    const sourceLayout = layout[index]
    if (rendered === undefined || sourceLayout === undefined) return yield* failure("page-coverage", `pages/${index}`, "Page manifest is incomplete")
    const sideways = rendered.rotation === 90 || rendered.rotation === 270
    const sourceWidth = sideways ? sourceLayout.height_pt : sourceLayout.width_pt
    const sourceHeight = sideways ? sourceLayout.width_pt : sourceLayout.height_pt
    if (Math.abs(sourceWidth - rendered.widthPoints) > 0.01 || Math.abs(sourceHeight - rendered.heightPoints) > 0.01 || Math.abs(rendered.width - rendered.widthPoints * rendered.dpi / 72) > 1 || Math.abs(rendered.height - rendered.heightPoints * rendered.dpi / 72) > 1) return yield* failure("coordinates", `renderedPages/${index}`, "Rendered image dimensions, DPI, and declared source-frame rotation must agree with source layout")
    if (!rendered.image.path.endsWith(".png") || imagePaths.has(rendered.image.path.toLowerCase())) return yield* failure("page-coverage", `renderedPages/${index}/image`, "Each page must identify a different artifact with a PNG extension")
    imagePaths.add(rendered.image.path.toLowerCase())
    const page: Page = { id: PageId.make(`page-${index + 1}`), pageNumber: index + 1, width: rendered.width, height: rendered.height, dpi: rendered.dpi, sourceWidth: 1, sourceHeight: 1, sourceUnit: "fraction", sourceOrigin: "top-left", clockwiseRotation: rendered.rotation, sourceToRendered: transformFor(rendered), image: rendered.image }
    pages.push(page)
    let previousIndex = -1
    for (const [blockIndex, node] of sourcePage.blocks.entries()) {
      const sourcePath = `pages/${index}/blocks/${blockIndex}`
      if (node.index === undefined || node.index <= previousIndex) return yield* failure("content", sourcePath, "Top-level source indices must be present, unique, and increasing")
      previousIndex = node.index
      const nodeError = checkNode(node, sourcePath)
      if (nodeError !== undefined) return yield* nodeError
    }
    const converted = convertPage(page, sourcePage.blocks, input.archive, result.sourceBlocks.length)
    result.sourceBlocks.push(...converted.blocks)
    result.figures.push(...converted.figures)
    result.accounting.push(...converted.accounting)
    result.issues.push(...converted.issues)
    result.pageFurniture.push(...converted.pageFurniture)
  }
  const referencedAssets = new Set<string>()
  const inspectAssets = (node: MineruNode): MineruConversionError | undefined => {
    if (node.image_path !== undefined) {
      referencedAssets.add(node.image_path)
      const member = input.archive.entries.find((entry) => entry.path.toLowerCase() === node.image_path?.toLowerCase())
      if (member !== undefined && (member._tag !== "file" || member.path !== node.image_path || !input.archive.nativeAssets.some((asset) => asset.archivePath === node.image_path))) return failure("archive-manifest", node.image_path, "Present native images require a matching verified asset mapping")
    }
    if (typeof node.content !== "string") for (const child of node.content) {
      const issue = inspectAssets(child)
      if (issue !== undefined) return issue
    }
    return undefined
  }
  for (const page of middle.pages) for (const node of page.blocks) {
    const issue = inspectAssets(node)
    if (issue !== undefined) return yield* issue
  }
  if (input.archive.nativeAssets.some((asset) => !referencedAssets.has(asset.archivePath))) return yield* failure("archive-manifest", "archive.nativeAssets", "Every mapped native asset must be referenced by the source document")
  const pageFurniture = result.pageFurniture
  const conversion = yield* Schema.decodeUnknownEffect(MineruConversion)({ extraction: { schemaVersion: "1", scope: { documentId: input.document.id, runId: input.runId, sourceHash: input.document.sourceHash }, pages, sourceBlocks: result.sourceBlocks, ...(pageFurniture.length === 0 ? {} : { pageFurniture }), figures: result.figures }, accounting: result.accounting, issues: result.issues }).pipe(Effect.mapError((error) => failure("content", "extraction", error.message)))
  const violations = validateExtraction(input.document, conversion.extraction)
  if (violations.length > 0) return yield* failure("content", "extraction", violations.map((issue) => `${issue.path}: ${issue.message}`).join("; "))
  if (!conversion.extraction.sourceBlocks.some((block) => block.content.trim() !== "" || block.kind === "figure")) return yield* failure("content", "sourceBlocks", "The extraction contains no usable source content")
  return conversion
})
