import { Effect, Schema, Stream } from "effect"
import { UploadInputError } from "./upload-body.ts"

export const readSmallJson = Effect.fn("readSmallJson")(function* <A>(request: Request, schema: Schema.Codec<A, unknown>) {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || request.body === null) return yield* new UploadInputError({ code: "invalid-input", message: "A JSON request is required" })
  const bytes = yield* Stream.fromReadableStream({ evaluate: () => request.body!, onError: () => "Interrupted request" }).pipe(Stream.runFoldEffect(() => new Uint8Array(), (saved, chunk) => {
    if (saved.length + chunk.length > 1024) return Effect.fail("Request is too large")
    const next = new Uint8Array(saved.length + chunk.length)
    next.set(saved); next.set(chunk, saved.length)
    return Effect.succeed(next)
  }))
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(bytes), { onExcessProperty: "error" })
}, (effect) => effect.pipe(Effect.timeout("5 seconds"), Effect.mapError(() => new UploadInputError({ code: "invalid-input", message: "The request is invalid or incomplete" }))))
