import { Clock, Crypto, Effect, Redacted, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import type { HttpClientResponse } from "effect/http/HttpClientResponse"
import { ArtifactHash, PositiveInt, ProviderAttemptId, RelativePath, SourceScope, StageReceipt, UserId } from "../../../domain/index.ts"
import { executionFailure, ProviderAdapter, ProviderFailure } from "../../../processing/index.ts"
import type { GuardError, ProviderCall, ProviderResponse } from "../../../processing/index.ts"
import { MineruArchiveReader } from "./archive.ts"
import { MINERU_VERSION, MineruLimits } from "./contracts.ts"

export const MineruTransportLimits = { requestMilliseconds: 60_000, pollMilliseconds: 1_500_000, pollIntervalMilliseconds: 2000, controlBytes: 65_536 } as const
const JobId = ProviderAttemptId.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
export const MineruRequest = Schema.Struct({ provider: Schema.Literal("mineru"), version: Schema.Literal(MINERU_VERSION), source: Schema.Struct({ path: Schema.Literal("source.pdf"), byteCount: PositiveInt, hash: ArtifactHash }) })
export const MineruRawArtifact = Schema.Struct({ path: RelativePath, byteCount: PositiveInt, hash: ArtifactHash })
export type MineruRawArtifact = typeof MineruRawArtifact.Type
const EnvelopeIdentity = { format: Schema.Literal("amuseme-mineru-archive-v1"), jobId: JobId, ownerId: UserId, scope: SourceScope }
export const MineruEnvelope = Schema.Union([
  Schema.Struct({ ...EnvelopeIdentity, status: Schema.Literal("archive"), artifact: MineruRawArtifact }),
  Schema.Struct({ ...EnvelopeIdentity, status: Schema.Literal("failed"), reason: Schema.Literals(["remote-failed", "request-rejected", "remote-expired"]) }),
])
export type MineruEnvelope = typeof MineruEnvelope.Type
export interface MineruBoundaryOptions {
  readonly endpoint: string
  readonly token: Redacted.Redacted<string>
  readonly readSource: (receipt: StageReceipt) => Effect.Effect<Uint8Array, GuardError>
  readonly saveArchive: (receipt: StageReceipt, artifact: MineruRawArtifact, bytes: Uint8Array) => Effect.Effect<void, GuardError>
  readonly readArchive: (receipt: StageReceipt, artifact: MineruRawArtifact) => Effect.Effect<Uint8Array, GuardError>
}
const uncertain = (message: string) => new ProviderFailure({ certainty: "unknown", message })
const refused = (message: string) => new ProviderFailure({ certainty: "not-submitted", message })
const digestHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
const sameScope = (left: SourceScope, right: SourceScope) => left.documentId === right.documentId && left.runId === right.runId && left.sourceHash === right.sourceHash
const identity = (receipt: StageReceipt) => ({ format: "amuseme-mineru-archive-v1" as const, jobId: receipt.id, ownerId: receipt.ownerId, scope: receipt.scope })
const completedResponse = (response: MineruEnvelope): ProviderResponse => ({ response, usage: { _tag: "unavailable", reason: "MinerU did not report usage or cost" }, actualCostMicrousd: null })
const collectBody = (response: HttpClientResponse, maxBytes: number) => Effect.gen(function* () {
  const declared = response.headers["content-length"]
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return yield* executionFailure("limit-exceeded", "The MinerU response exceeds its byte limit")
  const chunks: Array<Uint8Array> = []
  let length = 0
  yield* response.stream.pipe(Stream.runForEach((chunk) => {
    length += chunk.byteLength
    if (length > maxBytes) return Effect.fail(executionFailure("limit-exceeded", "The MinerU response exceeds its byte limit"))
    chunks.push(chunk)
    return Effect.void
  }), Effect.mapError((error) => error._tag === "ExecutionFailure" ? error : uncertain("MinerU response ended before completion")))
  if (declared !== undefined && Number(declared) !== length) return yield* uncertain("MinerU response length did not match its header")
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
})

export const makeMineruBoundary = Effect.fn("makeMineruBoundary")(function* (options: MineruBoundaryOptions) {
  if (!URL.canParse(options.endpoint)) return yield* refused("The AmuseMe MinerU endpoint is not configured")
  const endpoint = new URL(options.endpoint)
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "" || !/^(?:(?:[a-z0-9-]+--)?amuseme-(?:staging|production)-mineru(?:-[a-z0-9-]+)?\.(?:[a-z0-9-]+\.)?modal\.run|amuseme-[a-z0-9-]+\.invalid)$/iu.test(endpoint.hostname) || Redacted.value(options.token).trim() === "") return yield* refused("MinerU requires a separate HTTPS endpoint and bearer credential")
  const base = endpoint.href.replace(/\/$/, "")
  const client = yield* HttpClient.HttpClient
  const crypto = yield* Crypto.Crypto
  const archives = yield* MineruArchiveReader
  const attempted = new Set<string>()
  const hash = (bytes: Uint8Array) => crypto.digest("SHA-256", bytes).pipe(Effect.map(digestHex), Effect.mapError(() => executionFailure("provider-failed", "Artifact hashing is unavailable")))
  const requireReceipt = Effect.fnUntraced(function* (raw: StageReceipt) {
    const receipt = yield* Schema.decodeUnknownEffect(StageReceipt)(raw).pipe(Effect.mapError(() => refused("The MinerU receipt is invalid")))
    yield* Schema.decodeUnknownEffect(JobId)(receipt.id).pipe(Effect.mapError(() => refused("MinerU requires a generated UUID attempt ID")))
    if (receipt.stage !== "extraction" || receipt.configuration._tag !== "extraction" || receipt.configuration.provider !== "mineru" || receipt.configuration.version !== MINERU_VERSION || !receipt.inputHashes.some((value) => String(value) === String(receipt.scope.sourceHash))) return yield* refused("The MinerU receipt does not authorize this extraction")
    return receipt
  })
  const request = Effect.fnUntraced(function* (receipt: StageReceipt, method: "GET" | "POST", deadline: number, bytes?: Uint8Array) {
    const now = yield* Clock.currentTimeMillis
    const remaining = Math.min(MineruTransportLimits.requestMilliseconds, deadline - now)
    if (remaining <= 0) return yield* uncertain("MinerU polling deadline elapsed; retrieve this same job to resume")
    const url = `${base}/jobs/${receipt.id}`
    let outbound = HttpClientRequest.make(method)(url).pipe(HttpClientRequest.bearerToken(options.token), HttpClientRequest.setHeader("accept", "application/zip, application/json"))
    if (bytes !== undefined) outbound = outbound.pipe(HttpClientRequest.bodyUint8Array(bytes, "application/pdf"))
    return yield* Effect.gen(function* () {
      const response = yield* client.execute(outbound).pipe(Effect.mapError(() => uncertain("MinerU request ended without a complete response")))
      if (response.status >= 300 && response.status < 400 || response.url !== "" && response.url !== url) return yield* uncertain("MinerU redirects are not permitted")
      const mediaType = response.headers["content-type"]?.split(";")[0]?.trim()
      const maximum = method === "GET" && response.status === 200 && mediaType === "application/zip" ? MineruLimits.maxCompressedBytes : MineruTransportLimits.controlBytes
      const body = yield* collectBody(response, maximum)
      return { status: response.status, mediaType, body }
    }).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }), Effect.timeoutOrElse({ duration: remaining, orElse: () => Effect.fail(uncertain("MinerU request deadline elapsed; remote completion remains unknown")) }))
  })
  const poll = Effect.fnUntraced(function* (receipt: StageReceipt, deadline: number) {
    while (true) {
      const response = yield* request(receipt, "GET", deadline)
      if (response.status === 202) {
        const now = yield* Clock.currentTimeMillis
        if (deadline - now <= MineruTransportLimits.pollIntervalMilliseconds) return yield* uncertain("MinerU polling deadline elapsed; retrieve this same job to resume")
        yield* Effect.sleep(MineruTransportLimits.pollIntervalMilliseconds)
        continue
      }
      if (response.status === 410) return completedResponse({ ...identity(receipt), status: "failed", reason: "remote-expired" })
      if (response.status === 200 && response.mediaType === "application/zip") {
        if (response.body.byteLength === 0) return yield* uncertain("MinerU returned an empty archive")
        const artifact = yield* Schema.decodeUnknownEffect(MineruRawArtifact)({ path: `provider/mineru/${receipt.id}.zip`, byteCount: response.body.byteLength, hash: yield* hash(response.body) }).pipe(Effect.mapError(() => executionFailure("invalid-provider-response", "The MinerU archive identity is invalid")))
        yield* options.saveArchive(receipt, artifact, response.body)
        return completedResponse({ ...identity(receipt), status: "archive", artifact })
      }
      if (response.status === 200 && response.mediaType === "application/json") {
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ status: Schema.Literal("failed") })))(new TextDecoder().decode(response.body), { onExcessProperty: "error" }).pipe(Effect.mapError(() => uncertain("MinerU returned an unrecognized job result")))
        return completedResponse({ ...identity(receipt), status: "failed", reason: "remote-failed" })
      }
      return yield* uncertain("MinerU job status is unavailable; retain its existing UUID")
    }
  })
  const retrieve = Effect.fn("MineruBoundary.retrieve")(function* (rawReceipt: StageReceipt) {
    const receipt = yield* requireReceipt(rawReceipt)
    if ((receipt.state._tag !== "submitted" && receipt.state._tag !== "unknown-completion") || receipt.state.providerRequestId !== receipt.id) return yield* refused("GET recovery requires the saved MinerU job UUID")
    return yield* poll(receipt, (yield* Clock.currentTimeMillis) + MineruTransportLimits.pollMilliseconds)
  })
  const invoke = Effect.fn("MineruBoundary.invoke")(function* (call: ProviderCall) {
    const receipt = yield* requireReceipt(call.receipt)
    if (call.attemptId !== receipt.id) return yield* refused("The MinerU attempt and receipt identities differ")
    if (receipt.state._tag === "submitted" || receipt.state._tag === "unknown-completion") return yield* retrieve(receipt)
    if (receipt.state._tag !== "prepared") return yield* refused("This MinerU attempt cannot be submitted")
    const now = yield* Clock.currentTimeMillis
    const deadline = Math.min(call.intent.deadlineAt, now + MineruTransportLimits.pollMilliseconds)
    if (attempted.has(receipt.id)) return yield* poll(receipt, deadline)
    const descriptor = yield* Schema.decodeUnknownEffect(MineruRequest)(call.intent.request, { onExcessProperty: "error" }).pipe(Effect.mapError(() => refused("The MinerU source descriptor is invalid")))
    if (descriptor.source.byteCount > MineruLimits.maxCompressedBytes || String(descriptor.source.hash) !== String(receipt.scope.sourceHash) || deadline <= now) return yield* refused("The MinerU source or dispatch deadline does not match its authorization")
    const source = yield* options.readSource(receipt)
    if (source.byteLength !== descriptor.source.byteCount || source.byteLength > MineruLimits.maxCompressedBytes || new TextDecoder().decode(source.subarray(0, 5)) !== "%PDF-" || (yield* hash(source)) !== descriptor.source.hash) return yield* refused("The actual PDF bytes do not match the authorized source")
    if (attempted.has(receipt.id)) return yield* poll(receipt, deadline)
    attempted.add(receipt.id)
    yield* call.submitted(receipt.id)
    const response = yield* request(receipt, "POST", deadline, source)
    if ([400, 401, 403, 409, 413, 415].includes(response.status)) return completedResponse({ ...identity(receipt), status: "failed", reason: "request-rejected" })
    if (response.status !== 200 || response.mediaType !== "application/json") return yield* uncertain("MinerU submission acknowledgement is unavailable")
    const acknowledgement = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ callId: JobId })))(new TextDecoder().decode(response.body), { onExcessProperty: "error" }).pipe(Effect.mapError(() => uncertain("MinerU submission acknowledgement is invalid")))
    if (acknowledgement.callId !== receipt.id) return yield* uncertain("MinerU returned a different job identity")
    return yield* poll(receipt, deadline)
  })
  const validate = Effect.fn("MineruBoundary.validate")(function* (raw: Schema.Json, rawReceipt: StageReceipt) {
    const receipt = yield* requireReceipt(rawReceipt).pipe(Effect.mapError(() => executionFailure("invalid-provider-response", "The saved MinerU receipt is invalid")))
    const response = yield* Schema.decodeUnknownEffect(MineruEnvelope)(raw, { onExcessProperty: "error" }).pipe(Effect.mapError(() => executionFailure("invalid-provider-response", "The saved MinerU envelope is invalid")))
    if (response.jobId !== receipt.id || response.ownerId !== receipt.ownerId || !sameScope(response.scope, receipt.scope)) return yield* executionFailure("invalid-provider-response", "The saved MinerU response belongs to another extraction")
    if (response.status === "failed") return yield* executionFailure("invalid-provider-response", "MinerU reported a definite extraction failure")
    if (response.artifact.path !== `provider/mineru/${receipt.id}.zip` || response.artifact.byteCount > MineruLimits.maxCompressedBytes) return yield* executionFailure("invalid-provider-response", "The saved MinerU archive identity is invalid")
    const bytes = yield* options.readArchive(receipt, response.artifact).pipe(Effect.mapError(() => executionFailure("provider-failed", "The private MinerU archive cannot be read")))
    if (bytes.byteLength !== response.artifact.byteCount || (yield* hash(bytes)) !== response.artifact.hash) return yield* executionFailure("invalid-provider-response", "The private MinerU archive does not match its saved receipt")
    yield* archives.decode(bytes).pipe(Effect.mapError((error) => executionFailure(error.code === "processing-unavailable" ? "provider-failed" : "invalid-provider-response", error.message)))
  })
  return { adapter: ProviderAdapter.of({ invoke, validate, retrieve }), retrieve }
})
