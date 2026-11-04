import { useEffect, useState } from "react"
import type { DocumentId, OutputRevisionId } from "../../domain/index.ts"
import { runDocument } from "../client/documents.ts"
import { readPublishedDocument } from "../client/outputs.ts"
import { paperPreview } from "./presentation.ts"

export type PaperPreview = ReturnType<typeof paperPreview>
type Loaded = { readonly content: PaperPreview | null; readonly error: string | null }

export const usePaperPreview = (documentId: DocumentId, revisionId: OutputRevisionId, onUnauthenticated: () => void): Loaded => {
  const [loaded, setLoaded] = useState<Loaded>({ content: null, error: null })
  useEffect(() => runDocument(readPublishedDocument({ documentId, revisionId }),
    (output) => setLoaded({ content: paperPreview(output.canonical), error: null }),
    (failure) => {
      if (failure.kind === "unauthenticated") onUnauthenticated()
      else setLoaded({ content: null, error: failure.message })
    }), [documentId, revisionId, onUnauthenticated])
  return loaded
}
