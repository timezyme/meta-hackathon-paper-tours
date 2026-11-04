import type { Block, CanonicalDocument, Page, StageReceipt } from "../../domain/index.ts"

import { parseLocation } from "../navigation.ts"

export const pageFromLocation = (location: string, pages: ReadonlyArray<Pick<Page, "pageNumber">>): number =>
  boundedPage(parseLocation(location).page, pages)

export const boundedPage = (value: number, pages: ReadonlyArray<Pick<Page, "pageNumber">>): number => {
  const first = pages[0]?.pageNumber ?? 1
  const last = pages.at(-1)?.pageNumber ?? first
  return pages.find((page) => page.pageNumber >= Math.max(first, Math.min(last, value)))?.pageNumber ?? first
}
export const blockPage = (block: Block): number => block.locations[0].pageNumber
export const blocksOnPage = (document: CanonicalDocument, page: number): ReadonlyArray<Block> => document.blocks.filter((block) => blockPage(block) === page)
export const continuationsOnPage = (document: CanonicalDocument, page: number): ReadonlyArray<Block> =>
  document.blocks.filter((block) => blockPage(block) !== page && block.locations.some((location) => location.pageNumber === page))
export const receiptOutcome = (receipt: StageReceipt): string => {
  const state = receipt.state
  if (state._tag === "completed") return state.validation._tag === "accepted" ? "Validated" : "Rejected"
  return state._tag === "unknown-completion" ? "Completion unknown" : state._tag
}
export const safeDocumentHref = (url: string): string | undefined => /^(?:https?:\/\/|mailto:|#[A-Za-z0-9_-])/iu.test(url) ? url : undefined
