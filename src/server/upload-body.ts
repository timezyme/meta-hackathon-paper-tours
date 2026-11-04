import { Effect, Schema } from "effect"
import { AdmissionHeaders, Document, FailureCode, boundaryParseOptions } from "../domain/index.ts"

export class UploadInputError extends Schema.TaggedError<UploadInputError>()("UploadInputError", {
  code: FailureCode,
  message: Schema.String,
}) {}

const invalid = (message: string) => new UploadInputError({ code: "invalid-input", message })

const readBody = Effect.fn("readUploadBody")(function* (request: Request, maxBytes: number) {
  if (request.body === null) return yield* invalid("Choose one PDF to upload.")
  const reader = request.body.getReader()
  return yield* Effect.acquireUseRelease(
    Effect.succeed(reader),
    (stream) => Effect.gen(function* () {
      const chunks: Uint8Array[] = []
      let total = 0
      while (true) {
        const chunk = yield* Effect.tryPromise({ try: () => stream.read(), catch: () => invalid("The upload was interrupted. Try it again.") })
        if (chunk.done) break
        total += chunk.value.byteLength
        if (total > maxBytes) return yield* new UploadInputError({ code: "limit-exceeded", message: "The upload is too large." })
        chunks.push(chunk.value)
      }
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return bytes
    }).pipe(Effect.timeout("20 seconds")),
    (stream) => Effect.tryPromise({ try: () => stream.cancel(), catch: () => invalid("Upload cleanup failed.") }).pipe(
      Effect.timeoutOption("1 second"),
      Effect.catch(() => Effect.logWarning("Upload request-body cleanup failed")),
      Effect.asVoid,
      Effect.ensuring(Effect.sync(() => stream.releaseLock())),
    ),
  )
}, (effect) => effect.pipe(
  Effect.catchTag("TimeoutError", () => Effect.fail(invalid("The upload timed out. Try it again."))),
))

export const parseUpload = Effect.fn("parseUpload")(function* (request: Request, maxFileBytes: number) {
  const header = yield* Schema.decodeUnknownEffect(AdmissionHeaders)({ "idempotency-key": request.headers.get("idempotency-key") }, boundaryParseOptions)
    .pipe(Effect.mapError(() => invalid("The upload submission ID is missing or invalid.")))
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) return yield* invalid("Upload one file using the file chooser or drop area.")
  const bytes = yield* readBody(request, maxFileBytes + 64 * 1024)
  const buffered = new Request(request.url, { method: "POST", headers: request.headers, body: bytes, signal: request.signal })
  const form = yield* Effect.tryPromise({ try: () => buffered.formData(), catch: () => invalid("The upload could not be read. Choose the PDF again.") })
  const entries = [...form.entries()]
  const selected = entries[0]
  if (entries.length !== 1 || selected === undefined || selected[0] !== "file" || typeof selected[1] === "string") {
    return yield* invalid("Upload exactly one PDF at a time.")
  }
  const file = selected[1]
  if (file.size > maxFileBytes) return yield* new UploadInputError({ code: "limit-exceeded", message: "The PDF exceeds the upload size limit." })
  if (file.size === 0) return yield* new UploadInputError({ code: "empty-document", message: "The selected file is empty." })
  const filename = yield* Schema.decodeUnknownEffect(Document.fields.originalFilename.check(Schema.isMaxLength(255)))(file.name)
    .pipe(Effect.mapError(() => invalid("Choose a PDF with a valid filename.")))
  const content = yield* Effect.tryPromise({ try: () => file.arrayBuffer(), catch: () => invalid("The upload could not be read. Try it again.") })
  return { filename, bytes: new Uint8Array(content), idempotencyKey: header["idempotency-key"] }
})
