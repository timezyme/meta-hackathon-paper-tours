import type { CanonicalDocument } from "../../domain/index.ts"
import type { DocumentRecord } from "../documents.ts"
import { paperHeading } from "../guide/presentation.ts"

const processingNotConfigured = "Document processing is not configured. Uploads will open when the processing pipeline, provider access, and budget are ready."

export const uploadUnavailableMessage = (reason: string, hasPapers: boolean): string => {
  if (reason !== processingNotConfigured) return reason
  return hasPapers ? "You can still read and download your saved papers." : "This library isn’t accepting new PDFs yet."
}

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
