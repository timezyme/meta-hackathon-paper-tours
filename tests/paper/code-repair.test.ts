import { describe, expect, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { BlockId, CanonicalDocument, OutputRevisionId, RunId } from "../../src/domain/index.ts"
import { reclassifyCode } from "../../src/paper/reading/code-repair.ts"
import { codeIds, codeRepairFixture, firstCode, secondCode, unknownId } from "../fixtures/code-repair.ts"

describe("classification-only code repair", () => {
  it("changes only the proven code kinds and matching warnings while retaining unknown content and guide evidence", () => {
    const fixture = codeRepairFixture()
    const before = JSON.stringify(fixture)
    const scope = { ...fixture.canonical.scope, runId: RunId.make("local-repair"), revisionId: OutputRevisionId.make("repaired-output") }
    const result = reclassifyCode(fixture.canonical, fixture.images, fixture.report, scope, codeIds)
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) return
    const repaired = result.success
    expect(repaired.canonical.sourceBlocks.map((block) => block.kind)).toEqual(["code", "unclassified", "code", "paragraph", "figure", "caption"])
    expect(repaired.canonical.blocks.map((block) => block.kind)).toEqual(["code", "unclassified", "code", "paragraph", "figure", "caption"])
    for (const [index, source] of repaired.canonical.sourceBlocks.entries()) {
      expect({ ...source, kind: fixture.canonical.sourceBlocks[index]!.kind }).toEqual(fixture.canonical.sourceBlocks[index])
      expect({ ...repaired.canonical.blocks[index], kind: fixture.canonical.blocks[index]!.kind }).toEqual(fixture.canonical.blocks[index])
    }
    expect(repaired.canonical.sourceBlocks[0]!.content).toBe(firstCode)
    expect(repaired.canonical.sourceBlocks[2]!.content).toBe(secondCode)
    expect(repaired.canonical.guide).toEqual(fixture.canonical.guide)
    expect(repaired.canonical.figures).toEqual(fixture.canonical.figures)
    expect(repaired.canonical.pages).toEqual(fixture.canonical.pages)
    expect(repaired.images.figures).toEqual(fixture.images.figures)
    expect(repaired.report.issues).toEqual([fixture.report.issues[1], fixture.report.issues[3]])
    expect(repaired.report.issues[0]!.blockIds).toEqual([unknownId])
    expect(repaired.report.checks.find((check) => check.stage === "extraction")?.result).toBe("issues")
    expect(repaired.report.codeClassificationRepair).toEqual({ previousRevisionId: fixture.canonical.scope.revisionId, blockIds: codeIds })
    expect(repaired.report.changes.changedBlockIds).toEqual(codeIds)
    expect(repaired.report.receipts.map(({ receipt }) => receipt)).toEqual(fixture.report.receipts.map(({ receipt }) => receipt))
    expect(repaired.report.receipts.every(({ delivery }) => delivery === "reused")).toBe(true)
    expect(JSON.stringify(fixture)).toBe(before)
  })

  it("refuses edited text, non-code content, furniture, missing warnings and ambiguous repair requests", () => {
    const fixture = codeRepairFixture()
    const scope = { ...fixture.canonical.scope, runId: RunId.make("local-repair"), revisionId: OutputRevisionId.make("repaired-output") }
    const changedText = Schema.decodeUnknownSync(CanonicalDocument)({ ...fixture.canonical, blocks: fixture.canonical.blocks.map((block) => block.id === codeIds[0] ? { ...block, content: "```python\nprint(13)\n```" } : block) })
    const furniture = Schema.decodeUnknownSync(CanonicalDocument)({ ...fixture.canonical, pageFurniture: [{ blockId: codeIds[0], role: "page_number" }] })
    for (const canonical of [changedText, furniture]) expect(Result.isFailure(reclassifyCode(canonical, fixture.images, fixture.report, scope, codeIds))).toBe(true)
    for (const ids of [[], [codeIds[0], codeIds[0]], [BlockId.make("missing")], [unknownId]]) expect(Result.isFailure(reclassifyCode(fixture.canonical, fixture.images, fixture.report, scope, ids))).toBe(true)
    const noWarning = { ...fixture.report, issues: fixture.report.issues.filter((issue) => !issue.blockIds.includes(codeIds[0])) }
    expect(Result.isFailure(reclassifyCode(fixture.canonical, fixture.images, noWarning, scope, codeIds))).toBe(true)
    expect(Result.isFailure(reclassifyCode(fixture.canonical, fixture.images, fixture.report, fixture.canonical.scope, codeIds))).toBe(true)
    const alreadyRepaired = { ...fixture.report, codeClassificationRepair: { previousRevisionId: OutputRevisionId.make("earlier"), blockIds: codeIds } }
    expect(Result.isFailure(reclassifyCode(fixture.canonical, fixture.images, alreadyRepaired, scope, codeIds))).toBe(true)
  })
})
