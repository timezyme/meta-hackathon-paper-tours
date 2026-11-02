import { Result } from "effect"
import type { BlockId, CanonicalDocument, ImageManifest, Issue, OutputScope, Page, ProcessingReport, SourceBlock } from "../../domain/index.ts"
import { executionFailure } from "../../processing/contracts.ts"
import { extractionFromCanonical, pageBlockId, type ValidatedPageExtraction } from "../extraction/page.ts"
import type { AssembledDocument } from "./assembly.ts"

const invalid = () => Result.fail(executionFailure("conflict", "The saved code classification cannot be repaired without changing source content"))
const changedEvidence = () => Result.fail(executionFailure("conflict", "Saved code differs from its original extraction response"))
const fencedCode = /^```[^\r\n]*\r?\n[\s\S]*\r?\n```\s*$/u

const isUnclassifiedIssueFor = (issue: Issue, id: BlockId) =>
  issue.code === "unclassified-content" && issue.stage === "extraction" && issue.blockIds.length === 1 && issue.blockIds[0] === id
const hasSingleWarning = (report: ProcessingReport, source: SourceBlock) => report.issues.some((issue) =>
  isUnclassifiedIssueFor(issue, source.id) && issue.figureId === null && JSON.stringify(issue.locations) === JSON.stringify(source.locations))
const repairable = (canonical: CanonicalDocument, report: ProcessingReport, id: BlockId) => {
  const source = canonical.sourceBlocks.find((block) => block.id === id)
  const block = canonical.blocks.find((candidate) => candidate.id === id)
  return source?.kind === "unclassified" && source.format === "markdown" && fencedCode.test(source.content)
    && block?.kind === "unclassified" && block.content === source.content && block.format === source.format
    && block.sourceBlockIds.length === 1 && block.sourceBlockIds[0] === id
    && canonical.pageFurniture?.some((item) => item.blockId === id) !== true
    && hasSingleWarning(report, source)
}

export const savedCodeBlockIds = (canonical: CanonicalDocument, page: Page, extraction: ValidatedPageExtraction) => {
  const ids: Array<BlockId> = []
  for (const [index, block] of extraction.blocks.entries()) {
    if (block.kind !== "code" || block.furniture !== null) continue
    const source = canonical.sourceBlocks.find((candidate) => candidate.id === pageBlockId(page.pageNumber, index))
    if (source?.kind !== "unclassified") continue
    const onlyOnPage = source.locations.length === 1 && source.locations[0].pageId === page.id
    if (source.content !== block.content || source.format !== block.format || !onlyOnPage) return changedEvidence()
    ids.push(source.id)
  }
  return Result.succeed(ids)
}

export const reclassifyCode = (
  canonical: CanonicalDocument, images: ImageManifest, report: ProcessingReport, scope: OutputScope, ids: ReadonlyArray<BlockId>,
) => {
  const [first, ...rest] = ids
  const unique = new Set(ids).size === ids.length
  if (first === undefined || !unique || scope.revisionId === canonical.scope.revisionId || report.codeClassificationRepair !== undefined) return invalid()
  if (!ids.every((id) => repairable(canonical, report, id))) return invalid()
  const sourceBlocks = canonical.sourceBlocks.map((block) => ids.includes(block.id) ? { ...block, kind: "code" as const } : block)
  const blocks = canonical.blocks.map((block) => ids.includes(block.id) ? { ...block, kind: "code" as const } : block)
  const issues = report.issues.filter((issue) => !ids.some((id) => isUnclassifiedIssueFor(issue, id)))
  const extractionIssues = issues.some((issue) => issue.stage === "extraction")
  const repaired: AssembledDocument = {
    extraction: { ...extractionFromCanonical(canonical, scope.documentId, scope.runId), sourceBlocks },
    canonical: { ...canonical, scope, sourceBlocks, blocks },
    images: { ...images, scope },
    report: {
      ...report, scope, issues,
      codeClassificationRepair: { previousRevisionId: canonical.scope.revisionId, blockIds: [first, ...rest] },
      changes: { ...report.changes, changedBlockIds: [...new Set([...report.changes.changedBlockIds, ...ids])] },
      checks: report.checks.map((check) => check.stage === "extraction" ? { ...check, result: extractionIssues ? "issues" : "passed" } : check),
      receipts: report.receipts.map(({ receipt }) => ({ receipt, delivery: "reused" as const })),
    },
  }
  return Result.succeed(repaired)
}
