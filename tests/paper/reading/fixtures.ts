import { Crypto, Effect, FileSystem, Schema } from "effect"
import { ArtifactHash, CheckedPage, Extraction, ImageArtifact, ProviderAttemptId, Run, StageReceipt, type Document, type PageCheck, type SourceBlock } from "../../../src/domain/index.ts"
import { applyPageChecks, previousPageContext } from "../../../src/paper/correction/index.ts"
import { applyHeadingDecisions } from "../../../src/paper/headings/index.ts"
import type { AssembleDocumentInput } from "../../../src/paper/reading/index.ts"
import { contractFixture, fixtureTime } from "../../fixtures/contracts.ts"

export const prepareReading = Effect.fnUntraced(function* (base: { document: Document; run: Run; extraction: Extraction } = contractFixture(), results: ReadonlyArray<PageCheck> = []) {
  const receiptTemplate = contractFixture().report.receipts[0]?.receipt
  if (receiptTemplate === undefined) return yield* Effect.die("Missing test receipt")
  const run: Run = { ...base.run, state: { _tag: "running", startedAt: fixtureTime, progress: { stage: "assembly", completedUnits: 0, totalUnits: null } } }
  const receipts: Array<StageReceipt> = []
  const checked: Array<CheckedPage> = []
  for (const [index, page] of base.extraction.pages.entries()) {
    const receipt: StageReceipt = { ...receiptTemplate, id: ProviderAttemptId.make(`check-${page.id}`), ownerId: base.document.ownerId, scope: base.extraction.scope, pageIds: [page.id] }
    receipts.push(receipt)
    checked.push({ scope: base.extraction.scope, pageId: page.id, previousContextIds: previousPageContext(base.extraction, page.id).map((block) => block.id), result: results[index] ?? { fixes: [], joins: [] }, providerAttemptId: receipt.id })
  }
  const corrected = yield* Effect.fromResult(applyPageChecks(base.extraction, checked))
  const headings = yield* Effect.fromResult(applyHeadingDecisions(base.extraction, corrected, { headings: corrected.blocks.filter((block) => block.kind === "paragraph" || block.kind === "heading").map((block) => ({ blockId: block.id, level: block.kind === "heading" ? block === corrected.blocks.find((item) => item.kind === "heading") ? 1 : 2 : null })) }))
  const input: AssembleDocumentInput = { document: base.document, run, revisionId: contractFixture().canonical.scope.revisionId, extraction: base.extraction, corrected, headings, figures: base.extraction.figures, issues: [], receiptUses: receipts.map((receipt) => ({ receipt, delivery: "performed" })) }
  return input
})

export const imageFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const crypto = yield* Crypto.Crypto
  const bytes = yield* fs.readFile(new URL("../../fixtures/seaborn-figure.jpg", import.meta.url).pathname)
  const hash = yield* crypto.digest("SHA-256", bytes).pipe(Effect.map((value) => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")), Effect.flatMap(Schema.decodeUnknownEffect(ArtifactHash)))
  const artifact = yield* Schema.decodeUnknownEffect(ImageArtifact)({ path: "images/native.jpeg", mediaType: "image/jpeg", byteCount: bytes.byteLength, hash })
  const base = contractFixture("missing-description")
  const extraction = { ...base.extraction, figures: base.extraction.figures.map((figure) => ({ ...figure, asset: { _tag: "available" as const, artifact } })) }
  return { input: yield* prepareReading({ ...base, extraction }), asset: { artifact, bytes } }
})

export const completeFixture = Effect.gen(function* () {
  const base = contractFixture()
  const first = base.extraction.pages[0]
  const pages = yield* Schema.decodeUnknownEffect(Extraction.fields.pages)(Array.from({ length: 3 }, (_, index) => ({ ...first, id: `page-${index + 1}`, pageNumber: index + 1, image: { ...first.image, path: `pages/page-${index + 1}.png` } })))
  const rows = [
    ["heading", "# Test paper", "markdown", 1], ["paragraph", "micr0-", "text", 1], ["heading", "# scope retains the measured value.", "markdown", 2],
    ["table", '<table>\n  <tr><td rowspan="2">α &amp; β</td><td>12</td></tr>\n</table>', "html", 2],
    ["equation", "E = mc^2\n\\frac{α}{β} = 0.5", "latex", 2], ["list", "- First\n  - Nested second", "markdown", 2],
    ["note", "Substantive side note: confidence is limited.", "text", 2], ["reference", "[1] Example Author. Full bibliography entry.", "text", 2],
    ["unclassified", '{"futureKind":"retain","value":"source detail"}', "text", 2],
  ] as const
  const sourceBlocks = yield* Schema.decodeUnknownEffect(Extraction.fields.sourceBlocks)(rows.map(([kind, content, format, number], index) => ({ id: `block-${index + 1}`, kind, readingOrder: index, content, format, locations: [{ _tag: "page", pageId: `page-${number}`, pageNumber: number }] })))
  const extraction: Extraction = { ...base.extraction, pages, sourceBlocks }
  const before = yield* prepareReading({ ...base, document: { ...base.document, pageCount: 3 }, extraction })
  const firstProse = sourceBlocks[1]
  const nextProse = sourceBlocks[2]
  if (firstProse === undefined || nextProse === undefined) return yield* Effect.die("Missing joined prose fixture")
  const corrected = yield* Effect.fromResult(applyPageChecks(extraction, before.corrected.checkedPages.map((page) => ({ ...page, result: page.pageId === pages[0].id ? { fixes: [{ blockId: firstProse.id, content: "micro-" }], joins: [] } : page.pageId === pages[1]?.id ? { fixes: [], joins: [{ firstBlockId: firstProse.id, secondBlockId: nextProse.id, answer: "word" as const }] } : page.result }))))
  const headings = yield* Effect.fromResult(applyHeadingDecisions(extraction, corrected, { headings: corrected.blocks.filter((block: SourceBlock) => block.kind === "heading" || block.kind === "paragraph").map((block) => ({ blockId: block.id, level: block.id === sourceBlocks[0]?.id ? 1 : null })) }))
  return { ...before, corrected, headings }
})
