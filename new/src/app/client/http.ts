import { Effect, Schema } from "effect"
import { HttpClient, type HttpClientRequest, type HttpClientResponse } from "effect/http"
import { ApiError, boundaryParseOptions } from "../../domain/index.ts"

export class DocumentFailure extends Schema.TaggedError<DocumentFailure>()("DocumentFailure", {
  kind: Schema.Literals(["transport", "rejected", "invalid-response", "unauthenticated"]),
  message: Schema.String,
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {}

export type DocumentReadFailure = Pick<DocumentFailure, "kind" | "message" | "status">
export const documentFailureDetails = ({ kind, message, status }: DocumentFailure): DocumentReadFailure =>
  ({ kind, message, ...(status === undefined ? {} : { status }) })

export type HttpMessages = {
  readonly unreachable: string
  readonly timedOut: string
  readonly unreadable: string
  readonly unexpectedError: string
  readonly invalidData: string
  readonly rejected?: (status: number, serverMessage: string) => string
}

const invalid = (message: string, status?: number) => (cause: unknown) =>
  new DocumentFailure({ kind: "invalid-response", message, cause, ...(status === undefined ? {} : { status }) })

export const makeHttp = (messages: HttpMessages) => {
  const transport = (cause: unknown) => new DocumentFailure({ kind: "transport", message: messages.unreachable, cause })
  const deadline = Effect.timeoutOrElse({
    duration: "30 seconds",
    orElse: () => Effect.fail(new DocumentFailure({ kind: "transport", message: messages.timedOut })),
  })
  const respond = Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest, expected: number) {
    const client = HttpClient.withScope(yield* HttpClient.HttpClient)
    const response = yield* client.execute(request).pipe(Effect.mapError(transport))
    if (response.status === 401) {
      return yield* new DocumentFailure({ kind: "unauthenticated", message: "Your session expired. Please sign in again.", status: 401 })
    }
    if (response.status === expected) return response
    const json = yield* response.json.pipe(Effect.mapError(invalid(messages.unreadable)))
    const error = yield* Schema.decodeUnknownEffect(ApiError)(json, boundaryParseOptions).pipe(
      Effect.mapError(invalid(messages.unexpectedError, response.status)),
    )
    const message = messages.rejected?.(response.status, error.message) ?? error.message
    return yield* new DocumentFailure({ kind: "rejected", message, status: response.status })
  })
  const decodeJson = Effect.fnUntraced(function* <A>(response: HttpClientResponse.HttpClientResponse, schema: Schema.Decoder<A>) {
    const json = yield* response.json.pipe(Effect.mapError(invalid(messages.unreadable)))
    return yield* Schema.decodeUnknownEffect(schema)(json, boundaryParseOptions).pipe(Effect.mapError(invalid(messages.invalidData)))
  })
  const requestJson = Effect.fnUntraced(function* <A>(request: HttpClientRequest.HttpClientRequest, schema: Schema.Decoder<A>, status: number) {
    return yield* decodeJson(yield* respond(request, status), schema)
  }, deadline, Effect.scoped)
  return { transport, invalid, deadline, respond, decodeJson, requestJson }
}
