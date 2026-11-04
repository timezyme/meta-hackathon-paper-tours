import { Deferred, type Duration, Effect, FileSystem, Option, Path, Schema, Semaphore } from "effect"
import { ApiError, errorHttpStatus, type DocumentId, type FailureCode, type UserId } from "../domain/index.ts"
import { PdfRenderer } from "../paper/pdf/index.ts"
import { DocumentStore } from "../storage/index.ts"
import { UploadInputError } from "./upload-body.ts"

export interface PreviewQueue {
  readonly waiting: number
  readonly wait: Duration.Input
}
export const previewQueue: PreviewQueue = { waiting: 32, wait: "30 seconds" }

const errorResponse = (code: typeof FailureCode.Type, message: string) => Schema.encodeEffect(ApiError)({ code, message }).pipe(
  Effect.map((payload) => Response.json(payload, { status: errorHttpStatus[code], headers: { "cache-control": "no-store" } })),
  Effect.orDie,
)

const previewBusy = () => errorResponse("queue-full", "Another original page is loading. Try again shortly.")
const aborted = (signal: AbortSignal) => Effect.callback<never>((resume) => {
  const abort = () => resume(Effect.interrupt)
  if (signal.aborted) abort()
  else signal.addEventListener("abort", abort, { once: true })
  return Effect.sync(() => signal.removeEventListener("abort", abort))
})

export const makeDocumentPreviews = Effect.fnUntraced(function* (options: {
  readonly temporaryDirectory: string
  readonly previewQueue?: PreviewQueue | undefined
}) {
  const store = yield* DocumentStore
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const queue = options.previewQueue ?? previewQueue
  const previewPlaces = yield* Semaphore.make(1 + queue.waiting)
  const previews = yield* Semaphore.make(1)
  const renderer = yield* Effect.serviceOption(PdfRenderer)

  const inPreviewLine = <E, R>(job: Effect.Effect<Response, E, R>, client: AbortSignal) => Effect.gen(function* () {
    const renderStarted = yield* Deferred.make<void>()
    const turn = Deferred.succeed(renderStarted, undefined).pipe(Effect.andThen(job), previews.withPermits(1))
    const waitExpired = Deferred.await(renderStarted).pipe(
      Effect.timeoutOption(queue.wait),
      Effect.flatMap(Option.match({ onNone: previewBusy, onSome: () => Effect.never })),
    )
    return yield* Effect.raceFirst(Effect.raceFirst(turn, waitExpired), aborted(client))
  }).pipe(
    previewPlaces.withPermitsIfAvailable(1),
    Effect.flatMap(Option.match({ onNone: previewBusy, onSome: Effect.succeed })),
  )

  const renderPage = (owner: UserId, id: DocumentId, requestedPage: string | null, signal: AbortSignal) => Effect.gen(function* () {
    if (Option.isNone(renderer)) return yield* errorResponse("processing-unavailable", "Original page previews are unavailable. Download the original PDF instead.")
    const render = renderer.value.render
    const { document, privatePath } = yield* store.originalFile(owner, id)
    const PageNumber = Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: document.pageCount }))
    const pageNumber = yield* Schema.decodeUnknownEffect(PageNumber)(requestedPage)
      .pipe(Effect.mapError(() => new UploadInputError({ code: "invalid-input", message: "Choose a page in this document." })))
    const tooSlow = () => errorResponse("processing-unavailable", "The original page preview took too long. Try again or download the original PDF.")
    return yield* inPreviewLine(Effect.gen(function* () {
      const directory = yield* fs.makeTempDirectoryScoped({ directory: options.temporaryDirectory, prefix: "preview-" })
      yield* fs.chmod(directory, 0o700)
      const { byteCount, sourceHash, pageCount } = document
      const pages = yield* render({ privatePath, byteCount, sourceHash, pageCount, outputDirectory: directory, pageNumber })
      const page = pages[0]
      if (page === undefined) return yield* errorResponse("processing-unavailable", "Original page preview unavailable.")
      const image = yield* fs.readFile(path.join(directory, page.image.path))
      // SAFETY: Recheck after rendering because the document may have been deleted or expired.
      yield* store.detail(owner, id)
      return new Response(image, { headers: { "content-type": "image/png", "content-length": String(image.byteLength) } })
    }).pipe(Effect.scoped, Effect.timeoutOrElse({ duration: "20 seconds", orElse: tooSlow })), signal)
  })
  return { renderPage }
})
