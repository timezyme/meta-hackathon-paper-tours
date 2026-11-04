import { useEffect, useRef, useState } from "react"
import { Effect } from "effect"
import type { DocumentRecord } from "../documents.ts"
import { retryEligibility } from "../documents.ts"
import { DocumentFailure, retryDocument, runDocument } from "../client/documents.ts"
import { prepareRetryAttempt, readRetryAttempt, type RetryAttempt } from "../client/retries.ts"
import { ReaderDrawer } from "./Panels.tsx"

export function RetryDocumentControl({ record, onRefresh, onUnauthenticated }: { readonly record: DocumentRecord; readonly onRefresh: () => void; readonly onUnauthenticated: () => void }) {
  const eligibility = retryEligibility(record.latestRun)
  return eligibility === "unavailable" ? null : <RetryConfirmation key={record.latestRun.id} record={record} unknownCompletion={eligibility === "unknown-completion"} onRefresh={onRefresh} onUnauthenticated={onUnauthenticated} />
}

function RetryConfirmation({ record, unknownCompletion, onRefresh, onUnauthenticated }: { readonly record: DocumentRecord; readonly unknownCompletion: boolean; readonly onRefresh: () => void; readonly onUnauthenticated: () => void }) {
  const [open, setOpen] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [saved, setSaved] = useState<{ readonly loading: boolean; readonly attempt: RetryAttempt | null; readonly error: string | null }>({ loading: true, attempt: null, error: null })
  const [submission, setSubmission] = useState<{ readonly kind: "idle" | "pending" | "uncertain" | "rejected" | "accepted"; readonly message: string | null }>({ kind: "idle", message: null })
  const inFlight = useRef(false)
  const cancel = useRef<(() => void) | undefined>(undefined)
  const identity = { ownerId: record.document.ownerId, documentId: record.document.id, previousRunId: record.latestRun.id }
  useEffect(() => runDocument(readRetryAttempt({ ownerId: record.document.ownerId, documentId: record.document.id, previousRunId: record.latestRun.id }), (attempt) => setSaved({ loading: false, attempt, error: null }), (error) => setSaved({ loading: false, attempt: null, error: error.message })), [record.document.ownerId, record.document.id, record.latestRun.id])
  useEffect(() => () => cancel.current?.(), [])
  const pending = submission.kind === "pending"
  const enabled = !saved.loading && saved.error === null && !pending && submission.kind !== "accepted"
  const submit = () => {
    if (!enabled || inFlight.current || (unknownCompletion && !acknowledged)) return
    inFlight.current = true
    setSubmission({ kind: "pending", message: null })
    cancel.current = runDocument(Effect.gen(function* () {
      const attempt = yield* prepareRetryAttempt(identity, unknownCompletion && acknowledged)
      yield* Effect.sync(() => setSaved({ loading: false, attempt, error: null }))
      if (unknownCompletion && !attempt.request.acknowledgePossibleRepeatedWork) return yield* new DocumentFailure({ kind: "rejected", message: "The previous retry request has a different acknowledgment. Check the current document status before continuing." })
      return yield* retryDocument(identity.documentId, attempt.request, attempt.key)
    }), () => {
      inFlight.current = false
      setSubmission({ kind: "accepted", message: "Retry accepted. Updating the document status…" })
      setOpen(false)
      onRefresh()
    }, (error) => {
      inFlight.current = false
      setSubmission({ kind: error.kind === "rejected" && (error.status ?? 400) < 500 ? "rejected" : "uncertain", message: error.message })
      if (error.kind === "unauthenticated") onUnauthenticated()
    })
  }
  return <div className="reader-retry"><button className="button" type="button" disabled={!enabled} onClick={() => setOpen(true)}>Retry processing</button>
    {saved.error !== null && <p className="message error" role="alert">{saved.error}</p>}
    {saved.attempt !== null && submission.kind !== "accepted" && <p className="reader-small">A previous retry request is saved in this tab. Check the current status; sending it again uses the same request.</p>}
    {submission.kind === "accepted" && <p role="status" className="reader-small">{submission.message}</p>}
    {open && <ReaderDrawer title="Retry processing?" side="output" busy={pending} onClose={() => setOpen(false)}><div className="retry-confirmation"><p><strong>{record.document.originalFilename}</strong></p><p>AmuseMe will check saved work and start a new run where needed. Your original document{record.currentRevisionId === null ? " stays available" : " and saved output stay available"}.</p>
      {unknownCompletion && <><p className="message error">The provider may have completed work before the connection was lost. Retrying can repeat that work and incur additional processing cost.</p><label className="retry-acknowledgment"><input type="checkbox" checked={acknowledged} disabled={pending} onChange={(event) => setAcknowledged(event.currentTarget.checked)} /><span>I understand that work and processing cost may be repeated.</span></label></>}
      {submission.message !== null && submission.kind !== "accepted" && <div className="message error" role="alert"><p>{submission.message}</p>{submission.kind === "uncertain" && <p>The retry may already be queued. Check the current status, or explicitly send the same saved request again.</p>}</div>}
      <div className="document-actions"><button className="button primary" type="button" disabled={!enabled || (unknownCompletion && !acknowledged)} onClick={submit}>{pending ? "Requesting retry…" : saved.attempt === null ? "Start retry" : "Send same retry request"}</button><button className="button" type="button" disabled={pending} onClick={() => { setOpen(false); onRefresh() }}>Check current status</button></div>
      {pending && <p className="reader-small" role="status">Requesting a retry. Please wait.</p>}
    </div></ReaderDrawer>}
  </div>
}
