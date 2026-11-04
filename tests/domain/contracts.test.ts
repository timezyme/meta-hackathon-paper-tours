import { Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { ArtifactHash, ArtifactManifest, BlockId, CanonicalDocument, CheckedPage, Document, DocumentId, Extraction, FigureSidecar, HeadingSidecar, ImageManifest, MastraRunId, OutputRevisionId, PageCheck, PageId, PixelBox, ProcessingReport, ProviderAttemptId, ReceiptState, RelativePath, RequestFingerprint, ReuseRequest, Run, RunId, SourceBlock, SourceHash, StageReceipt, Timestamp, Usage, UserId, boundaryParseOptions, canTransitionReceipt, canTransitionRun, currentRunReceipts, productRoutes, validateCanonicalDocument, validateCheckedPages, validateExtraction, validateManifest, validatePageCheck, validatePublication, validateReceiptReuse, validateRunTransition, validateSidecars } from "../../src/domain/index.ts"
import { contractFixture, fixtureHash, fixtureNames, fixtureTime } from "../fixtures/contracts.ts"

const roundtrip = (schema: Schema.ConstraintCodec<unknown, unknown>, value: unknown) => {
  const decoded = Schema.decodeUnknownSync(schema, boundaryParseOptions)(value)
  const encoded = Schema.encodeUnknownSync(schema)(decoded)
  expect(Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(encoded)))).toEqual(decoded)
}

const orderedParagraphFixture = () => {
  const fixture = contractFixture()
  const sourceBlocks = ["First.", "Second.", "Third."].map((content, index) => ({ id: `block-${index + 1}`, kind: "paragraph", readingOrder: index, content, format: "text", locations: [{ _tag: "page", pageId: "page-1", pageNumber: 1 }] }))
  const extraction = Schema.decodeUnknownSync(Extraction)({ ...fixture.extraction, sourceBlocks })
  const canonical = Schema.decodeUnknownSync(CanonicalDocument)({ ...fixture.canonical, sourceBlocks, headingDecisions: [], blocks: sourceBlocks.map((block) => ({ ...block, sourceBlockIds: [block.id], headingLevel: null })) })
  return { ...fixture, extraction, canonical }
}

describe("versioned shared contracts", () => {
  it.each(fixtureNames)("round-trips every artifact for %s", (name) => {
    const fixture = contractFixture(name)
    roundtrip(Document, fixture.document)
    roundtrip(Run, fixture.run)
    roundtrip(Extraction, fixture.extraction)
    roundtrip(CanonicalDocument, fixture.canonical)
    roundtrip(ImageManifest, fixture.images)
    roundtrip(ArtifactManifest, fixture.manifest)
    roundtrip(ProcessingReport, fixture.report)
  })

  it("exports JSON Schema directly from the shared contracts", () => {
    for (const schema of [Document, Run, CanonicalDocument, ImageManifest, ArtifactManifest, ProcessingReport, PageCheck]) {
      const json = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
      expect(JSON.stringify(json)).toContain("properties")
    }
  })

  it("keeps semantic identities distinct at compile time", () => {
    expectTypeOf<DocumentId>().not.toEqualTypeOf<UserId>()
    expectTypeOf<DocumentId>().not.toEqualTypeOf<RunId>()
    expectTypeOf<RunId>().not.toEqualTypeOf<MastraRunId>()
    expectTypeOf<RunId>().not.toEqualTypeOf<ProviderAttemptId>()
    expectTypeOf<SourceHash>().not.toEqualTypeOf<ArtifactHash>()
    expectTypeOf<SourceHash>().not.toEqualTypeOf<RequestFingerprint>()
    expectTypeOf<OutputRevisionId>().not.toEqualTypeOf<RunId>()
  })

  it.each(["", "../document", "two words", "a/b", "a\\b", "x".repeat(129)])("rejects malformed opaque ID %j", (id) => {
    expect(() => Schema.decodeUnknownSync(DocumentId)(id)).toThrow()
  })

  it.each(["2026-99-99T99:99:99.999Z", "2026-02-29T12:00:00.000Z", "2026-04-31T12:00:00.000Z", "2026-10-27T24:00:00.000Z"])("rejects impossible timestamp %s", (value) => {
    expect(() => Schema.decodeUnknownSync(Timestamp)(value)).toThrow()
  })

  it("accepts leap day and keeps canonical timestamps as strings", () => {
    expect(Schema.decodeUnknownSync(Timestamp)("2028-02-29T12:00:00.000Z")).toBe("2028-02-29T12:00:00.000Z")
  })

  it("rejects path-like original filenames and control characters", () => {
    const { document } = contractFixture()
    for (const originalFilename of ["../a.pdf", "C:\\a.pdf", "a\nb.pdf", "a\u0000.pdf"]) expect(() => Schema.decodeUnknownSync(Document)({ ...document, originalFilename })).toThrow()
  })
})

describe("source accounting and coordinates", () => {
  it.each(fixtureNames)("covers every source page for %s", (name) => {
    const fixture = contractFixture(name)
    expect(validateExtraction(fixture.document, fixture.extraction)).toEqual([])
  })

  it("rejects duplicate IDs, missing pages, wrong page numbers, and wrong document scope", () => {
    const { document, extraction } = contractFixture("cross-page")
    const firstPage = extraction.pages[0]
    expect(validateExtraction(document, { ...extraction, pages: [firstPage, firstPage] }).length).toBeGreaterThan(0)
    expect(validateExtraction(document, { ...extraction, pages: [firstPage] }).length).toBeGreaterThan(0)
    expect(validateExtraction(document, { ...extraction, pages: [{ ...firstPage, pageNumber: 2 }, ...extraction.pages.slice(1)] }).length).toBeGreaterThan(0)
    expect(validateExtraction(document, { ...extraction, scope: { ...extraction.scope, documentId: DocumentId.make("another-document") } }).length).toBeGreaterThan(0)
    const firstBlock = Schema.decodeUnknownSync(SourceBlock)(extraction.sourceBlocks[0])
    expect(validateExtraction(document, { ...extraction, sourceBlocks: [firstBlock, firstBlock] }).length).toBeGreaterThan(0)
  })

  it("requires finite positive pixel extents and in-page boxes", () => {
    const box = { coordinateSystem: "rendered-page-top-left-pixels", x: 10, y: 20, width: 100, height: 50 }
    for (const invalid of [{ ...box, x: -1 }, { ...box, width: 0 }, { ...box, height: Infinity }, { ...box, coordinateSystem: "pdf-points" }]) expect(() => Schema.decodeUnknownSync(PixelBox)(invalid)).toThrow()
    const fixture = contractFixture("normal")
    const extraction = Schema.decodeUnknownSync(Extraction)({ ...fixture.extraction, sourceBlocks: fixture.extraction.sourceBlocks.map((block) => ({ ...block, locations: [{ _tag: "box", pageId: "page-1", pageNumber: 1, box }] })) })
    expect(validateExtraction(fixture.document, extraction)).toEqual([])
    const outside = Schema.decodeUnknownSync(Extraction)({ ...extraction, sourceBlocks: extraction.sourceBlocks.map((block) => ({ ...block, locations: [{ _tag: "box", pageId: "page-1", pageNumber: 1, box: { ...box, x: 1220 } }] })) })
    expect(validateExtraction(fixture.document, outside).some((issue) => issue.code === "coordinates")).toBe(true)
    const singular = { ...extraction, pages: [{ ...extraction.pages[0], sourceToRendered: { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 } }] }
    expect(validateExtraction(fixture.document, Schema.decodeUnknownSync(Extraction)(singular)).some((issue) => issue.code === "coordinates")).toBe(true)
  })

  it("preserves cross-page locations and immutable originals after a join", () => {
    const fixture = contractFixture("cross-page")
    expect(validateCanonicalDocument(fixture.document, fixture.extraction, fixture.canonical)).toEqual([])
    expect(fixture.canonical.blocks[0]?.locations.map((location) => location.pageNumber)).toEqual([1, 2])
    expect(fixture.canonical.sourceBlocks.map((block) => block.content)).toEqual(["A paragraph starts on this", "page and finishes here."])
    const missingLocation = Schema.decodeUnknownSync(CanonicalDocument)({ ...fixture.canonical, blocks: fixture.canonical.blocks.map((block) => ({ ...block, locations: [block.locations[0]] })) })
    expect(validateCanonicalDocument(fixture.document, fixture.extraction, missingLocation).some((issue) => issue.code === "coverage")).toBe(true)
  })

  it.each(["references", "notes", "table", "ambiguous-math"] as const)("keeps substantive %s content", (name) => {
    const fixture = contractFixture(name)
    expect(validateCanonicalDocument(fixture.document, fixture.extraction, fixture.canonical)).toEqual([])
    expect(fixture.canonical.blocks.map((block) => block.content)).toEqual(fixture.extraction.sourceBlocks.map((block) => block.content))
    const omitted = { ...fixture.canonical, blocks: fixture.canonical.blocks.slice(0, -1) }
    expect(validateCanonicalDocument(fixture.document, fixture.extraction, omitted).some((issue) => issue.code === "coverage")).toBe(true)
  })

  it("rejects mutated originals, duplicate accounting, and changed table formats", () => {
    const fixture = contractFixture("table")
    const duplicate = { ...fixture.canonical, blocks: [...fixture.canonical.blocks, ...fixture.canonical.blocks] }
    expect(validateCanonicalDocument(fixture.document, fixture.extraction, duplicate).some((issue) => issue.code === "duplicate")).toBe(true)
    const changed = { ...fixture.canonical, blocks: fixture.canonical.blocks.map((block) => ({ ...block, content: "A lossy table summary" })) }
    expect(validateCanonicalDocument(fixture.document, fixture.extraction, changed)).toEqual([])
    const reformatted = { ...changed, blocks: changed.blocks.map((block) => ({ ...block, format: "text" as const })) }
    expect(validateCanonicalDocument(fixture.document, fixture.extraction, reformatted).some((issue) => issue.code === "content")).toBe(true)
    const originals = { ...fixture.canonical, sourceBlocks: fixture.canonical.sourceBlocks.map((block) => ({ ...block, content: "replacement original" })) }
    expect(validateCanonicalDocument(fixture.document, fixture.extraction, originals).some((issue) => issue.code === "coverage")).toBe(true)
  })

  it("compares immutable source records independently of object property order", () => {
    const fixture = contractFixture()
    const reordered = { ...fixture.canonical, sourceBlocks: fixture.canonical.sourceBlocks.map((block) => ({ locations: block.locations, content: block.content, format: block.format, readingOrder: block.readingOrder, kind: block.kind, id: block.id })) }
    expect(validateCanonicalDocument(fixture.document, fixture.extraction, reordered)).toEqual([])
  })

  it("rejects canonical joins that interleave source content", () => {
    const fixture = orderedParagraphFixture()
    expect(validateCanonicalDocument(fixture.document, fixture.extraction, fixture.canonical)).toEqual([])
    const reordered = Schema.decodeUnknownSync(CanonicalDocument)({ ...fixture.canonical, blocks: [{
      ...fixture.canonical.blocks[0], content: "First. Third.", sourceBlockIds: ["block-1", "block-3"],
      locations: fixture.extraction.sourceBlocks.filter((block) => block.id !== "block-2").flatMap((block) => block.locations),
    }, fixture.canonical.blocks[1]] })
    expect(validateCanonicalDocument(fixture.document, fixture.extraction, reordered).some((issue) => issue.code === "content" && issue.path.endsWith(".sourceBlockIds"))).toBe(true)
    const adjacentChain = Schema.decodeUnknownSync(CanonicalDocument)({ ...fixture.canonical, blocks: [{
      ...fixture.canonical.blocks[0], content: "First. Second. Third.", sourceBlockIds: ["block-1", "block-2", "block-3"],
      locations: fixture.extraction.sourceBlocks.flatMap((block) => block.locations),
    }] })
    expect(validateCanonicalDocument(fixture.document, fixture.extraction, adjacentChain)).toEqual([])
  })
})

describe("PageCheck and sidecars", () => {
  it("rejects a skipped source block while permitting adjacent join chains", () => {
    const { extraction } = orderedParagraphFixture()
    const adjacent = Schema.decodeUnknownSync(PageCheck)({ fixes: [], joins: [{ firstBlockId: "block-1", secondBlockId: "block-2", answer: "same" }, { firstBlockId: "block-2", secondBlockId: "block-3", answer: "same" }] })
    expect(validatePageCheck(extraction, PageId.make("page-1"), [], adjacent)).toEqual([])
    const skipped = Schema.decodeUnknownSync(PageCheck)({ fixes: [], joins: [{ firstBlockId: "block-1", secondBlockId: "block-3", answer: "same" }] })
    expect(validatePageCheck(extraction, PageId.make("page-1"), [], skipped).some((issue) => issue.code === "content")).toBe(true)
  })

  it("accepts the actual fixes/joins wire shape and validates supplied context", () => {
    const { extraction } = contractFixture("cross-page")
    const result = Schema.decodeUnknownSync(PageCheck)({ fixes: [{ blockId: "block-2", content: "page and finishes here." }], joins: [{ firstBlockId: "block-1", secondBlockId: "block-2", answer: "same" }] })
    roundtrip(PageCheck, result)
    expect(validatePageCheck(extraction, PageId.make("page-2"), [BlockId.make("block-1")], result)).toEqual([])
    expect(validatePageCheck(extraction, PageId.make("page-2"), [], result).some((issue) => issue.code === "reference")).toBe(true)
    expect(validatePageCheck(extraction, PageId.make("page-1"), [], result).length).toBeGreaterThan(0)
  })

  it("rejects unknown IDs, duplicate edits, deletion, and backward joins", () => {
    const { extraction } = contractFixture("cross-page")
    const checks = [
      { fixes: [{ blockId: "missing", content: "hello" }], joins: [] },
      { fixes: [{ blockId: "block-1", content: "a" }, { blockId: "block-1", content: "b" }], joins: [] },
      { fixes: [{ blockId: "block-1", content: " " }], joins: [] },
      { fixes: [], joins: [{ firstBlockId: "block-2", secondBlockId: "block-1", answer: "word" }] },
    ]
    for (const check of checks) expect(validatePageCheck(extraction, PageId.make("page-1"), [], Schema.decodeUnknownSync(PageCheck)(check)).length).toBeGreaterThan(0)
  })

  it("accepts table correction but rejects incomplete page checks", () => {
    const table = contractFixture("table")
    const check = Schema.decodeUnknownSync(PageCheck)({ fixes: [{ blockId: "block-1", content: "replacement" }], joins: [] })
    expect(validatePageCheck(table.extraction, PageId.make("page-1"), [], check)).toEqual([])
    const { extraction } = contractFixture("cross-page")
    const checked = extraction.pages.map((page) => Schema.decodeUnknownSync(CheckedPage)({ scope: extraction.scope, pageId: page.id, previousContextIds: [], result: { fixes: [], joins: [] }, providerAttemptId: "attempt-one" }))
    expect(validateCheckedPages(extraction, checked)).toEqual([])
    expect(validateCheckedPages(extraction, checked.slice(1)).some((issue) => issue.code === "coverage")).toBe(true)
    expect(validateCheckedPages(extraction, [...checked, ...checked]).some((issue) => issue.code === "duplicate")).toBe(true)
  })

  it("keeps heading and figure sidecars bound to the same corrected source", () => {
    const { extraction } = contractFixture("missing-description")
    const headings = Schema.decodeUnknownSync(HeadingSidecar)({ scope: extraction.scope, correctedInputHash: fixtureHash, providerAttemptId: "headings-attempt", headings: [] })
    const figures = Schema.decodeUnknownSync(FigureSidecar)({ scope: extraction.scope, correctedInputHash: fixtureHash, figures: [{ figureId: "figure-1", description: { _tag: "unavailable", reason: "No description" } }] })
    expect(validateSidecars(extraction, headings, figures)).toEqual([])
    expect(validateSidecars(extraction, headings, { ...figures, figures: [] }).some((issue) => issue.code === "coverage")).toBe(true)
    expect(validateSidecars(extraction, headings, { ...figures, correctedInputHash: ArtifactHash.make("b".repeat(64)) }).some((issue) => issue.code === "scope")).toBe(true)
  })

  it("demotes a false extracted heading without rewriting unrelated content kinds", () => {
    const fixture = contractFixture()
    const headings = Schema.decodeUnknownSync(HeadingSidecar)({ scope: fixture.extraction.scope, correctedInputHash: fixtureHash, providerAttemptId: "headings-attempt", headings: [{ blockId: "block-1", level: null }] })
    const figures = Schema.decodeUnknownSync(FigureSidecar)({ scope: fixture.extraction.scope, correctedInputHash: fixtureHash, figures: [] })
    expect(validateSidecars(fixture.extraction, headings, figures)).toEqual([])
    const demoted = Schema.decodeUnknownSync(CanonicalDocument)({ ...fixture.canonical, headingDecisions: headings.headings, blocks: fixture.canonical.blocks.map((block) => block.id === "block-1" ? { ...block, kind: "paragraph", headingLevel: null } : block) })
    expect(validateCanonicalDocument(fixture.document, fixture.extraction, demoted)).toEqual([])
    expect(demoted.sourceBlocks[0]?.kind).toBe("heading")
    expect(demoted.blocks[0]?.content).toBe("A synthetic document")
    const changed = Schema.decodeUnknownSync(CanonicalDocument)({ ...fixture.canonical, blocks: fixture.canonical.blocks.map((block) => block.id === "block-1" ? { ...block, kind: "note", headingLevel: null } : block) })
    expect(validateCanonicalDocument(fixture.document, fixture.extraction, changed).some((issue) => issue.code === "content")).toBe(true)
  })

  it("joins a demoted false heading but never absorbs a retained heading", () => {
    const fixture = contractFixture()
    const result = Schema.decodeUnknownSync(PageCheck)({ fixes: [], joins: [{ firstBlockId: "block-1", secondBlockId: "block-2", answer: "same" }] })
    expect(validatePageCheck(fixture.extraction, PageId.make("page-1"), [], result)).toEqual([])
    const joined = Schema.decodeUnknownSync(CanonicalDocument)({ ...fixture.canonical, headingDecisions: [{ blockId: "block-1", level: null }], blocks: [{
      id: "block-1", kind: "paragraph", readingOrder: 0, format: "text", headingLevel: null,
      content: "A synthetic document. The result is 12 units.", sourceBlockIds: ["block-1", "block-2"], locations: fixture.extraction.sourceBlocks.flatMap((block) => block.locations),
    }] })
    expect(validateCanonicalDocument(fixture.document, fixture.extraction, joined)).toEqual([])
    expect(validateCanonicalDocument(fixture.document, fixture.extraction, { ...joined, headingDecisions: fixture.canonical.headingDecisions }).some((issue) => issue.code === "content")).toBe(true)
  })
})

describe("publication and output revision", () => {
  it.each(fixtureNames.filter((name) => name !== "empty"))("publishes structurally complete %s output", (name) => {
    expect(validatePublication(contractFixture(name))).toEqual([])
  })

  it("rejects a blank document as usable output", () => {
    expect(validatePublication(contractFixture("empty")).some((issue) => issue.code === "content")).toBe(true)
  })

  it("requires a located warning for known unclassified content", () => {
    const fixture = contractFixture("scan")
    expect(validatePublication(fixture)).toEqual([])
    const cleanRun = Schema.decodeUnknownSync(Run)({ ...fixture.run, state: { ...fixture.run.state, _tag: "succeeded" } })
    expect(validatePublication({ ...fixture, run: cleanRun, report: { ...fixture.report, issues: [] } }).some((issue) => issue.code === "content")).toBe(true)
    const untargeted = { ...fixture.report, issues: fixture.report.issues.map((issue) => ({ ...issue, blockIds: [] })) }
    expect(validatePublication({ ...fixture, report: untargeted }).some((issue) => issue.code === "content")).toBe(true)
  })

  it("requires an unclassified warning to retain the affected source location", () => {
    const fixture = contractFixture("scan")
    const location = { _tag: "box", pageId: "page-1", pageNumber: 1, box: { coordinateSystem: "rendered-page-top-left-pixels", x: 10, y: 20, width: 100, height: 50 } }
    const extraction = Schema.decodeUnknownSync(Extraction)({ ...fixture.extraction, sourceBlocks: fixture.extraction.sourceBlocks.map((block) => ({ ...block, locations: [location] })) })
    const canonical = Schema.decodeUnknownSync(CanonicalDocument)({ ...fixture.canonical, sourceBlocks: extraction.sourceBlocks, blocks: fixture.canonical.blocks.map((block) => ({ ...block, locations: [location] })) })
    const report = Schema.decodeUnknownSync(ProcessingReport)({ ...fixture.report, issues: fixture.report.issues.map((issue) => ({ ...issue, locations: [location] })) })
    expect(validatePublication({ ...fixture, extraction, canonical, report })).toEqual([])
    const misplaced = Schema.decodeUnknownSync(ProcessingReport)({ ...report, issues: report.issues.map((issue) => ({ ...issue, locations: [{ ...location, box: { ...location.box, x: 200 } }] })) })
    expect(validatePublication({ ...fixture, extraction, canonical, report: misplaced }).some((issue) => issue.code === "content")).toBe(true)
  })

  it("keeps an image and author caption when the description fails", () => {
    const fixture = contractFixture("missing-description")
    expect(fixture.canonical.figures[0]?.asset._tag).toBe("available")
    expect(fixture.canonical.figures[0]?.originalCaption).toBe("Figure 1. A synthetic black square.")
    expect(fixture.manifest.entries.some((entry) => entry.path === "images/figure-1.png")).toBe(true)
    expect(validatePublication(fixture)).toEqual([])
    expect(validatePublication({ ...fixture, report: { ...fixture.report, issues: [] } }).length).toBeGreaterThan(0)
  })

  it("rejects revision mismatch, missing artifacts, and asset hash mismatch", () => {
    const fixture = contractFixture("missing-description")
    const wrongRevision = { ...fixture.manifest, scope: { ...fixture.manifest.scope, revisionId: OutputRevisionId.make("another-revision") } }
    expect(validateManifest(wrongRevision, fixture.canonical).some((issue) => issue.code === "scope")).toBe(true)
    const missing = Schema.decodeUnknownSync(ArtifactManifest)({ ...fixture.manifest, entries: fixture.manifest.entries.filter((entry) => entry.path !== "processing-report.json") })
    expect(validateManifest(missing, fixture.canonical).some((issue) => issue.code === "manifest")).toBe(true)
    const wrongHash = Schema.decodeUnknownSync(ArtifactManifest)({ ...fixture.manifest, entries: fixture.manifest.entries.map((entry) => entry.path.startsWith("images/") ? { ...entry, hash: "b".repeat(64) } : entry) })
    expect(validateManifest(wrongHash, fixture.canonical).some((issue) => issue.code === "manifest")).toBe(true)
    expect(validatePublication({ ...fixture, images: { ...fixture.images, scope: wrongRevision.scope } }).some((issue) => issue.code === "scope")).toBe(true)
  })

  it.each(["../secret", "/etc/passwd", "C:/secret", "images/../secret", "images/%2e%2e/secret", "images\\image.png", "images/a\u0000.png"])("rejects unsafe relative path %j", (path) => {
    expect(() => Schema.decodeUnknownSync(RelativePath)(path)).toThrow()
    const fixture = contractFixture()
    expect(() => Schema.decodeUnknownSync(ArtifactManifest)({ ...fixture.manifest, entries: [{ path, mediaType: "image/png", byteCount: 1, hash: fixtureHash }] })).toThrow()
  })

  it("keeps unmeasured quality unavailable even when no edits were recorded", () => {
    const { report } = contractFixture("ambiguous-math")
    expect(report.changes.changedBlockIds).toEqual([])
    expect(report.ambiguity._tag).toBe("unavailable")
    expect(report.verifiedCorrectionCount._tag).toBe("unavailable")
    expect(report.receipts[0]?.receipt.state._tag).toBe("completed")
  })

  it("rejects a page-check claim without a saved validated receipt", () => {
    const fixture = contractFixture()
    expect(validatePublication({ ...fixture, report: { ...fixture.report, receipts: [] } }).some((issue) => issue.code === "receipt")).toBe(true)
  })
})

describe("run lifecycle and response reuse", () => {
  it("allows only the execution lifecycle and requires a fresh run for retry", () => {
    expect(canTransitionRun("queued", "running")).toBe(true)
    expect(canTransitionRun("queued", "succeeded")).toBe(false)
    for (const terminal of ["succeeded", "succeeded-with-issues", "failed", "interrupted"] as const) {
      expect(canTransitionRun("running", terminal)).toBe(true)
      expect(canTransitionRun(terminal, "running")).toBe(false)
      expect(canTransitionRun(terminal, "queued")).toBe(false)
    }
    const fixture = contractFixture()
    const queued = Schema.decodeUnknownSync(Run)({ ...fixture.run, state: { _tag: "queued" } })
    const running = Schema.decodeUnknownSync(Run)({ ...fixture.run, state: { _tag: "running", startedAt: fixtureTime, progress: { stage: "extraction", completedUnits: 0, totalUnits: null } } })
    expect(validateRunTransition(queued, running)).toEqual([])
    expect(validateRunTransition(running, fixture.run)).toEqual([])
    expect(validateRunTransition(fixture.run, queued).some((issue) => issue.code === "state")).toBe(true)
    expect(validateRunTransition(queued, { ...running, id: RunId.make("another-run") }).some((issue) => issue.code === "scope")).toBe(true)
  })

  it("retains unknown completion and unknown usage explicitly", () => {
    const fixture = contractFixture()
    const receipt = Schema.decodeUnknownSync(StageReceipt)(fixture.report.receipts[0]?.receipt)
    const unknown = Schema.decodeUnknownSync(StageReceipt)({ ...receipt, state: { _tag: "unknown-completion", observedAt: fixtureTime, providerRequestId: null, reason: "Connection lost after send" } })
    roundtrip(StageReceipt, unknown)
    expect(validatePublication({ ...fixture, report: { ...fixture.report, receipts: [{ delivery: "performed", receipt: unknown }] } }).some((issue) => issue.code === "receipt")).toBe(true)
    expect(canTransitionReceipt("prepared", "completed")).toBe(false)
    expect(canTransitionReceipt("unknown-completion", "completed")).toBe(true)
    expect(canTransitionReceipt("completed", "submitted")).toBe(false)
    expect(() => Schema.decodeUnknownSync(Usage)({ _tag: "reported", inputTokens: null, outputTokens: null, costUsd: null })).toThrow()
    expect(() => Schema.decodeUnknownSync(ReceiptState, boundaryParseOptions)({ _tag: "prepared", providerRequestId: "not-received-yet" })).toThrow()
  })

  it("records extraction without fabricated model settings", () => {
    const fixture = contractFixture()
    const receipt = Schema.decodeUnknownSync(StageReceipt)(fixture.report.receipts[0]?.receipt)
    const extraction = Schema.decodeUnknownSync(StageReceipt)({ ...receipt, stage: "extraction", configuration: { _tag: "extraction", provider: "mineru", version: "fixture" } })
    expect(extraction.configuration).toEqual({ _tag: "extraction", provider: "mineru", version: "fixture" })
    roundtrip(StageReceipt, extraction)
  })

  it("reuses the original paid attempt and rejects changed fingerprint, unit, and owner", () => {
    const fixture = contractFixture()
    const receipt = Schema.decodeUnknownSync(StageReceipt)(fixture.report.receipts[0]?.receipt)
    const request = Schema.decodeUnknownSync(ReuseRequest)({ ...receipt, scope: { ...receipt.scope, runId: "new-run" } })
    expect(validateReceiptReuse(receipt, request)).toEqual([])
    expect(validateReceiptReuse(receipt, { ...request, ownerId: UserId.make("another-user") }).length).toBeGreaterThan(0)
    expect(validateReceiptReuse(receipt, { ...request, requestFingerprint: RequestFingerprint.make("b".repeat(64)) }).length).toBeGreaterThan(0)
    expect(validateReceiptReuse(receipt, { ...request, pageIds: [PageId.make("another-page")] }).length).toBeGreaterThan(0)
    const reused = { ...fixture.report, scope: { ...fixture.report.scope, runId: RunId.make("new-run") }, receipts: [{ delivery: "reused" as const, receipt }] }
    expect(currentRunReceipts(reused)).toEqual([])
    expect(reused.receipts[0]?.receipt.id).toBe(receipt.id)
    expect(reused.receipts[0]?.receipt.scope.runId).toBe(fixture.run.id)
    expect(currentRunReceipts(fixture.report).map((entry) => entry.id)).toEqual([receipt.id])
    expect(validatePublication({ ...fixture, report: { ...fixture.report, receipts: [{ delivery: "reused", receipt }] } }).some((issue) => issue.code === "scope")).toBe(true)
    const olderReceipt = { ...receipt, scope: { ...receipt.scope, runId: RunId.make("older-run") } }
    const report = { ...fixture.report, receipts: [{ delivery: "reused" as const, receipt: olderReceipt }] }
    expect(validatePublication({ ...fixture, report })).toEqual([])
    expect(currentRunReceipts(report)).toEqual([])
    expect(validatePublication({ ...fixture, report: { ...report, receipts: [{ delivery: "performed", receipt: olderReceipt }] } }).some((issue) => issue.code === "scope")).toBe(true)
  })
})

describe("narrow product route boundaries", () => {
  it("accepts one upload metadata record and rejects client ownership", () => {
    expect(productRoutes.upload.multipartField).toBe("file")
    expect(productRoutes.upload.status).toBe(202)
    const metadata = { originalFilename: "normal.pdf", mediaType: "application/pdf", byteCount: 639 }
    expect(Schema.decodeUnknownSync(productRoutes.upload.metadata, boundaryParseOptions)(metadata)).toEqual(metadata)
    expect(() => Schema.decodeUnknownSync(productRoutes.upload.metadata, boundaryParseOptions)({ ...metadata, ownerId: "attacker" })).toThrow()
    expect(() => Schema.decodeUnknownSync(productRoutes.upload.metadata)([metadata, metadata])).toThrow()
  })

  it("scopes output actions to a revision and rejects filesystem selectors", () => {
    expect(productRoutes.text.path).toBe("/api/documents/:documentId/outputs/:revisionId/text")
    expect(productRoutes.status.method).toBe("GET")
    expect(productRoutes.image.binaryMediaTypes).toEqual(["image/png", "image/jpeg", "image/webp"])
    expect(() => Schema.decodeUnknownSync(productRoutes.image.params, boundaryParseOptions)({ documentId: "document-one", revisionId: "revision-one", path: "../secret" })).toThrow()
    expect(() => Schema.decodeUnknownSync(productRoutes.rate.request, boundaryParseOptions)({ value: "up", userId: "other-user" })).toThrow()
  })
})
