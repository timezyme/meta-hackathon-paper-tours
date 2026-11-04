import { useEffect, useRef, useState } from "react"
import type { Dispatch, MouseEvent, SetStateAction } from "react"
import { Effect } from "effect"
import type { DocumentId, DocumentList } from "../domain/index.ts"
import { newSubmissionKey, runDocument, uploadDocument, watchDocument, watchDocuments } from "./client/documents.ts"
import { outputUrl } from "./client/outputs.ts"
import { navigate } from "./client/browser.ts"
import { formatBytes, formatExpiry, runSummary, validateSelection } from "./documents.ts"
import type { DocumentRecord, UploadAttempt } from "./documents.ts"
import { ReaderWorkspace } from "./reader/ReaderWorkspace.tsx"
import { DeleteDocumentControl } from "./reader/DeleteDocument.tsx"
import { RetryDocumentControl } from "./reader/RetryDocument.tsx"

const openInternal = (event: MouseEvent<HTMLAnchorElement>, path: string) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  navigate(path)
}

function DocumentIcon() {
  return <svg viewBox="0 0 32 34" aria-hidden="true"><path d="M8 30V4h12l6 6v20Z M20 4v7h6 M16 25V15m-4 4 4-4 4 4" /></svg>
}

function DocumentCard({ record, retryEnabled, onDeleted, onRefresh, onUnauthenticated }: { readonly record: DocumentRecord; readonly retryEnabled: boolean; readonly onDeleted: () => void; readonly onRefresh: () => void; readonly onUnauthenticated: () => void }) {
  const summary = runSummary(record.latestRun)
  const path = `/documents/${record.document.id}`
  return <article className="document-card">
    <div className="document-heading"><div className="upload-symbol"><DocumentIcon /></div><div><h3>{record.document.originalFilename}</h3><p>{record.document.pageCount} {record.document.pageCount === 1 ? "page" : "pages"} · {formatBytes(record.document.byteCount)} · PDF</p></div><span className={`document-status${summary.failed ? " failed" : ""}`}>{summary.title}</span></div>
    <p className="document-description">{record.currentRevisionId === null ? summary.description : summary.failed ? `${summary.description} Your previous saved output is still available.` : "Read your saved normalized document or download its text and images."}</p>
    <div className="document-actions"><a className="button" href={path} onClick={(event) => openInternal(event, path)}>Open document</a>{record.currentRevisionId !== null && <a className="text-button" href={outputUrl({ documentId: record.document.id, revisionId: record.currentRevisionId }, "text")} download="normalized.txt" aria-label={`Download text for ${record.document.originalFilename}`}>Download text</a>}<span>Available until {formatExpiry(record.document.expiresAt)}</span></div>
    {retryEnabled && <RetryDocumentControl record={record} onRefresh={onRefresh} onUnauthenticated={onUnauthenticated} />}<DeleteDocumentControl record={record} onDeleted={onDeleted} onUnauthenticated={onUnauthenticated} />
  </article>
}

export function Dashboard({ ownerId, storedAttempt, setAttempt, onUnauthenticated }: { readonly ownerId: string; readonly storedAttempt: UploadAttempt | null; readonly setAttempt: Dispatch<SetStateAction<UploadAttempt | null>>; readonly onUnauthenticated: () => void }) {
  const [version, setVersion] = useState(0)
  const [result, setResult] = useState<{ readonly version: number; readonly data: typeof DocumentList.Type | null; readonly error: string | null }>({ version: 0, data: null, error: null })
  const attempt = storedAttempt?.ownerId === ownerId ? storedAttempt : null
  const [message, setMessage] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const cancelUpload = useRef<(() => void) | undefined>(undefined)
  const busy = useRef(false)
  const loading = result.version !== version || (result.data === null && result.error === null)
  const refreshingFailed = result.error !== null
  const policy = result.data?.upload
  const ready = !loading && !refreshingFailed && policy?.availability._tag === "enabled"
  const uploading = preparing || attempt?.state === "pending"
  const chooseEnabled = ready && !uploading && attempt === null

  useEffect(() => runDocument(watchDocuments((data) => setResult({ version, data, error: null })), () => {}, (error) => {
    if (error.kind === "unauthenticated") onUnauthenticated()
    else setResult((previous) => ({ version, data: previous.data, error: error.message }))
  }), [version, onUnauthenticated])

  useEffect(() => () => {
    cancelUpload.current?.()
    setAttempt((current) => current?.ownerId === ownerId && current.state === "pending" ? { ...current, state: "uncertain", message: "Upload interrupted. Check your documents, then retry this upload with its original submission identifier if needed." } : current)
  }, [ownerId, setAttempt])
  const submit = (file: File, previous?: UploadAttempt) => {
    if (busy.current || !ready) return
    busy.current = true
    setMessage(null)
    setPreparing(true)
    cancelUpload.current = runDocument(Effect.gen(function* () {
      const key = previous?.key ?? (yield* newSubmissionKey)
      yield* Effect.sync(() => setAttempt({ ownerId, file, key, state: "pending", message: "" }))
      return yield* uploadDocument(file, key)
    }), () => {
      busy.current = false
      setPreparing(false)
      setAttempt(null)
      setMessage("Your document is saved. Its current status appears below.")
      setVersion((value) => value + 1)
    }, (error) => {
      busy.current = false
      setPreparing(false)
      setAttempt((current) => current?.ownerId === ownerId ? { ...current, state: error.kind === "rejected" && (error.status ?? 500) < 500 ? "rejected" : "uncertain", message: error.message } : current)
      setMessage(error.message)
      if (error.kind === "unauthenticated") onUnauthenticated()
      else setVersion((value) => value + 1)
    })
  }
  const selectFiles = (files: ReadonlyArray<File>) => {
    if (!chooseEnabled || policy === undefined) return
    const error = validateSelection(files, policy)
    if (error !== null) { setMessage(error); return }
    const file = files[0]
    if (file !== undefined) submit(file)
  }

  return <main className="dashboard-page" id="main-content">
    <section className="intro"><div className="sky-greeting"><i aria-hidden="true" />Hi, I’m Sky.</div><h1>Give me the complicated document.</h1><p>I’ll put its text, equations, and figures in order.</p></section>
    <section className={`dropzone${dragging ? " dragging" : ""}`} aria-label="Document upload" aria-busy={uploading}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = chooseEnabled ? "copy" : "none"; if (chooseEnabled) setDragging(true) }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget instanceof Node ? event.relatedTarget : null)) setDragging(false) }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); selectFiles(Array.from(event.dataTransfer.files)) }}>
      <div className="drop-copy"><div className="upload-symbol"><DocumentIcon /></div><div><h2>{uploading ? "Uploading and checking your PDF…" : "Drop your document here"}</h2><p id="upload-limits">{policy === undefined ? "Checking upload availability…" : `One PDF · Up to ${formatBytes(policy.maxBytes)} · ${policy.maxPages} pages · English-language documents`}</p></div></div>
      <button className="button primary" type="button" disabled={!chooseEnabled} aria-describedby="upload-limits" onClick={() => input.current?.click()}>Choose a file</button>
      <input ref={input} className="visually-hidden" aria-label="Choose a PDF" aria-hidden="true" tabIndex={-1} type="file" accept="application/pdf,.pdf" disabled={!chooseEnabled} onChange={(event) => { selectFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = "" }} />
    </section>
    {policy?.mode !== "fixture" && <p className="upload-disclosure">Your PDF is processed by our MinerU service; page images and extracted text are sent to Meta. Local documents and outputs are kept for 7 days. You can delete them after processing stops.</p>}
    {policy?.availability._tag === "disabled" && <p className="message" role="status">{policy.availability.reason}</p>}
    {policy?.mode === "fixture" && <p className="fixture-note">Test fixture · Uploads are saved to a real queue. Document processing is not connected.</p>}
    {message !== null && attempt === null && <p className="message" role="status">{message}</p>}
    {uploading && <p className="message" role="status">Uploading {attempt?.file.name ?? "your PDF"}. Keep this page open while the server checks and saves it.</p>}
    {attempt !== null && !uploading && <section className="message error" role="alert"><p>{attempt.file.name}: {attempt.message}</p>{attempt.state === "uncertain" && <p>The upload may already be saved. Check the library below; retrying uses the same submission identifier.</p>}<div className="document-actions"><button className="button" type="button" disabled={!ready} onClick={() => submit(attempt.file, attempt)}>Retry upload</button><button className="button" type="button" disabled={loading || refreshingFailed} onClick={() => { setAttempt(null); setMessage(null) }}>Choose another file</button></div></section>}
    <section className="document-list" aria-label="Your documents"><div className="list-heading"><h2>YOUR DOCUMENTS</h2><button className="text-button" type="button" disabled={loading} onClick={() => setVersion((value) => value + 1)}>Refresh</button></div>
      {loading && <p className="empty-library" role="status">Loading your documents…</p>}
      {result.error !== null && <p className="message error" role="alert">{result.error} {result.data !== null && "The last saved list is shown; its status may be out of date."} <button className="text-button" type="button" onClick={() => setVersion((value) => value + 1)}>Try again</button></p>}
      {!loading && result.data !== null && result.data.documents.length === 0 && result.error === null && <p className="empty-library">No documents yet. Your uploaded PDFs will appear here.</p>}
      {!loading && result.data?.documents.map((record) => <DocumentCard key={record.document.id} record={record} retryEnabled={result.error === null} onDeleted={() => { setVersion((value) => value + 1); navigate("/") }} onRefresh={() => setVersion((value) => value + 1)} onUnauthenticated={onUnauthenticated} />)}
    </section>
  </main>
}

export function DocumentPage({ id, onUnauthenticated }: { readonly id: DocumentId; readonly onUnauthenticated: () => void }) {
  const [version, setVersion] = useState(0)
  const [result, setResult] = useState<{ readonly id: DocumentId; readonly version: number; readonly data: DocumentRecord | null; readonly error: string | null }>({ id, version: 0, data: null, error: null })
  const current = result.id === id && result.version === version
  const record = result.id === id ? result.data : null
  useEffect(() => runDocument(watchDocument(id, (data) => setResult({ id, version, data, error: null })), () => {}, (error) => {
    if (error.kind === "unauthenticated") onUnauthenticated()
    else setResult((previous) => ({ id, version, data: previous.id === id ? previous.data : null, error: error.message }))
  }), [id, version, onUnauthenticated])
  const summary = record === null ? null : runSummary(record.latestRun)
  if (record?.currentRevisionId !== null && record?.currentRevisionId !== undefined && result.error === null) return <ReaderWorkspace key={`${id}-${record.currentRevisionId}`} record={record} revisionId={record.currentRevisionId} onRefresh={() => setVersion((value) => value + 1)} onUnauthenticated={onUnauthenticated} />
  return <main className="dashboard-page" id="main-content">
    <a className="back-link" href="/" onClick={(event) => openInternal(event, "/")}><span aria-hidden="true">←</span> All documents</a>
    {record === null && (!current || result.error === null) && <p role="status">Loading your document…</p>}
    {current && result.error !== null && <section className="message error" role="alert"><p>{result.error} {record !== null && "The last saved status is shown and may be out of date."}</p><button className="button" type="button" onClick={() => setVersion((value) => value + 1)}>Try again</button></section>}
    {record !== null && summary !== null && <section className="empty-panel" aria-labelledby="document-title"><div className="upload-symbol"><DocumentIcon /></div><h1 id="document-title" className="document-filename">{record.document.originalFilename}</h1><p>{record.document.pageCount} {record.document.pageCount === 1 ? "page" : "pages"} · {formatBytes(record.document.byteCount)} · PDF</p><p className="small-note">Available until {formatExpiry(record.document.expiresAt)}</p><div className="document-run"><h2>{summary.title}</h2><p>{summary.description}</p></div>{record.latestRun.configuration.extractionProvider === "fixture" && <p className="fixture-note">Test fixture · Document processing is not connected.</p>}<div className="document-actions"><a className="button" href={`/api/documents/${id}/original`}>Download original PDF</a></div><p className="small-note">{summary.failed ? "The original is unchanged. No normalized output was published for this run." : "The normalized document will appear here when its output is ready."}</p></section>}
    {record !== null && result.error === null && <RetryDocumentControl record={record} onRefresh={() => setVersion((value) => value + 1)} onUnauthenticated={onUnauthenticated} />}
  </main>
}
