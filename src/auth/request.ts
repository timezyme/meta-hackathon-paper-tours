import { Effect, Schema } from "effect"

export class AuthInputError extends Schema.TaggedError<AuthInputError>()("AuthInputError", {
  status: Schema.Literals([400, 408, 413]),
}) {}

export const bufferAuthRequest = Effect.fn("bufferAuthRequest")(function* (request: Request) {
  if (request.body === null) return request
  const reader = request.body.getReader()
  const body = yield* Effect.acquireUseRelease(
    Effect.succeed(reader),
    (stream) => Effect.gen(function* () {
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const chunk = yield* Effect.tryPromise({
          try: () => stream.read(),
          catch: () => new AuthInputError({ status: 400 }),
        })
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 16 * 1024) return yield* new AuthInputError({ status: 413 })
        chunks.push(chunk.value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return new TextDecoder().decode(bytes)
    }).pipe(Effect.timeout("5 seconds")),
    (stream) => Effect.tryPromise({
      try: () => stream.cancel(),
      catch: () => new AuthInputError({ status: 400 }),
    }).pipe(
      Effect.timeoutOption("1 second"),
      Effect.catch(() => Effect.logWarning("Authentication request-body cleanup failed")),
      Effect.asVoid,
    ),
  ).pipe(Effect.catchTag("TimeoutError", () => new AuthInputError({ status: 408 })))
  return new Request(request.url, { method: request.method, headers: request.headers, signal: request.signal, body })
})
