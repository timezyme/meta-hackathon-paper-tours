import { useEffect, useState } from "react"
import { runDocument } from "../client/documents.ts"
import { documentFailureDetails, type DocumentReadFailure } from "../client/http.ts"
import { readOutputs, type OutputData, type OutputIdentity } from "../client/outputs.ts"
import type { Rating } from "./useReaderActions.ts"

type Snapshot = { readonly version: number; readonly data: OutputData | null; readonly error: DocumentReadFailure | null }

export const useReaderOutput = ({ documentId, revisionId }: OutputIdentity, onUnauthenticated: () => void, onRating: (rating: Rating | null) => void) => {
  const [version, setVersion] = useState(0)
  const [snapshot, setSnapshot] = useState<Snapshot>({ version: 0, data: null, error: null })
  useEffect(() => runDocument(readOutputs({ documentId, revisionId }), (output) => {
    setSnapshot({ version, data: output, error: null })
    onRating(output.rating)
  }, (error) => {
    if (error.kind === "unauthenticated") onUnauthenticated()
    else setSnapshot({ version, data: null, error: documentFailureDetails(error) })
  }), [documentId, revisionId, version, onUnauthenticated, onRating])
  const data = snapshot.version === version ? snapshot.data : null
  const loaded = snapshot.version === version && (data !== null || snapshot.error !== null)
  const retry = () => { setSnapshot({ version: version + 1, data: null, error: null }); setVersion((value) => value + 1) }
  return { data, error: snapshot.error, loaded, retry }
}
