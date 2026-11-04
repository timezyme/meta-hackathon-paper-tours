import { Equal, Schema } from "effect"
import { outputFilenames } from "./artifacts.ts"
import type { ArtifactManifest, ImageManifest } from "./artifacts.ts"
import type { CanonicalDocument, Document, Extraction, Figure, Page, SourceBlock, SourceLocation } from "./document.ts"
import { ArtifactHash, NonBlank } from "./identity.ts"
import { canJoinSources } from "./continuation.ts"
import { furnitureProblems, withFurniture } from "./furniture.ts"
import type { BlockId, OutputScope, PageId } from "./identity.ts"
import { canTransitionRun, cropReviewEvidence, museFallback, stageConfiguration } from "./processing.ts"
import { pageExtractionPromptVersion } from "./prompt-templates.ts"
import { validGuideSources } from "./guide.ts"
import type { CheckedPage, FigureSidecar, HeadingSidecar, PageCheck, ProcessingReport, ReuseRequest, Run, StageReceipt } from "./processing.ts"

export class ContractViolation extends Schema.TaggedError<ContractViolation>()("ContractViolation", {
  code: Schema.Literals(["scope", "duplicate", "coverage", "reference", "coordinates", "content", "manifest", "state", "receipt"]),
  path: NonBlank,
  message: NonBlank,
}) {}

const violation = (code: ContractViolation["code"], path: string, message: string) => new ContractViolation({ code, path, message })
const sameScope = (left: OutputScope, right: OutputScope) =>
  left.documentId === right.documentId && left.runId === right.runId && left.revisionId === right.revisionId
const sameJson = Equal.equals
const figureSource = (figure: Figure) => ({
  id: figure.id, sourceBlockIds: figure.sourceBlockIds, locations: figure.locations,
  captionBlockIds: figure.captionBlockIds, originalCaption: figure.originalCaption, asset: figure.asset,
})
const acceptedReceipt = (receipt: StageReceipt) => receipt.state._tag === "completed" && receipt.state.validation._tag === "accepted"
const proseKind = (block: SourceBlock) => block.kind === "heading" || block.kind === "paragraph"
type RegionProvenance = Extract<Figure["asset"], { readonly _tag: "available" }>["provenance"] & object
const matchesRenderedPage = (figure: Figure, provenance: RegionProvenance, page: Page | undefined): page is Page => {
  const { box } = provenance
  return page !== undefined && page.pageNumber === provenance.pageNumber && page.image.hash === provenance.pageImageHash
    && page.width === provenance.pageWidth && page.height === provenance.pageHeight
    && provenance.width === box.width && provenance.height === box.height
    && [box.x, box.y, box.width, box.height].every(Number.isSafeInteger)
    && box.x + box.width <= page.width && box.y + box.height <= page.height
    && figure.locations.some((location) => location.pageId === page.id)
}
const uniqueIssues = (values: ReadonlyArray<string | number>, path: string): Array<ContractViolation> =>
  new Set(values).size === values.length ? [] : [violation("duplicate", path, "Values must be unique")]

const validateLocations = (locations: ReadonlyArray<SourceLocation>, pages: ReadonlyArray<Page>, path: string): Array<ContractViolation> =>
  locations.flatMap((location) => {
    const page = pages.find((entry) => entry.id === location.pageId)
    if (page === undefined || page.pageNumber !== location.pageNumber) return [violation("reference", path, "Location must identify its actual source page")]
    if (location._tag === "box" && (location.box.x + location.box.width > page.width || location.box.y + location.box.height > page.height)) {
      return [violation("coordinates", path, "Box extends outside the rendered page")]
    }
    return []
  })

const validateFigures = (figures: ReadonlyArray<Figure>, sourceBlocks: ReadonlyArray<SourceBlock>, pages: ReadonlyArray<Page>): Array<ContractViolation> => {
  const issues = uniqueIssues(figures.map((figure) => figure.id), "figures.id")
  const covered = new Set<BlockId>()
  for (const figure of figures) {
    const sources = figure.sourceBlockIds.flatMap((id) => sourceBlocks.filter((source) => source.id === id))
    issues.push(...uniqueIssues(figure.sourceBlockIds, `figures.${figure.id}.sourceBlockIds`))
    if (sources.length !== figure.sourceBlockIds.length || sources.some((source) => source.kind !== "figure")) {
      issues.push(violation("reference", `figures.${figure.id}`, "Figure source IDs must identify figure blocks"))
    }
    for (const id of figure.sourceBlockIds) {
      if (covered.has(id)) issues.push(violation("duplicate", `figures.${figure.id}`, "A figure source block belongs to one figure"))
      covered.add(id)
    }
    if (figure.captionBlockIds.some((id) => !sourceBlocks.some((source) => source.id === id && source.kind === "caption"))) {
      issues.push(violation("reference", `figures.${figure.id}.captionBlockIds`, "Caption IDs must identify caption blocks"))
    }
    if (figure.asset._tag === "available" && figure.asset.provenance !== undefined) {
      const provenance = figure.asset.provenance
      const page = pages.find((item) => item.id === provenance.pageId)
      if (!matchesRenderedPage(figure, provenance, page)) {
        issues.push(violation(
          "coordinates", `figures.${figure.id}.asset.provenance`, "Rendered figure regions must match their verified source page and integer crop geometry",
        ))
      }
    }
    issues.push(...validateLocations(figure.locations, pages, `figures.${figure.id}.locations`))
    if (!sameJson(figure.locations, sources.flatMap((source) => source.locations))) {
      issues.push(violation("coverage", `figures.${figure.id}.locations`, "Figure must retain every source location"))
    }
  }
  if (sourceBlocks.some((source) => source.kind === "figure" && !covered.has(source.id))) {
    issues.push(violation("coverage", "figures", "Every source figure needs a figure record"))
  }
  return issues
}

export const validateExtraction = (document: Document, extraction: Extraction): ReadonlyArray<ContractViolation> => {
  const issues: Array<ContractViolation> = []
  if (extraction.scope.documentId !== document.id || extraction.scope.sourceHash !== document.sourceHash) {
    issues.push(violation("scope", "extraction.scope", "Extraction must belong to this source document"))
  }
  if (extraction.pages.length !== document.pageCount || extraction.pages.some((page, index) => page.pageNumber !== index + 1)) {
    issues.push(violation("coverage", "pages", "Every source page must occur once in page-number order"))
  }
  issues.push(...uniqueIssues(extraction.pages.map((page) => page.id), "pages.id"))
  issues.push(...uniqueIssues(extraction.sourceBlocks.map((block) => block.id), "sourceBlocks.id"))
  issues.push(...uniqueIssues(extraction.sourceBlocks.map((block) => block.readingOrder), "sourceBlocks.readingOrder"))
  issues.push(...uniqueIssues((extraction.pageFurniture ?? []).map((item) => item.blockId), "pageFurniture.blockId"))
  for (const item of extraction.pageFurniture ?? []) {
    if (!extraction.sourceBlocks.some((block) => block.id === item.blockId && block.kind === "unclassified")) {
      issues.push(violation("reference", "pageFurniture", "Furniture must identify a retained native unclassified block"))
    }
  }
  for (const page of extraction.pages) {
    const { a, b, c, d } = page.sourceToRendered
    if (a * d - b * c === 0) issues.push(violation("coordinates", `pages.${page.id}.sourceToRendered`, "Source transform must be invertible"))
  }
  for (const [index, block] of extraction.sourceBlocks.entries()) {
    if (block.readingOrder !== index) {
      issues.push(violation("coverage", `sourceBlocks.${block.id}.readingOrder`, "Extraction reading order must be contiguous and stable"))
    }
    issues.push(...validateLocations(block.locations, extraction.pages, `sourceBlocks.${block.id}.locations`))
  }
  issues.push(...validateFigures(extraction.figures, extraction.sourceBlocks, extraction.pages))
  const foreignRegion = (figure: Figure) =>
    figure.asset._tag === "available" && figure.asset.provenance !== undefined && figure.asset.provenance.sourceHash !== document.sourceHash
  if (extraction.figures.some(foreignRegion)) {
    issues.push(violation("scope", "figures.asset.provenance", "Rendered figure regions must identify their source PDF"))
  }
  return issues
}

export const validateCanonicalDocument = (document: Document, extraction: Extraction, canonical: CanonicalDocument): ReadonlyArray<ContractViolation> => {
  const issues = [...validateExtraction(document, extraction)]
  if (canonical.scope.documentId !== document.id || canonical.scope.runId !== extraction.scope.runId || canonical.sourceHash !== document.sourceHash) {
    issues.push(violation("scope", "canonical.scope", "Canonical output must match its extraction and document"))
  }
  if (!sameJson(canonical.pages, extraction.pages) || !sameJson(canonical.sourceBlocks, extraction.sourceBlocks)) {
    issues.push(violation("coverage", "canonical.sourceBlocks", "Canonical output must retain immutable pages and original source blocks"))
  }
  if (!sameJson(canonical.pageFurniture ?? [], extraction.pageFurniture ?? [])) {
    issues.push(violation("coverage", "canonical.pageFurniture", "Canonical output must retain native furniture classifications"))
  }
  issues.push(...uniqueIssues(canonical.blocks.map((block) => block.id), "blocks.id"))
  issues.push(...uniqueIssues(canonical.headingDecisions.map((decision) => decision.blockId), "headingDecisions.blockId"))
  const headings = new Map(canonical.headingDecisions.map((decision) => [decision.blockId, decision.level]))
  for (const decision of canonical.headingDecisions) {
    if (!extraction.sourceBlocks.some((source) => source.id === decision.blockId && proseKind(source))) {
      issues.push(violation("reference", "headingDecisions", "Heading decisions must identify heading or paragraph sources"))
    }
  }
  const covered: Array<BlockId> = []
  for (const block of canonical.blocks) {
    const sources = block.sourceBlockIds.flatMap((id) => extraction.sourceBlocks.filter((source) => source.id === id))
    covered.push(...block.sourceBlockIds)
    if (sources.length !== block.sourceBlockIds.length || block.id !== block.sourceBlockIds[0]) {
      issues.push(violation("reference", `blocks.${block.id}`, "Block ID must retain the first source ID and reference existing sources"))
    }
    if (sources.some((source, index) => index > 0 && source.readingOrder <= (sources[index - 1]?.readingOrder ?? -1))) {
      issues.push(violation("content", `blocks.${block.id}.sourceBlockIds`, "Joined sources must remain in reading order"))
    }
    const unjoinable = sources.some((source, index) => {
      const previous = sources[index - 1]
      return previous !== undefined && !canJoinSources(extraction, previous, source)
    })
    if (unjoinable) {
      issues.push(violation(
        "content", `blocks.${block.id}.sourceBlockIds`, "Joined sources may cross only classified page furniture at the next page boundary",
      ))
    }
    if (!sameJson(block.locations, sources.flatMap((source) => source.locations))) {
      issues.push(violation("coverage", `blocks.${block.id}.locations`, "Joined blocks must retain every contributing source location"))
    }
    const containsNonProse = sources.some((source) => {
      const level = headings.get(source.id)
      return source.kind === "heading" ? level !== null : source.kind !== "paragraph" || (level !== undefined && level !== null)
    })
    if (sources.length > 1 && (block.kind !== "paragraph" || containsNonProse)) {
      issues.push(violation("content", `blocks.${block.id}`, "Only resolved prose can be joined; retained headings and other kinds cannot be absorbed"))
    }
    const first = sources[0]
    if (first !== undefined) {
      const path = `blocks.${block.id}`
      if (block.readingOrder !== first.readingOrder) issues.push(violation("content", `${path}.readingOrder`, "Output retains its first source reading order"))
      if (block.kind !== first.kind && !(proseKind(block) && proseKind(first))) {
        issues.push(violation("content", `${path}.kind`, "Only heading and paragraph classifications may change"))
      }
      if (block.kind === "paragraph" && first.kind === "heading" && headings.get(first.id) !== null) {
        issues.push(violation("content", `${path}.kind`, "Heading demotion requires an explicit null heading decision"))
      }
      if (block.kind === "heading" && headings.get(first.id) !== block.headingLevel) {
        issues.push(violation("content", `${path}.headingLevel`, "Heading level must match its resolved sidecar decision"))
      }
      const level = headings.get(first.id)
      if (level !== undefined && level !== null && block.kind !== "heading") {
        issues.push(violation("content", `${path}.kind`, "A retained heading decision must produce a heading"))
      }
      if (first.kind === "table" && block.format !== first.format) issues.push(violation("content", path, "Native table format must be retained"))
    }
    if (block.content.trim() === "" && sources.some((source) => source.content.trim() !== "")) {
      issues.push(violation("content", `blocks.${block.id}.content`, "Nonempty source content cannot be deleted"))
    }
    if ((block.kind === "heading") !== (block.headingLevel !== null)) {
      issues.push(violation("content", `blocks.${block.id}.headingLevel`, "Only headings have a heading level"))
    }
    issues.push(...validateLocations(block.locations, canonical.pages, `blocks.${block.id}.locations`))
  }
  issues.push(...uniqueIssues(covered, "blocks.sourceBlockIds"))
  if (covered.length !== extraction.sourceBlocks.length || extraction.sourceBlocks.some((source) => !covered.includes(source.id))) {
    issues.push(violation("coverage", "blocks.sourceBlockIds", "Every original block must survive exactly once"))
  }
  if (canonical.blocks.some((block, index) => index > 0 && block.readingOrder <= (canonical.blocks[index - 1]?.readingOrder ?? -1))) {
    issues.push(violation("content", "blocks.readingOrder", "Output blocks must remain in reading order"))
  }
  if (!canonical.blocks.some((block) => block.content.trim() !== "" || block.kind === "figure")) {
    issues.push(violation("content", "blocks", "An empty document is not usable output"))
  }
  issues.push(...validateFigures(canonical.figures, canonical.sourceBlocks, canonical.pages))
  if (!sameJson(canonical.figures.map(figureSource), extraction.figures.map(figureSource))) {
    issues.push(violation("coverage", "figures", "Figure identities, assets, and author captions must survive unchanged"))
  }
  if (canonical.guide !== undefined && !validGuideSources(canonical.guide, canonical.sourceBlocks)) {
    issues.push(violation("reference", "guide.sources", "Guide quotations must match unique passages in immutable source blocks"))
  }
  return issues
}

export const validatePageCheck = (
  extraction: Extraction, pageId: PageId, previousContextIds: ReadonlyArray<BlockId>, result: PageCheck,
): ReadonlyArray<ContractViolation> => {
  const issues: Array<ContractViolation> = []
  const page = extraction.pages.find((entry) => entry.id === pageId)
  if (page === undefined) return [violation("reference", "pageId", "Checked page does not exist")]
  const onPage = (block: SourceBlock) => block.locations.some((location) => location.pageId === pageId)
  for (const message of furnitureProblems(extraction, pageId, result.furniture ?? [])) issues.push(violation("content", "furniture", message))
  const checked = withFurniture(extraction, result.furniture ?? [])
  const blocks = new Map(checked.sourceBlocks.map((block) => [block.id, block]))
  for (const id of previousContextIds) {
    const source = blocks.get(id)
    if (source === undefined || !source.locations.some((location) => location.pageNumber === page.pageNumber - 1)) {
      issues.push(violation("reference", "previousContextIds", "Previous context must come from the preceding source page"))
    }
  }
  issues.push(...uniqueIssues(result.fixes.map((fix) => fix.blockId), "fixes.blockId"))
  issues.push(...uniqueIssues(result.joins.map((join) => join.firstBlockId), "joins.firstBlockId"))
  issues.push(...uniqueIssues(result.joins.map((join) => join.secondBlockId), "joins.secondBlockId"))
  for (const fix of result.fixes) {
    const source = blocks.get(fix.blockId)
    if (source === undefined || !onPage(source)) issues.push(violation("reference", `fixes.${fix.blockId}`, "Fix must target this page"))
    else if (source.kind === "figure" || (source.content.trim() !== "" && fix.content.trim() === "")) {
      issues.push(violation("content", `fixes.${fix.blockId}`, "Fix cannot change figures or delete nonempty content"))
    }
  }
  for (const join of result.joins) {
    const first = blocks.get(join.firstBlockId)
    const second = blocks.get(join.secondBlockId)
    if (first === undefined || second === undefined || !onPage(second) || (!onPage(first) && !previousContextIds.includes(first.id))) {
      issues.push(violation("reference", "joins", "Join must use this page and the supplied previous-page context"))
    } else if (!proseKind(first) || !proseKind(second) || !canJoinSources(checked, first, second)) {
      issues.push(violation(
        "content", "joins", "Join proposal must connect consecutive prose candidates, crossing only classified furniture at a page boundary",
      ))
    }
  }
  return issues
}

export const validateManifest = (manifest: ArtifactManifest, canonical: CanonicalDocument): ReadonlyArray<ContractViolation> => {
  const issues = uniqueIssues(manifest.entries.map((entry) => entry.path), "manifest.entries.path")
  if (!sameScope(manifest.scope, canonical.scope)) issues.push(violation("scope", "manifest.scope", "Manifest revision must match canonical output"))
  for (const path of outputFilenames) {
    const entry = manifest.entries.find((artifact) => artifact.path === path)
    if (entry === undefined || entry.byteCount === 0) issues.push(violation("manifest", path, "Required artifact must exist and contain bytes"))
  }
  const images = canonical.figures.flatMap((figure) => figure.asset._tag === "available" ? [figure.asset.artifact] : [])
  for (const image of images) {
    if (!manifest.entries.some((entry) => sameJson(entry, image))) {
      issues.push(violation("manifest", image.path, "Figure asset must match manifest path, type, size, and hash"))
    }
  }
  for (const entry of manifest.entries) {
    if (entry.path.startsWith("images/") && !images.some((image) => sameJson(entry, image))) {
      issues.push(violation("manifest", entry.path, "Manifest image must belong to a figure"))
    }
    const mismatchedImage = (entry.path.endsWith(".png") && entry.mediaType !== "image/png")
      || (entry.path.endsWith(".jpeg") && entry.mediaType !== "image/jpeg")
      || (entry.path.endsWith(".webp") && entry.mediaType !== "image/webp")
    if (mismatchedImage) issues.push(violation("manifest", entry.path, "Image extension must match its media type"))
  }
  return issues
}

export const validateCheckedPages = (extraction: Extraction, checked: ReadonlyArray<CheckedPage>): ReadonlyArray<ContractViolation> => {
  const issues = uniqueIssues(checked.map((page) => page.pageId), "checked.pageId")
  if (checked.length !== extraction.pages.length || extraction.pages.some((page) => !checked.some((entry) => entry.pageId === page.id))) {
    issues.push(violation("coverage", "checked", "PageCheck results must cover every source page exactly once"))
  }
  const order = new Map(extraction.pages.map((page) => [page.id, page.pageNumber]))
  let base = extraction
  for (const page of checked.toSorted((left, right) => (order.get(left.pageId) ?? 0) - (order.get(right.pageId) ?? 0))) {
    if (!sameJson(page.scope, extraction.scope)) issues.push(violation("scope", "checked.scope", "PageCheck results must belong to this extraction"))
    issues.push(...validatePageCheck(base, page.pageId, page.previousContextIds, page.result))
    base = withFurniture(base, page.result.furniture ?? [])
  }
  const joins = checked.flatMap((page) => page.result.joins)
  issues.push(...uniqueIssues(joins.map((join) => join.firstBlockId), "checked.joins.firstBlockId"))
  issues.push(...uniqueIssues(joins.map((join) => join.secondBlockId), "checked.joins.secondBlockId"))
  return issues
}

export const validateSidecars = (extraction: Extraction, headings: HeadingSidecar, figures: FigureSidecar): ReadonlyArray<ContractViolation> => {
  const issues: Array<ContractViolation> = []
  if (!sameJson(extraction.scope, headings.scope) || !sameJson(extraction.scope, figures.scope) || headings.correctedInputHash !== figures.correctedInputHash) {
    issues.push(violation("scope", "sidecars", "Sidecars must share the extraction and full corrected input revision"))
  }
  issues.push(...uniqueIssues(headings.headings.map((heading) => heading.blockId), "headings.blockId"))
  issues.push(...uniqueIssues(figures.figures.map((figure) => figure.figureId), "figures.figureId"))
  if (headings.headings.some((heading) => !extraction.sourceBlocks.some((source) => source.id === heading.blockId && proseKind(source)))) {
    issues.push(violation("reference", "headings", "Heading sidecar may reference heading or paragraph source blocks"))
  }
  const describedFigures = new Set(figures.figures.map((entry) => entry.figureId))
  if (figures.figures.length !== extraction.figures.length || extraction.figures.some((figure) => !describedFigures.has(figure.id))) {
    issues.push(violation("coverage", "figures", "Figure sidecar must retain a result for every figure"))
  }
  return issues
}

export const validateRunTransition = (previous: Run, next: Run): ReadonlyArray<ContractViolation> => {
  const issues: Array<ContractViolation> = []
  const { state: previousState, mastraRunId: previousMastra, ...previousIdentity } = previous
  const { state: nextState, mastraRunId: nextMastra, ...nextIdentity } = next
  if (!sameJson(previousIdentity, nextIdentity) || (previousMastra !== null && previousMastra !== nextMastra)) {
    issues.push(violation("scope", "run", "An execution keeps its identity, configuration, and workflow association"))
  }
  if (!canTransitionRun(previousState._tag, nextState._tag)) {
    issues.push(violation("state", "run.state", "Run transition is not allowed; retry needs a fresh run"))
  }
  if (previousState._tag === "running" && "startedAt" in nextState && previousState.startedAt !== nextState.startedAt) {
    issues.push(violation("state", "run.state.startedAt", "Run start time is immutable"))
  }
  return issues
}

export const validateReceiptReuse = (receipt: StageReceipt, request: ReuseRequest): ReadonlyArray<ContractViolation> => {
  const issues: Array<ContractViolation> = []
  const sameRequest = receipt.ownerId === request.ownerId && receipt.scope.documentId === request.scope.documentId
    && receipt.scope.sourceHash === request.scope.sourceHash && receipt.pipelineVersion === request.pipelineVersion
    && receipt.schemaVersion === request.schemaVersion && receipt.requestFingerprint === request.requestFingerprint
    && receipt.stage === request.stage && sameJson(receipt.pageIds, request.pageIds) && receipt.figureId === request.figureId && receipt.task === request.task
  if (!sameRequest) {
    issues.push(violation("scope", "receipt", "Reuse requires matching owner, source document, versions, target unit, and complete request fingerprint"))
  }
  if (!acceptedReceipt(receipt)) issues.push(violation("receipt", "receipt.state", "Only a saved and validated completed response can be reused"))
  return issues
}

export const validatePublication = (input: {
  readonly document: Document
  readonly run: Run
  readonly extraction: Extraction
  readonly canonical: CanonicalDocument
  readonly images: ImageManifest
  readonly manifest: ArtifactManifest
  readonly report: ProcessingReport
}): ReadonlyArray<ContractViolation> => {
  const { document, run, extraction, canonical, images, manifest, report } = input
  const issues = [...validateCanonicalDocument(document, extraction, canonical), ...validateManifest(manifest, canonical)]
  const pageIds = canonical.pages.map((page) => page.id)
  const knownPage = (id: PageId) => canonical.pages.some((page) => page.id === id)
  const knownBlock = (id: BlockId) => canonical.sourceBlocks.some((block) => block.id === id)
  const knownFigure = (id: Figure["id"] | null) => id === null || canonical.figures.some((figure) => figure.id === id)
  const warned = (figure: Figure, code: ProcessingReport["issues"][number]["code"]) =>
    report.issues.some((issue) => issue.figureId === figure.id && issue.code === code)
  const unclassifiedWarning = (source: SourceBlock) => report.issues.some((issue) => issue.code === "unclassified-content" && issue.blockIds.includes(source.id)
    && source.locations.every((location) => issue.locations.some((issueLocation) => sameJson(location, issueLocation))))
  const sameProvenance = (delivery: "performed" | "reused", receipt: StageReceipt) => receipt.ownerId === document.ownerId
    && receipt.scope.documentId === document.id && (delivery === "performed") === (receipt.scope.runId === run.id)
    && receipt.scope.sourceHash === document.sourceHash && receipt.pipelineVersion === run.pipelineVersion && receipt.schemaVersion === run.schemaVersion
  const metaExtractionFor = (page: Page) => report.receipts.some(({ receipt }) => receipt.stage === "extraction" && receipt.configuration.provider === "meta"
    && receipt.task === undefined && receipt.figureId === null && receipt.pageIds.length === 1 && receipt.pageIds[0] === page.id && acceptedReceipt(receipt))
  const pageCheckFor = (page: Page) =>
    report.receipts.some(({ receipt }) => receipt.stage === "page-check" && receipt.task === undefined && receipt.pageIds.includes(page.id) && acceptedReceipt(receipt))
  const matchingGuideReceipt = (receipt: StageReceipt | undefined) => run.configuration.guide !== undefined && receipt !== undefined
    && receipt.stage === "guide" && receipt.figureId === null && sameJson(receipt.pageIds, pageIds)
    && sameJson(receipt.configuration, stageConfiguration(run.configuration, "guide"))
    && receipt.inputHashes.length === 2 && receipt.inputHashes[0] === ArtifactHash.make(canonical.sourceHash) && acceptedReceipt(receipt)

  if (document.lifecycle._tag !== "active" || run.ownerId !== document.ownerId || run.documentId !== document.id || run.id !== canonical.scope.runId) {
    issues.push(violation("scope", "run", "Publication needs the active owner's matching document and run"))
  }
  if ((run.state._tag !== "succeeded" && run.state._tag !== "succeeded-with-issues") || run.state.revisionId !== canonical.scope.revisionId) {
    issues.push(violation("state", "run.state", "Success must identify the canonical output revision"))
  }
  if (!sameScope(images.scope, canonical.scope) || !sameJson(images.figures, canonical.figures) || !sameScope(report.scope, canonical.scope)) {
    issues.push(violation("scope", "output", "Images, report, and canonical JSON must describe one revision"))
  }
  if ((report.issues.length > 0) !== (run.state._tag === "succeeded-with-issues")) {
    issues.push(violation("state", "report.issues", "Success outcome must disclose recorded issues"))
  }
  issues.push(...uniqueIssues(report.changes.changedBlockIds, "report.changes.changedBlockIds"))
  for (const id of report.changes.changedBlockIds) {
    if (!knownBlock(id)) issues.push(violation("reference", "report.changes.changedBlockIds", "Changes must identify original source blocks"))
  }
  for (const issue of report.issues) {
    issues.push(...validateLocations(issue.locations, canonical.pages, "report.issues.locations"))
    if (!issue.blockIds.every(knownBlock) || !knownFigure(issue.figureId)) {
      issues.push(violation("reference", "report.issues", "Issue references must exist in this revision"))
    }
  }
  for (const source of canonical.sourceBlocks) {
    const furniture = canonical.pageFurniture?.some((item) => item.blockId === source.id) === true
    if (source.kind === "unclassified" && !furniture && !unclassifiedWarning(source)) {
      issues.push(violation(
        "content", `sourceBlocks.${source.id}`, "Unclassified content requires a warning that identifies the block and all its source locations",
      ))
    }
  }
  for (const check of report.checks) {
    issues.push(...uniqueIssues(check.checkedPageIds, "report.checks.checkedPageIds"))
    if (!check.checkedPageIds.every(knownPage)) issues.push(violation("reference", "report.checks", "Checks must identify this document's pages"))
  }
  const checkedPages = report.checks.filter((check) => check.stage === "page-check").flatMap((check) => check.checkedPageIds)
  if (canonical.pages.some((page) => !checkedPages.includes(page.id))) {
    issues.push(violation("coverage", "report.checks", "Page checking must cover every source page"))
  }
  issues.push(...uniqueIssues(report.receipts.map(({ receipt }) => receipt.id), "report.receipts.id"))
  for (const { delivery, receipt } of report.receipts) {
    if (!sameProvenance(delivery, receipt)) {
      issues.push(violation("scope", "report.receipts", "Receipt must match owner, document, source, versions, and delivery provenance"))
    }
    if (receipt.state._tag === "prepared" || receipt.state._tag === "submitted" || receipt.state._tag === "unknown-completion") {
      issues.push(violation("receipt", "report.receipts", "Unresolved provider completion cannot be published as success"))
    }
    if (delivery === "reused" && !acceptedReceipt(receipt) && !cropReviewEvidence(receipt, report.figureCrops)) {
      issues.push(violation("receipt", "report.receipts", "Reused responses must be completed and validated"))
    }
    if (!receipt.pageIds.every(knownPage) || !knownFigure(receipt.figureId)) {
      issues.push(violation("reference", "report.receipts", "Receipt units must identify this source document"))
    }
    if ((receipt.stage === "extraction") !== (receipt.configuration._tag === "extraction")) {
      issues.push(violation("receipt", "report.receipts.configuration", "Extraction and model receipts must retain their actual configuration kind"))
    }
  }
  if (run.configuration.extractionProvider === "meta" && run.configuration.extractionModel?.promptVersion === pageExtractionPromptVersion) {
    if (canonical.figures.some((figure) => figure.asset._tag === "available" && figure.asset.provenance === undefined)) {
      issues.push(violation("manifest", "figures.asset.provenance", "New Meta figures require rendered-region provenance"))
    }
    for (const page of canonical.pages) {
      if (!metaExtractionFor(page)) issues.push(violation("receipt", `pages.${page.id}`, "Every Meta-extracted page requires an accepted extraction receipt"))
    }
  }
  for (const review of report.museReviews ?? []) {
    if (!review.pageIds.every(knownPage) || !knownFigure(review.figureId)) issues.push(violation("reference", "report.museReviews", "Muse reviews must identify this document's units"))
    if ((review.outcome === "fallback") !== (review.fallback !== null)) issues.push(violation("content", "report.museReviews", "A Muse review fallback must describe what was kept"))
    if (review.outcome === "fallback" && review.stage !== "figures" && !report.issues.some((issue) => issue.code === "provider-failure" && issue.stage === review.stage)) {
      issues.push(violation("content", "report.museReviews", "A Muse review fallback requires a disclosed issue"))
    }
  }
  for (const crop of report.figureCrops ?? []) {
    const figure = canonical.figures.find((item) => item.id === crop.figureId)
    const attempts = crop.attemptIds.map((id) => report.receipts.find((entry) => entry.receipt.id === id)?.receipt)
    if (figure === undefined || !knownPage(crop.pageId) || attempts.some((receipt) => receipt === undefined || receipt.task !== "figure-crop" || receipt.figureId !== crop.figureId)) {
      issues.push(violation("reference", "report.figureCrops", "Figure crop reviews must identify this document's figures and their saved crop-review receipts"))
    } else if (figure.asset._tag === "available" && figure.asset.provenance !== undefined && !sameJson(figure.asset.provenance.box, crop.finalBox)) {
      issues.push(violation("coordinates", "report.figureCrops", "A reviewed crop must match the published figure region"))
    }
    if ((crop.warning !== null) !== (crop.outcome === "unconfirmed" || crop.outcome === "not-reviewed") || crop.warning !== null && !report.issues.some((issue) => issue.code === "figure-crop-unconfirmed" && issue.figureId === crop.figureId)) {
      issues.push(violation("content", "report.figureCrops", "An unconfirmed figure crop requires a located warning"))
    }
  }
  const furniture = new Map((canonical.pageFurniture ?? []).map((item) => [item.blockId, item.role]))
  if ((report.pageCheckFurniture ?? []).some((item) => furniture.get(item.blockId) !== item.role)) {
    issues.push(violation("reference", "report.pageCheckFurniture", "Page-check furniture must be published as page furniture"))
  }
  for (const page of canonical.pages) {
    if (!pageCheckFor(page) && !museFallback(report.museReviews, "page-check", page.id)) issues.push(violation("receipt", `pages.${page.id}`, "Each checked page needs a completed and validated page-check receipt"))
  }
  if (run.configuration.guide !== undefined && canonical.guide === undefined && !museFallback(report.museReviews, "guide")) {
    issues.push(violation("coverage", "guide", "This run requires a saved reading guide before publication"))
  }
  if (canonical.guide !== undefined) {
    const guide = canonical.guide
    const receipt = report.receipts.find((entry) => entry.receipt.id === guide.providerAttemptId)?.receipt
    if (!matchingGuideReceipt(receipt)) {
      issues.push(violation("receipt", "guide.providerAttemptId", "The guide requires its matching configured and accepted saved response receipt"))
    }
    if (!report.checks.some((check) => check.stage === "guide" && check.result === "passed" && sameJson(check.checkedPageIds, pageIds))) {
      issues.push(violation("coverage", "report.checks", "The guide requires a passed source-validation check for the complete document"))
    }
  }
  for (const figure of canonical.figures) {
    if (figure.description._tag !== "generated" && !warned(figure, "figure-description-unavailable")) {
      issues.push(violation("content", `figures.${figure.id}.description`, "Missing description requires a located warning"))
    }
    if (figure.asset._tag === "unavailable" && !warned(figure, "figure-asset-unavailable")) {
      issues.push(violation("content", `figures.${figure.id}.asset`, "Missing figure asset requires a located warning"))
    }
    if (figure.description._tag === "generated") {
      const description = figure.description
      const receipt = report.receipts.find((entry) => entry.receipt.id === description.providerAttemptId)?.receipt
      if (receipt === undefined || receipt.stage !== "figures" || receipt.task !== undefined || receipt.figureId !== figure.id || !acceptedReceipt(receipt)) {
        issues.push(violation("receipt", `figures.${figure.id}.description`, "Generated description requires its validated saved response receipt"))
      }
    }
  }
  return issues
}
