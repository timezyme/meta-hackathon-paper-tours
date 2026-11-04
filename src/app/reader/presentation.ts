import type { Block, CanonicalDocument, Page, StageReceipt } from "../../domain/index.ts"

export const pageFromLocation = (location: string, pages: ReadonlyArray<Page>): number => {
  const raw = new URLSearchParams(location.split("?")[1] ?? "").get("p")
  const value = raw !== null && /^\d+$/u.test(raw) ? Number(raw) : 1
  const first = pages[0]?.pageNumber ?? 1
  const last = pages.at(-1)?.pageNumber ?? first
  return pages.find((page) => page.pageNumber >= Math.max(first, Math.min(last, value)))?.pageNumber ?? first
}
export const pageLocation = (documentId: string, page: number): string => `/documents/${encodeURIComponent(documentId)}?p=${page}`
export const blockPage = (block: Block): number => block.locations[0].pageNumber
export const blocksOnPage = (document: CanonicalDocument, page: number): ReadonlyArray<Block> => document.blocks.filter((block) => blockPage(block) === page)
export const continuationsOnPage = (document: CanonicalDocument, page: number): ReadonlyArray<Block> => document.blocks.filter((block) => blockPage(block) !== page && block.locations.some((location) => location.pageNumber === page))
export const stageNames = { extraction: "Extract document", "page-check": "Check pages", headings: "Restore headings", figures: "Describe figures", assembly: "Assemble document", export: "Prepare downloads" } as const
export const receiptOutcome = (receipt: StageReceipt): string => receipt.state._tag === "completed" ? receipt.state.validation._tag === "accepted" ? "Validated" : "Rejected" : receipt.state._tag === "unknown-completion" ? "Completion unknown" : receipt.state._tag
export const safeDocumentHref = (url: string): string | undefined => /^(?:https?:\/\/|mailto:|#[A-Za-z0-9_-])/iu.test(url) ? url : undefined
