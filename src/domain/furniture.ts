import type { Extraction, PageFurniture, SourceBlock } from "./document.ts"
import type { PageId } from "./identity.ts"
import type { PageCheck } from "./processing.ts"

type Furniture = typeof PageFurniture.Type
export const furnitureLimits = { maxCharacters: 120, maxWords: 16, maxPerPage: 12, edgeFraction: 0.15, minRunningLetters: 3 } as const
const reclassifiable: ReadonlySet<SourceBlock["kind"]> = new Set(["paragraph", "heading", "note", "unclassified"])
const withoutMarks = (content: string) => content.normalize("NFKC").replace(/^#{1,6}\s+/u, "").trim()
const pageNumberPattern = /^(?:page\s+)?(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*(?:of|\/)\s*\d{1,4})?$/iu
export const isPageNumberText = (content: string): boolean => pageNumberPattern.test(withoutMarks(content).replace(/^[\s\-–—[(]+|[\s\-–—\])]+$/gu, ""))
export const runningText = (content: string): string => withoutMarks(content).toLowerCase().replace(/[^\p{L}]+/gu, " ").trim()
const onPage = (block: SourceBlock, pageId: PageId) => block.locations.some((location) => location.pageId === pageId)

const repeatsElsewhere = (extraction: Extraction, block: SourceBlock, pageId: PageId) => {
  const text = runningText(block.content)
  if (text.replace(/\s/gu, "").length < furnitureLimits.minRunningLetters) return false
  return extraction.sourceBlocks.some((other) => other.id !== block.id && !onPage(other, pageId) && runningText(other.content) === text)
}
const atEdge = (extraction: Extraction, block: SourceBlock, role: Furniture["role"]) => {
  const page = extraction.pages.find((item) => item.id === block.locations[0].pageId)
  return page !== undefined && block.locations.some((location) => location._tag === "box" && (role === "header"
    ? location.box.y + location.box.height <= page.height * furnitureLimits.edgeFraction
    : location.box.y >= page.height * (1 - furnitureLimits.edgeFraction)))
}

export const furnitureProblems = (extraction: Extraction, pageId: PageId, proposals: ReadonlyArray<Furniture>): ReadonlyArray<string> => {
  const existing = new Map((extraction.pageFurniture ?? []).map((item) => [item.blockId, item.role]))
  const furnitureIds = new Set([...existing.keys(), ...proposals.map((proposal) => proposal.blockId)])
  const pageBlocks = extraction.sourceBlocks.filter((block) => onPage(block, pageId))
  const fresh = proposals.filter((proposal) => existing.get(proposal.blockId) !== proposal.role)
  const problems: Array<string> = []
  if (fresh.length > furnitureLimits.maxPerPage) problems.push(`At most ${furnitureLimits.maxPerPage} furniture classifications are allowed on one page`)
  const seen = new Set<string>()
  for (const proposal of proposals) {
    const label = `Furniture for block ${proposal.blockId}`
    if (seen.has(proposal.blockId)) { problems.push(`${label}: the block is classified more than once`); continue }
    seen.add(proposal.blockId)
    const current = existing.get(proposal.blockId)
    if (current === proposal.role) continue
    if (current !== undefined) { problems.push(`${label}: the block is already ${current} furniture`); continue }
    const index = pageBlocks.findIndex((block) => block.id === proposal.blockId)
    const block = pageBlocks[index]
    if (block === undefined || block.locations.some((location) => location.pageId !== pageId)) { problems.push(`${label}: only a block on this page can become page furniture`); continue }
    if (!reclassifiable.has(block.kind)) { problems.push(`${label}: a ${block.kind} block cannot become page furniture`); continue }
    const text = withoutMarks(block.content)
    if (text === "" || text.length > furnitureLimits.maxCharacters || text.split(/\s+/u).length > furnitureLimits.maxWords) {
      problems.push(`${label}: page furniture must be a short line (at most ${furnitureLimits.maxCharacters} characters and ${furnitureLimits.maxWords} words), not prose`)
      continue
    }
    const pageNumber = isPageNumberText(block.content)
    if (proposal.role === "page_number" && !pageNumber) { problems.push(`${label}: a page_number must look like a page number`); continue }
    if (proposal.role !== "page_number" && !pageNumber && !repeatsElsewhere(extraction, block, pageId) && !atEdge(extraction, block, proposal.role)) {
      problems.push(`${label}: a ${proposal.role} must repeat on another page or be a page number`)
      continue
    }
    const leading = pageBlocks.slice(0, index).every((other) => furnitureIds.has(other.id))
    const trailing = pageBlocks.slice(index + 1).every((other) => furnitureIds.has(other.id))
    if (proposal.role === "header" ? !leading : proposal.role === "footer" ? !trailing : !leading && !trailing) {
      problems.push(`${label}: a ${proposal.role} must sit ${proposal.role === "header" ? "before" : proposal.role === "footer" ? "after" : "before or after"} all of this page's other content`)
    }
  }
  return problems
}

export const withFurniture = (extraction: Extraction, proposals: ReadonlyArray<Furniture>): Extraction => {
  const existing = new Set((extraction.pageFurniture ?? []).map((item) => item.blockId))
  const added: Array<Furniture> = []
  for (const proposal of proposals) if (!existing.has(proposal.blockId) && !added.some((item) => item.blockId === proposal.blockId)) added.push(proposal)
  if (added.length === 0) return extraction
  const ids = new Set(added.map((item) => item.blockId))
  return {
    ...extraction,
    sourceBlocks: extraction.sourceBlocks.map((block) => ids.has(block.id) ? { ...block, kind: "unclassified" } : block),
    pageFurniture: [...extraction.pageFurniture ?? [], ...added],
  }
}

export const checkedExtraction = (extraction: Extraction, checked: ReadonlyArray<{ readonly pageId: PageId; readonly result: PageCheck }>): Extraction => {
  const order = new Map(extraction.pages.map((page) => [page.id, page.pageNumber]))
  return checked.toSorted((left, right) => (order.get(left.pageId) ?? 0) - (order.get(right.pageId) ?? 0))
    .reduce((current, page) => withFurniture(current, page.result.furniture ?? []), extraction)
}

export const checkedFurniture = (extraction: Extraction, checked: ReadonlyArray<{ readonly pageId: PageId; readonly result: PageCheck }>): ReadonlyArray<Furniture> => {
  const original = new Set((extraction.pageFurniture ?? []).map((item) => item.blockId))
  return (checkedExtraction(extraction, checked).pageFurniture ?? []).filter((item) => !original.has(item.blockId))
}
