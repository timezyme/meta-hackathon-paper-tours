import { useFocusOnChange } from "./useFocusOnChange.ts"
import { useLocation } from "./Location.tsx"
import { useEffect, useRef, useState } from "react"
import type { ChangeEvent, Dispatch, DragEvent, SetStateAction } from "react"
import { Effect } from "effect"
import type { DocumentId, DocumentList, UploadPolicy } from "../domain/index.ts"
import { newSubmissionKey, runDocument } from "./client/documents.ts"
import { documentFailureDetails, type DocumentReadFailure } from "./client/http.ts"
import { uploadDocument, watchDocument, watchDocuments } from "./client/documents.ts"
import { focusReadingPage, navigate } from "./client/browser.ts"
import { activeRun, canChooseFile, formatBytes, formatExpiry, runSummary, validateSelection } from "./documents.ts"
import type { DocumentRecord, UploadAttempt } from "./documents.ts"
import { useRoutePresentation } from "./useRoutePresentation.ts"
import { DocumentReadError } from "./DocumentReadError.tsx"
import { ReaderWorkspace } from "./reader/ReaderWorkspace.tsx"
import { RetryDocumentControl } from "./reader/RetryDocument.tsx"
import { OriginalPreview } from "./reader/OriginalPreview.tsx"
import { PageNavigation } from "./reader/Panels.tsx"
import { boundedPage } from "./reader/presentation.ts"
import { chooseGoal, GoalChoices } from "./guide/GoalChoices.tsx"
import { PaperStatus } from "./guide/PaperStatus.tsx"
import { ProcessingProgress } from "./guide/ProcessingProgress.tsx"
import { guideLocation, selectedGoal } from "./guide/navigation.ts"
import { InternalLink } from "./links.tsx"
import { GlyphText } from "./GlyphText.tsx"
import { ExampleLibrary, PaperLibrary } from "./library/PaperLibrary.tsx"
import { uploadLimits, uploadUnavailableMessage } from "./library/presentation.ts"
import { countLabel } from "./text.ts"
import "./guide/guide.css"
import "./library/library.css"

function DocumentIcon() {
  return <svg viewBox="0 0 32 34" aria-hidden="true"><path d="M8 30V4h12l6 6v20Z M20 4v7h6 M16 25V15m-4 4 4-4 4 4" /></svg>
}

const howItWorks = [
  ["Add a PDF", "A paper, a medical letter, a court opinion, a class handout or a business brief."],
  ["Muse reads and checks it", "Every page is transcribed, checked against the original and turned into a reading guide."],
  ["Follow any claim to its source", "Each explanation cites an exact quote. One click highlights it in the clean copy, and another shows the original page."],
] as const

function LibraryIntro() {
  return <section className="library-intro" aria-labelledby="library-intro-title">
    <div className="library-pitch"><h1 id="library-intro-title">Read any PDF with a guide that shows its sources.</h1>
      <p className="library-tagline">Today: humans and agents. Tomorrow: robots and humanoids.</p></div>
    <ol className="library-steps">{howItWorks.map(([title, text], index) => <li key={title}>
      <span className="library-step-number" aria-hidden="true">{index + 1}</span><div><strong>{title}</strong><p>{text}</p></div></li>)}</ol>
  </section>
}

function LibraryMasthead({ count, loading, onRefresh }: { readonly count: number | null; readonly loading: boolean; readonly onRefresh: () => void }) {
  return <header className="library-masthead"><div><p className="library-eyebrow">Reading room</p><h2>Your library</h2></div>
    <div className="library-index">{count !== null && <span>{countLabel(count, "document")}</span>}
      <button className="library-secondary-link" type="button" disabled={loading} onClick={onRefresh}>Refresh</button></div></header>
}

type DropzoneProps = {
  readonly policy: UploadPolicy
  readonly uploading: boolean
  readonly enabled: boolean
  readonly primary: boolean
  readonly onFiles: (files: ReadonlyArray<File>) => void
}

const leftDropzone = (event: DragEvent<HTMLElement>): boolean =>
  !event.currentTarget.contains(event.relatedTarget instanceof Node ? event.relatedTarget : null)

function UploadDropzone({ policy, uploading, enabled, primary, onFiles }: DropzoneProps) {
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const dragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = enabled ? "copy" : "none"
    if (enabled) setDragging(true)
  }
  const drop = (event: DragEvent<HTMLElement>) => { event.preventDefault(); setDragging(false); onFiles(Array.from(event.dataTransfer.files)) }
  const choose = (event: ChangeEvent<HTMLInputElement>) => { onFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = "" }
  return <div className={`dropzone library-drop${dragging ? " dragging" : ""}`} role="group" aria-label="Document upload" aria-busy={uploading}
    onDragOver={dragOver} onDragLeave={(event) => { if (leftDropzone(event)) setDragging(false) }} onDrop={drop}>
    <div className="library-add-copy"><span className="library-add-icon"><DocumentIcon /></span>
      <div><h2 id="library-upload-title">{uploading ? "Uploading your document…" : "Add a document"}</h2>
        <p id="upload-limits">{uploadLimits(policy)}</p>
        {policy.allowance !== undefined && <p className="upload-allowance" role="status">{allowanceText(policy.allowance)}</p>}</div></div>
    <button className={`button${primary ? " primary" : ""}`} type="button" disabled={!enabled} aria-describedby="upload-limits"
      onClick={() => input.current?.click()}>Choose a file</button>
    <input ref={input} className="visually-hidden" aria-hidden="true" tabIndex={-1} type="file" accept="application/pdf,.pdf"
      disabled={!enabled} onChange={choose} />
  </div>
}

const allowanceText = ({ limit, used }: { readonly limit: number; readonly used: number }) => used >= limit
  ? `You've used your ${countLabel(limit, "upload")}.`
  : `${countLabel(limit - used, "upload")} left of ${limit}.`

type FailureProps = {
  readonly attempt: UploadAttempt
  readonly ready: boolean
  readonly dismissable: boolean
  readonly onRetry: () => void
  readonly onDismiss: () => void
}

function UploadFailure({ attempt, ready, dismissable, onRetry, onDismiss }: FailureProps) {
  return <section className="message error" role="alert"><p>{attempt.file.name}: {attempt.message}</p>
    {attempt.state === "uncertain" && <p>The upload may already be saved. Check your library. Retrying uses the same submission identifier.</p>}
    <div className="document-actions"><button className="button" type="button" disabled={!ready} onClick={onRetry}>Retry upload</button>
      <button className="button" type="button" disabled={!dismissable} onClick={onDismiss}>Choose another file</button></div></section>
}

const uploadDisclosure = "Your page images are sent to Meta for extraction and checking. Document text and figure regions are sent to Meta"
  + " for headings, descriptions, and your reading guide. Uploaded documents and outputs are kept for 7 days. You can delete them after processing stops."
const tooLongUpload = "This PDF is longer than AmuseMe can process in one run. Choose a shorter PDF, or save an excerpt of a few pages and upload that."
const interruptedUpload = "Upload interrupted. Check your documents, then retry this upload with its original submission identifier if needed."

type DashboardProps = {
  readonly ownerId: string
  readonly storedAttempt: UploadAttempt | null
  readonly setAttempt: Dispatch<SetStateAction<UploadAttempt | null>>
  readonly onUnauthenticated: () => void
}
type ListResult = { readonly version: number; readonly data: typeof DocumentList.Type | null; readonly error: string | null }

export function Dashboard({ ownerId, storedAttempt, setAttempt, onUnauthenticated }: DashboardProps) {
  const [version, setVersion] = useState(0)
  const [result, setResult] = useState<ListResult>({ version: 0, data: null, error: null })
  const attempt = storedAttempt?.ownerId === ownerId ? storedAttempt : null
  const [message, setMessage] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const cancelUpload = useRef<(() => void) | undefined>(undefined)
  const busy = useRef(false)
  const loading = result.version !== version || (result.data === null && result.error === null)
  const main = useRoutePresentation(!loading, "Your library · AmuseMe")
  const refreshingFailed = result.error !== null
  const policy = result.data?.upload
  const ready = !loading && !refreshingFailed && policy?.availability._tag === "enabled"
  const uploading = preparing || attempt?.state === "pending"
  const chooseEnabled = canChooseFile({ ready, uploading, attempt, allowance: policy?.allowance })

  useEffect(() => runDocument(watchDocuments((data) => setResult({ version, data, error: null })), () => {}, (error) => {
    if (error.kind === "unauthenticated") onUnauthenticated()
    else setResult((previous) => ({ version, data: previous.data, error: error.message }))
  }), [version, onUnauthenticated])

  useEffect(() => () => {
    cancelUpload.current?.()
    setAttempt((current) => current?.ownerId === ownerId && current.state === "pending"
      ? { ...current, state: "uncertain", message: interruptedUpload }
      : current)
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
    }), (accepted) => {
      busy.current = false
      setPreparing(false)
      setAttempt(null)
      setMessage("Your document is saved. Opening its processing status…")
      setVersion((value) => value + 1)
      navigate(`/documents/${accepted.documentId}`)
    }, (error) => {
      busy.current = false
      setPreparing(false)
      const state = error.kind === "rejected" && (error.status ?? 500) < 500 ? "rejected" : "uncertain"
      const reason = error.code === "limit-exceeded" ? tooLongUpload : error.message
      setAttempt((current) => current?.ownerId === ownerId ? { ...current, state, message: reason } : current)
      setMessage(reason)
      if (error.kind === "unauthenticated") onUnauthenticated()
      else setVersion((value) => value + 1)
    })
  }
  const selectFiles = (files: ReadonlyArray<File>) => {
    if (!chooseEnabled || policy === undefined) return
    const error = validateSelection(files, policy)
    if (error !== null) {
      setAttempt((current) => current?.ownerId === ownerId && current.state === "rejected" ? null : current)
      setMessage(error)
      return
    }
    const file = files[0]
    if (file !== undefined) submit(file)
  }

  const records = result.data?.documents ?? []
  const hasPapers = records.length > 0
  const refresh = () => setVersion((value) => value + 1)
  const enabledPolicy = policy?.availability._tag === "enabled" ? policy : undefined
  const showLibrary = !loading && result.data !== null && (hasPapers || result.error === null)
  const controls = { retryEnabled: result.error === null, onDeleted: refresh, onRefresh: refresh, onUnauthenticated }
  return <main className="dashboard-page reading-library" id="main-content" ref={main} tabIndex={-1}>
    <LibraryIntro />
    {enabledPolicy !== undefined && <section className="library-upload" aria-labelledby="library-upload-title">
      <UploadDropzone policy={enabledPolicy} uploading={uploading} enabled={chooseEnabled} primary onFiles={selectFiles} />
      {enabledPolicy.mode !== "fixture" && <p className="upload-disclosure">{uploadDisclosure}</p>}
    </section>}
    {message !== null && attempt === null && <p className="message" role="status">{message}</p>}
    {uploading && <p className="message" role="status">
      Uploading {attempt?.file.name ?? "your PDF"}. Keep this page open while the server checks and saves it.</p>}
    {attempt !== null && !uploading && <UploadFailure attempt={attempt} ready={ready} dismissable={!loading && !refreshingFailed}
      onRetry={() => submit(attempt.file, attempt)} onDismiss={() => { setAttempt(null); setMessage(null) }} />}
    <LibraryMasthead count={result.data === null ? null : records.length} loading={loading} onRefresh={refresh} />
    {loading && <p className="library-note" role="status">Loading your documents…</p>}
    {result.error !== null && <p className="message error" role="alert">{result.error}
      {" "}{result.data !== null && "The last saved list is shown. Its status may be out of date."}
      {" "}<button className="text-button" type="button" onClick={refresh}>Try again</button></p>}
    {showLibrary && <PaperLibrary records={records} controls={controls} />}
    {showLibrary && <ExampleLibrary records={result.data?.examples ?? []} controls={controls} />}
    {policy?.availability._tag === "disabled" && <section className="library-upload-unavailable" aria-label="Document upload"><h2>Uploads paused</h2>
      <p role="status">{uploadUnavailableMessage(policy.availability, hasPapers)}</p></section>}
    {policy?.mode === "fixture" && <p className="fixture-note">Test fixture · Uploads are saved to a real queue. Document processing is not connected.</p>}
  </main>
}

type LiveProps = {
  readonly record: DocumentRecord
  readonly summary: ReturnType<typeof runSummary>
  readonly pages: ReadonlyArray<{ readonly pageNumber: number }>
  readonly page: number
}

const liveNote = (failed: boolean): string => failed
  ? "Your original is still available. No clean copy was published for this run."
  : "Keep reading. Your clean copy will open on this page when it is ready."

function LiveDocument({ record, summary, pages, page }: LiveProps) {
  const id = record.document.id
  return <section className="live-document" aria-labelledby="document-title">
    <button type="button" className="reader-text-link" onClick={() => navigate(guideLocation(id, { mode: "choices", goal: "read" }, page))}>
      <GlyphText before="←">Choose how to read</GlyphText></button>
    <header className="live-document-heading"><div><h1 id="document-title" className="document-filename">{record.document.originalFilename}</h1>
      <p>{countLabel(record.document.pageCount, "page")} · {formatBytes(record.document.byteCount)} · Original PDF</p></div>
      <PageNavigation pages={pages} page={page} onPage={(number) => navigate(guideLocation(id, { mode: "read" }, number))} /></header>
    {activeRun(record.latestRun) ? <ProcessingProgress record={record} compact />
      : <div className={`live-progress${summary.failed ? " failed" : ""}`} role="status">
        <span className="live-status-mark" aria-hidden="true">{summary.failed ? "!" : "●"}</span>
        <div><h2>{summary.title}</h2><p>{summary.description}</p><p>{liveNote(summary.failed)}</p></div></div>}
    {record.latestRun.configuration.extractionProvider === "fixture"
      && <p className="fixture-note">Test fixture · Document processing is not connected.</p>}
    <OriginalPreview documentId={id} page={page} />
    <p className="small-note">Available until {formatExpiry(record.document.expiresAt)}</p>
  </section>
}

type RecordResult = { readonly id: DocumentId; readonly version: number; readonly data: DocumentRecord | null; readonly error: DocumentReadFailure | null }

const pageTitle = (record: DocumentRecord | null, error: DocumentReadFailure | null): string =>
  `${record?.document.originalFilename ?? (error?.status === 410 ? "Document expired" : "Document unavailable")} · AmuseMe`

export function DocumentPage({ id, viewerId, onUnauthenticated }: { readonly id: DocumentId; readonly viewerId: string; readonly onUnauthenticated: () => void }) {
  const [version, setVersion] = useState(0)
  const { guide: route, page: requestedPage } = useLocation()
  const [result, setResult] = useState<RecordResult>({ id, version: 0, data: null, error: null })
  const current = result.id === id && result.version === version
  const record = result.id === id ? result.data : null
  useEffect(() => runDocument(watchDocument(id, (data) => setResult({ id, version, data, error: null })), () => {}, (error) => {
    if (error.kind === "unauthenticated") onUnauthenticated()
    else setResult((previous) => ({ id, version, data: previous.id === id ? previous.data : null, error: documentFailureDetails(error) }))
  }), [id, version, onUnauthenticated])
  const ownsOutput = record?.currentRevisionId !== null && record?.currentRevisionId !== undefined && result.error === null
  const main = useRoutePresentation(current && !ownsOutput && (record !== null || result.error !== null), pageTitle(record, result.error))
  const summary = record === null ? null : runSummary(record.latestRun)
  const pages = Array.from({ length: record?.document.pageCount ?? 1 }, (_, index) => ({ pageNumber: index + 1 }))
  const page = boundedPage(requestedPage, pages)
  useFocusOnChange(route.mode, () => {
    if (main.current !== null) focusReadingPage(main.current)
  }, { enabled: current && !ownsOutput })
  const refresh = () => setVersion((value) => value + 1)
  if (ownsOutput && record !== null && record.currentRevisionId !== null) {
    const revisionId = record.currentRevisionId
    return <ReaderWorkspace key={`${id}-${revisionId}`} record={record} revisionId={revisionId} readOnly={record.document.ownerId !== viewerId} onRefresh={refresh} onUnauthenticated={onUnauthenticated} />
  }
  const status = record !== null && summary !== null && result.error?.status !== 410 ? { record, summary } : null
  return <main className="dashboard-page" id="main-content" ref={main} tabIndex={-1}>
    <InternalLink className="back-link" href="/"><span aria-hidden="true">←</span> Your library</InternalLink>
    {record === null && (!current || result.error === null) && <p role="status">Loading your document…</p>}
    {current && result.error !== null && <><DocumentReadError error={result.error} onRetry={refresh} />
      {record !== null && result.error.status !== 410 && <p className="reader-small">The last saved status is shown and may be out of date.</p>}</>}
    {status !== null && route.mode !== "read" && <div className="guide-choice-layout">
      <GoalChoices selected={selectedGoal(route)} processing={activeRun(status.record.latestRun)} ready={false}
        onSelect={(goal) => chooseGoal(id, goal, page)}
        onOpen={() => navigate(guideLocation(id, { mode: "read" }, page))} />
      <PaperStatus record={status.record} /></div>}
    {status !== null && route.mode === "read" && <LiveDocument record={status.record} summary={status.summary} pages={pages} page={page} />}
    {record !== null && result.error === null && record.document.ownerId === viewerId && <RetryDocumentControl record={record} onRefresh={refresh} onUnauthenticated={onUnauthenticated} />}
  </main>
}
