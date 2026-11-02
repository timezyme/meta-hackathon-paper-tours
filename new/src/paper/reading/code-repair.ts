import { Result } from "effect"
import { type BlockId, type CanonicalDocument, type ImageManifest, type OutputScope, type ProcessingReport } from "../../domain/index.ts"
import { executionFailure } from "../../processing/contracts.ts"
import type { AssembledDocument } from "./assembly.ts"

const invalid = () => Result.fail(executionFailure("conflict", "The saved code classification cannot be repaired without changing source content"))

export const reclassifyCode = (canonical: CanonicalDocument, images: ImageManifest, report: ProcessingReport, scope: OutputScope, ids: ReadonlyArray<BlockId>) => {
  if (ids.length === 0 || new Set(ids).size !== ids.length || scope.revisionId === canonical.scope.revisionId || report.codeClassificationRepair !== undefined) return invalid()
  for (const id of ids) {
    const source = canonical.sourceBlocks.find((block) => block.id === id)
    const block = canonical.blocks.find((candidate) => candidate.id === id)
    if (source?.kind !== "unclassified" || source.format !== "markdown" || !/^```[^\r\n]*\r?\n[\s\S]*\r?\n```\s*$/u.test(source.content)
      || block?.kind !== "unclassified" || block.content !== source.content || block.format !== source.format || block.sourceBlockIds.length !== 1 || block.sourceBlockIds[0] !== id
      || canonical.pageFurniture?.some((item) => item.blockId === id)
      || !report.issues.some((issue) => issue.code === "unclassified-content" && issue.stage === "extraction" && issue.blockIds.length === 1 && issue.blockIds[0] === id && issue.figureId === null && JSON.stringify(issue.locations) === JSON.stringify(source.locations))) return invalid()
  }
  const sourceBlocks = canonical.sourceBlocks.map((block) => ids.includes(block.id) ? { ...block, kind: "code" as const } : block)
  const blocks = canonical.blocks.map((block) => ids.includes(block.id) ? { ...block, kind: "code" as const } : block)
  const issues = report.issues.filter((issue) => !(issue.code === "unclassified-content" && issue.stage === "extraction" && issue.blockIds.length === 1 && ids.includes(issue.blockIds[0]!)))
  const repaired: AssembledDocument = {
    extraction: { schemaVersion: "1", scope: { documentId: scope.documentId, runId: scope.runId, sourceHash: canonical.sourceHash }, pages: canonical.pages, sourceBlocks, figures: canonical.figures, ...(canonical.pageFurniture === undefined ? {} : { pageFurniture: canonical.pageFurniture }) },
    canonical: { ...canonical, scope, sourceBlocks, blocks },
    images: { ...images, scope },
    report: { ...report, scope, issues, codeClassificationRepair: { previousRevisionId: canonical.scope.revisionId, blockIds: [ids[0]!, ...ids.slice(1)] },
      changes: { ...report.changes, changedBlockIds: [...new Set([...report.changes.changedBlockIds, ...ids])] },
      checks: report.checks.map((check) => check.stage === "extraction" ? { ...check, result: issues.some((issue) => issue.stage === "extraction") ? "issues" : "passed" } : check),
      receipts: report.receipts.map(({ receipt }) => ({ receipt, delivery: "reused" as const })),
    },
  }
  return Result.succeed(repaired)
}
