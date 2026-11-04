import type { Extraction, SourceBlock } from "./document.ts"

export const canJoinSources = (extraction: Extraction, first: SourceBlock, second: SourceBlock): boolean => {
  if (first.readingOrder >= second.readingOrder) return false
  const before = first.locations[0]
  const after = second.locations[0]
  if (first.locations.some((location) => location.pageId !== before.pageId) || second.locations.some((location) => location.pageId !== after.pageId) || after.pageNumber < before.pageNumber || after.pageNumber > before.pageNumber + 1) return false
  if (first.readingOrder + 1 === second.readingOrder) return true
  if (after.pageNumber !== before.pageNumber + 1) return false
  const furniture = new Map((extraction.pageFurniture ?? []).map((item) => [item.blockId, item.role]))
  const between = extraction.sourceBlocks.slice(first.readingOrder + 1, second.readingOrder)
  return between.length > 0 && between.every((block) => {
    const role = furniture.get(block.id)
    return block.kind === "unclassified" && ((role === "footer" || role === "page_number") && block.locations.every((location) => location.pageId === before.pageId) || (role === "header" || role === "page_number") && block.locations.every((location) => location.pageId === after.pageId))
  })
}
