import type { CanonicalDocument, UploadPolicy, UploadUnavailable } from "../../domain/index.ts"
import { formatBytes, type DocumentRecord } from "../documents.ts"
import { paperHeading } from "../guide/presentation.ts"

export const uploadUnavailableMessage = ({ code, reason }: UploadUnavailable, hasPapers: boolean): string => {
  if (code !== "processing-not-configured") return reason
  return hasPapers ? "You can still read and download your saved documents." : "This library isn’t accepting new PDFs yet."
}

export const uploadLimits = ({ maxBytes, maxPages }: Pick<UploadPolicy, "maxBytes" | "maxPages">): string =>
  `Drop one English-language PDF here, up to ${formatBytes(maxBytes)} and ${maxPages} pages.`
  + " Short documents work best and usually take several minutes."

export type CoverLoad =
  | { readonly _tag: "loading" | "retrying"; readonly attempt: number }
  | { readonly _tag: "unavailable" }
const coverAttempts = 2
export const coverRetryDelay = "2 seconds"
export const firstCoverLoad: CoverLoad = { _tag: "loading", attempt: 1 }
export const coverFailed = (load: CoverLoad): CoverLoad => load._tag === "loading" && load.attempt < coverAttempts
  ? { _tag: "retrying", attempt: load.attempt }
  : { _tag: "unavailable" }
export const coverRetried = (load: CoverLoad): CoverLoad =>
  load._tag === "retrying" ? { _tag: "loading", attempt: load.attempt + 1 } : load

export const featuredPaper = (records: ReadonlyArray<DocumentRecord>): DocumentRecord | undefined =>
  records.find((record) => {
    const state = record.latestRun.state
    return (state._tag === "succeeded" || state._tag === "succeeded-with-issues") &&
      state.revisionId === record.currentRevisionId && record.latestRun.configuration.guide !== undefined
  }) ?? records.find((record) => record.currentRevisionId !== null)

const overviewTeaser = (text: string): string => {
  const sentences = new Intl.Segmenter("en", { granularity: "sentence" }).segment(text.trim())[Symbol.iterator]()
  const first: string = sentences.next().value?.segment.trim() ?? ""
  const second: string = sentences.next().value?.segment.trim() ?? ""
  const pair = `${first} ${second}`.trim()
  if (pair.split(/\s+/u).length <= 30) return pair
  const words = first.split(/\s+/u)
  return words.length <= 40 ? first : `${words.slice(0, 40).join(" ").replace(/[,;:–—-]+$/u, "")}…`
}

export const paperPreview = (canonical: CanonicalDocument) => {
  const guide = canonical.guide
  return {
    title: paperHeading(canonical) ?? guide?.title,
    guide: guide === undefined ? null : {
      steps: guide.steps.length,
      claims: guide.claims.length,
      excerpt: overviewTeaser(guide.overview.text),
    },
  }
}
