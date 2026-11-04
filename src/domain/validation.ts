import { Equal, Schema } from "effect"
import { outputFilenames } from "./artifacts.ts"
import type { ArtifactManifest, ImageManifest } from "./artifacts.ts"
import type { CanonicalDocument, Document, Extraction, Figure, Page, SourceBlock, SourceLocation } from "./document.ts"
import { NonBlank } from "./identity.ts"
import { canJoinSources } from "./continuation.ts"
import type { BlockId, OutputScope, PageId } from "./identity.ts"
import { canTransitionRun } from "./processing.ts"
import type { CheckedPage, FigureSidecar, HeadingSidecar, PageCheck, ProcessingReport, ReuseRequest, Run, StageReceipt } from "./processing.ts"

export class ContractViolation extends Schema.TaggedError<ContractViolation>()("ContractViolation", {
  code: Schema.Literals(["scope", "duplicate", "coverage", "reference", "coordinates", "content", "manifest", "state", "receipt"]),
  path: NonBlank,
  message: NonBlank,
}) {}

const violation = (code: ContractViolation["code"], path: string, message: string) => new ContractViolation({ code, path, message })
const sameScope = (left: OutputScope, right: OutputScope) => left.documentId === right.documentId && left.runId === right.runId && left.revisionId === right.revisionId
const sameJson = Equal.equals
const figureSource = (figure: Figure) => ({ id: figure.id, sourceBlockIds: figure.sourceBlockIds, locations: figure.locations, captionBlockIds: figure.captionBlockIds, originalCaption: figure.originalCaption, asset: figure.asset })
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
    issues.push(...validateLocations(figure.locations, pages, `figures.${figure.id}.locations`))
    if (!sameJson(figure.locations, sources.flatMap((source) => source.locations))) issues.push(violation("coverage", `figures.${figure.id}.locations`, "Figure must retain every source location"))
  }
  if (sourceBlocks.some((source) => source.kind === "figure" && !covered.has(source.id))) issues.push(violation("coverage", "figures", "Every source figure needs a figure record"))
  return issues
}

export const validateExtraction = (document: Document, extraction: Extraction): ReadonlyArray<ContractViolation> => {
  const issues: Array<ContractViolation> = []
  if (extraction.scope.documentId !== document.id || extraction.scope.sourceHash !== document.sourceHash) issues.push(violation("scope", "extraction.scope", "Extraction must belong to this source document"))
  if (extraction.pages.length !== document.pageCount || extraction.pages.some((page, index) => page.pageNumber !== index + 1)) issues.push(violation("coverage", "pages", "Every source page must occur once in page-number order"))
  issues.push(...uniqueIssues(extraction.pages.map((page) => page.id), "pages.id"))
  issues.push(...uniqueIssues(extraction.sourceBlocks.map((block) => block.id), "sourceBlocks.id"))
  issues.push(...uniqueIssues(extraction.sourceBlocks.map((block) => block.readingOrder), "sourceBlocks.readingOrder"))
  issues.push(...uniqueIssues((extraction.pageFurniture ?? []).map((item) => item.blockId), "pageFurniture.blockId"))
  for (const item of extraction.pageFurniture ?? []) {
    if (!extraction.sourceBlocks.some((block) => block.id === item.blockId && block.kind === "unclassified")) issues.push(violation("reference", "pageFurniture", "Furniture must identify a retained native unclassified block"))
  }
  for (const page of extraction.pages) {
    const { a, b, c, d } = page.sourceToRendered
    if (a * d - b * c === 0) issues.push(violation("coordinates", `pages.${page.id}.sourceToRendered`, "Source transform must be invertible"))
  }
  for (const [index, block] of extraction.sourceBlocks.entries()) {
    if (block.readingOrder !== index) issues.push(violation("coverage", `sourceBlocks.${block.id}.readingOrder`, "Extraction reading order must be contiguous and stable"))
    issues.push(...validateLocations(block.locations, extraction.pages, `sourceBlocks.${block.id}.locations`))
  }
  issues.push(...validateFigures(extraction.figures, extraction.sourceBlocks, extraction.pages))
  return issues
}

export const validateCanonicalDocument = (document: Document, extraction: Extraction, canonical: CanonicalDocument): ReadonlyArray<ContractViolation> => {
  const issues = [...validateExtraction(document, extraction)]
  if (canonical.scope.documentId !== document.id || canonical.scope.runId !== extraction.scope.runId || canonical.sourceHash !== document.sourceHash) issues.push(violation("scope", "canonical.scope", "Canonical output must match its extraction and document"))
  if (!sameJson(canonical.pages, extraction.pages) || !sameJson(canonical.sourceBlocks, extraction.sourceBlocks)) issues.push(violation("coverage", "canonical.sourceBlocks", "Canonical output must retain immutable pages and original source blocks"))
  if (!sameJson(canonical.pageFurniture ?? [], extraction.pageFurniture ?? [])) issues.push(violation("coverage", "canonical.pageFurniture", "Canonical output must retain native furniture classifications"))
  issues.push(...uniqueIssues(canonical.blocks.map((block) => block.id), "blocks.id"))
  issues.push(...uniqueIssues(canonical.headingDecisions.map((decision) => decision.blockId), "headingDecisions.blockId"))
  const headings = new Map(canonical.headingDecisions.map((decision) => [decision.blockId, decision.level]))
  for (const decision of canonical.headingDecisions) {
    if (!extraction.sourceBlocks.some((source) => source.id === decision.blockId && (source.kind === "heading" || source.kind === "paragraph"))) issues.push(violation("reference", "headingDecisions", "Heading decisions must identify heading or paragraph sources"))
  }
  const covered: Array<BlockId> = []
  for (const block of canonical.blocks) {
    const sources = block.sourceBlockIds.flatMap((id) => extraction.sourceBlocks.filter((source) => source.id === id))
    covered.push(...block.sourceBlockIds)
    if (sources.length !== block.sourceBlockIds.length || block.id !== block.sourceBlockIds[0]) issues.push(violation("reference", `blocks.${block.id}`, "Block ID must retain the first source ID and reference existing sources"))
    if (sources.some((source, index) => index > 0 && source.readingOrder <= (sources[index - 1]?.readingOrder ?? -1))) issues.push(violation("content", `blocks.${block.id}.sourceBlockIds`, "Joined sources must remain in reading order"))
    if (sources.some((source, index) => { const previous = sources[index - 1]; return previous !== undefined && !canJoinSources(extraction, previous, source) })) issues.push(violation("content", `blocks.${block.id}.sourceBlockIds`, "Joined sources may cross only classified page furniture at the next page boundary"))
    if (!sameJson(block.locations, sources.flatMap((source) => source.locations))) issues.push(violation("coverage", `blocks.${block.id}.locations`, "Joined blocks must retain every contributing source location"))
    const containsNonProse = sources.some((source) => {
      const level = headings.get(source.id)
      return source.kind === "heading" ? level !== null : source.kind !== "paragraph" || (level !== undefined && level !== null)
    })
    if (sources.length > 1 && (block.kind !== "paragraph" || containsNonProse)) issues.push(violation("content", `blocks.${block.id}`, "Only resolved prose can be joined; retained headings and other kinds cannot be absorbed"))
    const first = sources[0]
    if (first !== undefined) {
      if (block.readingOrder !== first.readingOrder) issues.push(violation("content", `blocks.${block.id}.readingOrder`, "Output retains its first source reading order"))
      if (block.kind !== first.kind && !((block.kind === "heading" && first.kind === "paragraph") || (block.kind === "paragraph" && first.kind === "heading"))) issues.push(violation("content", `blocks.${block.id}.kind`, "Only heading and paragraph classifications may change"))
      if (block.kind === "paragraph" && first.kind === "heading" && headings.get(first.id) !== null) issues.push(violation("content", `blocks.${block.id}.kind`, "Heading demotion requires an explicit null heading decision"))
      if (block.kind === "heading" && headings.get(first.id) !== block.headingLevel) issues.push(violation("content", `blocks.${block.id}.headingLevel`, "Heading level must match its resolved sidecar decision"))
      const level = headings.get(first.id)
      if (level !== undefined && level !== null && block.kind !== "heading") issues.push(violation("content", `blocks.${block.id}.kind`, "A retained heading decision must produce a heading"))
      if (first.kind === "table" && block.format !== first.format) issues.push(violation("content", `blocks.${block.id}`, "Native table format must be retained"))
    }
    if (block.content.trim() === "" && sources.some((source) => source.content.trim() !== "")) issues.push(violation("content", `blocks.${block.id}.content`, "Nonempty source content cannot be deleted"))
    if ((block.kind === "heading") !== (block.headingLevel !== null)) issues.push(violation("content", `blocks.${block.id}.headingLevel`, "Only headings have a heading level"))
    issues.push(...validateLocations(block.locations, canonical.pages, `blocks.${block.id}.locations`))
  }
  issues.push(...uniqueIssues(covered, "blocks.sourceBlockIds"))
  if (covered.length !== extraction.sourceBlocks.length || extraction.sourceBlocks.some((source) => !covered.includes(source.id))) issues.push(violation("coverage", "blocks.sourceBlockIds", "Every original block must survive exactly once"))
  if (canonical.blocks.some((block, index) => index > 0 && block.readingOrder <= (canonical.blocks[index - 1]?.readingOrder ?? -1))) issues.push(violation("content", "blocks.readingOrder", "Output blocks must remain in reading order"))
  if (!canonical.blocks.some((block) => block.content.trim() !== "" || block.kind === "figure")) issues.push(violation("content", "blocks", "An empty document is not usable output"))
  issues.push(...validateFigures(canonical.figures, canonical.sourceBlocks, canonical.pages))
  if (!sameJson(canonical.figures.map(figureSource), extraction.figures.map(figureSource))) issues.push(violation("coverage", "figures", "Figure identities, assets, and author captions must survive unchanged"))
  return issues
}

export const validatePageCheck = (extraction: Extraction, pageId: PageId, previousContextIds: ReadonlyArray<BlockId>, result: PageCheck): ReadonlyArray<ContractViolation> => {
  const issues: Array<ContractViolation> = []
  const page = extraction.pages.find((entry) => entry.id === pageId)
  if (page === undefined) return [violation("reference", "pageId", "Checked page does not exist")]
  const onPage = (block: SourceBlock) => block.locations.some((location) => location.pageId === pageId)
  const blocks = new Map(extraction.sourceBlocks.map((block) => [block.id, block]))
  for (const id of previousContextIds) {
    const source = blocks.get(id)
    if (source === undefined || !source.locations.some((location) => location.pageNumber === page.pageNumber - 1)) issues.push(violation("reference", "previousContextIds", "Previous context must come from the preceding source page"))
  }
  issues.push(...uniqueIssues(result.fixes.map((fix) => fix.blockId), "fixes.blockId"))
  issues.push(...uniqueIssues(result.joins.map((join) => join.firstBlockId), "joins.firstBlockId"))
  issues.push(...uniqueIssues(result.joins.map((join) => join.secondBlockId), "joins.secondBlockId"))
  for (const fix of result.fixes) {
    const source = blocks.get(fix.blockId)
    if (source === undefined || !onPage(source)) issues.push(violation("reference", `fixes.${fix.blockId}`, "Fix must target this page"))
    else if (source.kind === "figure" || (source.content.trim() !== "" && fix.content.trim() === "")) issues.push(violation("content", `fixes.${fix.blockId}`, "Fix cannot change figures or delete nonempty content"))
  }
  for (const join of result.joins) {
    const first = blocks.get(join.firstBlockId)
    const second = blocks.get(join.secondBlockId)
    if (first === undefined || second === undefined || !onPage(second) || (!onPage(first) && !previousContextIds.includes(first.id))) issues.push(violation("reference", "joins", "Join must use this page and the supplied previous-page context"))
    else if ((first.kind !== "paragraph" && first.kind !== "heading") || (second.kind !== "paragraph" && second.kind !== "heading") || !canJoinSources(extraction, first, second)) issues.push(violation("content", "joins", "Join proposal must connect consecutive prose candidates, crossing only classified furniture at a page boundary"))
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
    if (!manifest.entries.some((entry) => sameJson(entry, image))) issues.push(violation("manifest", image.path, "Figure asset must match manifest path, type, size, and hash"))
  }
  for (const entry of manifest.entries) {
    if (entry.path.startsWith("images/") && !images.some((image) => sameJson(entry, image))) issues.push(violation("manifest", entry.path, "Manifest image must belong to a figure"))
    if ((entry.path.endsWith(".png") && entry.mediaType !== "image/png") || (entry.path.endsWith(".jpeg") && entry.mediaType !== "image/jpeg") || (entry.path.endsWith(".webp") && entry.mediaType !== "image/webp")) issues.push(violation("manifest", entry.path, "Image extension must match its media type"))
  }
  return issues
}

export const validateCheckedPages = (extraction: Extraction, checked: ReadonlyArray<CheckedPage>): ReadonlyArray<ContractViolation> => {
  const issues = uniqueIssues(checked.map((page) => page.pageId), "checked.pageId")
  if (checked.length !== extraction.pages.length || extraction.pages.some((page) => !checked.some((entry) => entry.pageId === page.id))) issues.push(violation("coverage", "checked", "PageCheck results must cover every source page exactly once"))
  for (const page of checked) {
    if (!sameJson(page.scope, extraction.scope)) issues.push(violation("scope", "checked.scope", "PageCheck results must belong to this extraction"))
    issues.push(...validatePageCheck(extraction, page.pageId, page.previousContextIds, page.result))
  }
  const joins = checked.flatMap((page) => page.result.joins)
  issues.push(...uniqueIssues(joins.map((join) => join.firstBlockId), "checked.joins.firstBlockId"))
  issues.push(...uniqueIssues(joins.map((join) => join.secondBlockId), "checked.joins.secondBlockId"))
  return issues
}

export const validateSidecars = (extraction: Extraction, headings: HeadingSidecar, figures: FigureSidecar): ReadonlyArray<ContractViolation> => {
  const issues: Array<ContractViolation> = []
  if (!sameJson(extraction.scope, headings.scope) || !sameJson(extraction.scope, figures.scope) || headings.correctedInputHash !== figures.correctedInputHash) issues.push(violation("scope", "sidecars", "Sidecars must share the extraction and full corrected input revision"))
  issues.push(...uniqueIssues(headings.headings.map((heading) => heading.blockId), "headings.blockId"))
  issues.push(...uniqueIssues(figures.figures.map((figure) => figure.figureId), "figures.figureId"))
  if (headings.headings.some((heading) => !extraction.sourceBlocks.some((source) => source.id === heading.blockId && (source.kind === "heading" || source.kind === "paragraph")))) issues.push(violation("reference", "headings", "Heading sidecar may reference heading or paragraph source blocks"))
  if (figures.figures.length !== extraction.figures.length || extraction.figures.some((figure) => !figures.figures.some((entry) => entry.figureId === figure.id))) issues.push(violation("coverage", "figures", "Figure sidecar must retain a result for every figure"))
  return issues
}

export const validateRunTransition = (previous: Run, next: Run): ReadonlyArray<ContractViolation> => {
  const issues: Array<ContractViolation> = []
  const { state: previousState, mastraRunId: previousMastra, ...previousIdentity } = previous
  const { state: nextState, mastraRunId: nextMastra, ...nextIdentity } = next
  if (!sameJson(previousIdentity, nextIdentity) || (previousMastra !== null && previousMastra !== nextMastra)) issues.push(violation("scope", "run", "An execution keeps its identity, configuration, and workflow association"))
  if (!canTransitionRun(previousState._tag, nextState._tag)) issues.push(violation("state", "run.state", "Run transition is not allowed; retry needs a fresh run"))
  if (previousState._tag === "running" && "startedAt" in nextState && previousState.startedAt !== nextState.startedAt) issues.push(violation("state", "run.state.startedAt", "Run start time is immutable"))
  return issues
}

export const validateReceiptReuse = (receipt: StageReceipt, request: ReuseRequest): ReadonlyArray<ContractViolation> => {
  const issues: Array<ContractViolation> = []
  if (receipt.ownerId !== request.ownerId || receipt.scope.documentId !== request.scope.documentId || receipt.scope.sourceHash !== request.scope.sourceHash || receipt.pipelineVersion !== request.pipelineVersion || receipt.schemaVersion !== request.schemaVersion || receipt.requestFingerprint !== request.requestFingerprint || receipt.stage !== request.stage || !sameJson(receipt.pageIds, request.pageIds) || receipt.figureId !== request.figureId) issues.push(violation("scope", "receipt", "Reuse requires matching owner, source document, versions, target unit, and complete request fingerprint"))
  if (receipt.state._tag !== "completed" || receipt.state.validation._tag !== "accepted") issues.push(violation("receipt", "receipt.state", "Only a saved and validated completed response can be reused"))
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
  if (document.lifecycle._tag !== "active" || run.ownerId !== document.ownerId || run.documentId !== document.id || run.id !== canonical.scope.runId) issues.push(violation("scope", "run", "Publication needs the active owner's matching document and run"))
  if ((run.state._tag !== "succeeded" && run.state._tag !== "succeeded-with-issues") || run.state.revisionId !== canonical.scope.revisionId) issues.push(violation("state", "run.state", "Success must identify the canonical output revision"))
  if (!sameScope(images.scope, canonical.scope) || !sameJson(images.figures, canonical.figures) || !sameScope(report.scope, canonical.scope)) issues.push(violation("scope", "output", "Images, report, and canonical JSON must describe one revision"))
  if ((report.issues.length > 0) !== (run.state._tag === "succeeded-with-issues")) issues.push(violation("state", "report.issues", "Success outcome must disclose recorded issues"))
  issues.push(...uniqueIssues(report.changes.changedBlockIds, "report.changes.changedBlockIds"))
  for (const id of report.changes.changedBlockIds) {
    if (!canonical.sourceBlocks.some((block) => block.id === id)) issues.push(violation("reference", "report.changes.changedBlockIds", "Changes must identify original source blocks"))
  }
  for (const issue of report.issues) {
    issues.push(...validateLocations(issue.locations, canonical.pages, "report.issues.locations"))
    if (issue.blockIds.some((id) => !canonical.sourceBlocks.some((block) => block.id === id)) || (issue.figureId !== null && !canonical.figures.some((figure) => figure.id === issue.figureId))) issues.push(violation("reference", "report.issues", "Issue references must exist in this revision"))
  }
  for (const source of canonical.sourceBlocks) {
    if (source.kind === "unclassified" && !canonical.pageFurniture?.some((item) => item.blockId === source.id) && !report.issues.some((issue) => issue.code === "unclassified-content" && issue.blockIds.includes(source.id) && source.locations.every((location) => issue.locations.some((issueLocation) => sameJson(location, issueLocation))))) issues.push(violation("content", `sourceBlocks.${source.id}`, "Unclassified content requires a warning that identifies the block and all its source locations"))
  }
  for (const check of report.checks) {
    issues.push(...uniqueIssues(check.checkedPageIds, "report.checks.checkedPageIds"))
    if (check.checkedPageIds.some((id) => !canonical.pages.some((page) => page.id === id))) issues.push(violation("reference", "report.checks", "Checks must identify this document's pages"))
  }
  const checkedPages = report.checks.filter((check) => check.stage === "page-check").flatMap((check) => check.checkedPageIds)
  if (canonical.pages.some((page) => !checkedPages.includes(page.id))) issues.push(violation("coverage", "report.checks", "Page checking must cover every source page"))
  issues.push(...uniqueIssues(report.receipts.map(({ receipt }) => receipt.id), "report.receipts.id"))
  for (const { delivery, receipt } of report.receipts) {
    if (receipt.ownerId !== document.ownerId || receipt.scope.documentId !== document.id || (delivery === "performed") !== (receipt.scope.runId === run.id) || receipt.scope.sourceHash !== document.sourceHash || receipt.pipelineVersion !== run.pipelineVersion || receipt.schemaVersion !== run.schemaVersion) issues.push(violation("scope", "report.receipts", "Receipt must match owner, document, source, versions, and delivery provenance"))
    if (receipt.state._tag === "prepared" || receipt.state._tag === "submitted" || receipt.state._tag === "unknown-completion") issues.push(violation("receipt", "report.receipts", "Unresolved provider completion cannot be published as success"))
    if (delivery === "reused" && (receipt.state._tag !== "completed" || receipt.state.validation._tag !== "accepted")) issues.push(violation("receipt", "report.receipts", "Reused responses must be completed and validated"))
    if (receipt.pageIds.some((id) => !canonical.pages.some((page) => page.id === id)) || (receipt.figureId !== null && !canonical.figures.some((figure) => figure.id === receipt.figureId))) issues.push(violation("reference", "report.receipts", "Receipt units must identify this source document"))
    if ((receipt.stage === "extraction") !== (receipt.configuration._tag === "extraction")) issues.push(violation("receipt", "report.receipts.configuration", "Extraction and model receipts must retain their actual configuration kind"))
  }
  for (const page of canonical.pages) {
    if (!report.receipts.some(({ receipt }) => receipt.stage === "page-check" && receipt.pageIds.includes(page.id) && receipt.state._tag === "completed" && receipt.state.validation._tag === "accepted")) issues.push(violation("receipt", `pages.${page.id}`, "Each checked page needs a completed and validated page-check receipt"))
  }
  for (const figure of canonical.figures) {
    if (figure.description._tag !== "generated" && !report.issues.some((issue) => issue.figureId === figure.id && issue.code === "figure-description-unavailable")) issues.push(violation("content", `figures.${figure.id}.description`, "Missing description requires a located warning"))
    if (figure.asset._tag === "unavailable" && !report.issues.some((issue) => issue.figureId === figure.id && issue.code === "figure-asset-unavailable")) issues.push(violation("content", `figures.${figure.id}.asset`, "Missing figure asset requires a located warning"))
    if (figure.description._tag === "generated") {
      const description = figure.description
      const receipt = report.receipts.find((entry) => entry.receipt.id === description.providerAttemptId)?.receipt
      if (receipt === undefined || receipt.stage !== "figures" || receipt.figureId !== figure.id || receipt.state._tag !== "completed" || receipt.state.validation._tag !== "accepted") issues.push(violation("receipt", `figures.${figure.id}.description`, "Generated description requires its validated saved response receipt"))
    }
  }
  return issues
}
