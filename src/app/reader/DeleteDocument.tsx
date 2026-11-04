import { useEffect, useRef, useState } from "react"
import type { DocumentRecord } from "../documents.ts"
import { activeRun } from "../documents.ts"
import { runDocument } from "../client/documents.ts"
import { deleteDocument } from "../client/outputs.ts"
import { ReaderDrawer } from "./Panels.tsx"

export function DeleteDocumentControl({ record, onDeleted, onUnauthenticated }: { readonly record: DocumentRecord; readonly onDeleted: () => void; readonly onUnauthenticated: () => void }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<{ readonly kind: "idle" | "pending" | "failed"; readonly message: string | null }>({ kind: "idle", message: null })
  const inFlight = useRef(false)
  const cancel = useRef<(() => void) | undefined>(undefined)
  const permitted = !activeRun(record.latestRun)
  useEffect(() => () => cancel.current?.(), [])
  const confirm = () => {
    if (!permitted || inFlight.current || state.kind !== "idle") return
    inFlight.current = true
    setState({ kind: "pending", message: null })
    cancel.current = runDocument(deleteDocument(record.document.id), () => { inFlight.current = false; setOpen(false); onDeleted() }, (error) => {
      inFlight.current = false
      setState({ kind: "failed", message: error.message })
      if (error.kind === "unauthenticated") onUnauthenticated()
    })
  }
  return <div className="reader-delete"><button className="reader-text-link" type="button" disabled={!permitted || state.kind === "pending"} onClick={() => setOpen(true)}>Delete document</button>{!permitted && <span className="reader-small">Available when processing has stopped.</span>}{open && <ReaderDrawer title="Delete this document?" side="output" busy={state.kind === "pending"} onClose={() => setOpen(false)}><div className="delete-confirmation"><p><strong>{record.document.originalFilename}</strong></p><p>This removes the uploaded PDF, normalized text, images, saved outputs, and rating from your workspace. It cannot be undone.</p>{state.kind === "failed" ? <div className="message error" role="alert"><p>{state.message}</p><p>Deletion was not confirmed. Check your library before taking another action; the document may already have been removed.</p></div> : <button className="button delete-confirm-button" type="button" disabled={!permitted || state.kind === "pending"} onClick={confirm}>{state.kind === "pending" ? "Deleting…" : "Permanently delete"}</button>}{state.kind === "pending" && <p className="reader-small" role="status">Deleting this document. Please wait.</p>}</div></ReaderDrawer>}</div>
}
