import { Crypto, Effect, Schema } from "effect"
import { RequestFingerprint, type Document, type Run, type StageReceipt } from "../domain/index.ts"
import type { GuardPolicy } from "./contracts.ts"
import { providerJson } from "./recovery.ts"

export interface FingerprintedRequest {
  readonly run: Pick<Run, "ownerId" | "pipelineVersion" | "schemaVersion">
  readonly document: Pick<Document, "id" | "sourceHash">
  readonly unit: Pick<StageReceipt, "stage" | "pageIds" | "figureId" | "task" | "inputHashes">
  readonly configuration: StageReceipt["configuration"]
  readonly request: Schema.Json
  readonly supportsIdempotency: boolean
  readonly policy: Pick<GuardPolicy, "maxResponseBytes" | "callDeadlineMilliseconds">
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

export const requestFingerprint = Effect.fnUntraced(function* (fingerprinted: FingerprintedRequest) {
  const { run, document, unit, configuration, request, supportsIdempotency, policy } = fingerprinted
  const payload = providerJson({
    ownerId: run.ownerId, documentId: document.id, sourceHash: document.sourceHash,
    pipelineVersion: run.pipelineVersion, schemaVersion: run.schemaVersion,
    stage: unit.stage, pageIds: unit.pageIds, figureId: unit.figureId,
    ...(unit.task === undefined ? {} : { task: unit.task }),
    inputHashes: unit.inputHashes, configuration, request, supportsIdempotency,
    maxResponseBytes: policy.maxResponseBytes, callDeadlineMilliseconds: policy.callDeadlineMilliseconds,
  })
  const crypto = yield* Crypto.Crypto
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(payload))
  return yield* Schema.decodeUnknownEffect(RequestFingerprint)(hex(digest))
})
