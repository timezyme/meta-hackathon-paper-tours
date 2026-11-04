import { metaRuntimeConfiguration, runGuardPolicy } from "./policy.ts"
import { Clock, Context, Crypto, DateTime, Effect, Layer, Result, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { MetaEnvelope } from "../paper/providers/meta/contracts.ts"
import type { Kysely } from "kysely"
import { AcceptedRun, Document, DocumentId, IdempotencyKey, Run, RunId, StageReceipt, UserId } from "../domain/index.ts"
import { StorageDatabase, type ApplicationDatabase, type ProviderAttemptRow, type storageQuery } from "../storage/index.ts"
import { AttemptIntent, GuardPolicy, executionFailure, type GuardError } from "./contracts.ts"

export const RetryRequest = Schema.Struct({ ownerId: UserId, documentId: DocumentId, previousRunId: RunId, idempotencyKey: IdempotencyKey, acknowledgesUnknownCompletion: Schema.Boolean })
export type RetryRequest = typeof RetryRequest.Type
export class RunRecovery extends Context.Service<RunRecovery, { readonly requestRetry: (request: RetryRequest) => Effect.Effect<typeof AcceptedRun.Type, GuardError> }>()("amuseme/processing/RunRecovery") {}
export const providerJson = (value: Schema.Json): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(providerJson).join(",")}]` : `{${Object.entries<Schema.Json>(value).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${providerJson(child)}`).join(",")}}`
export const providerUnitKey = (unit: { readonly stage: string; readonly pageIds: ReadonlyArray<string>; readonly figureId: string | null; readonly task?: string | undefined }): string =>
  providerJson({ stage: unit.stage, pageIds: unit.pageIds.toSorted(), figureId: unit.figureId, ...(unit.task === undefined ? {} : { task: unit.task }) })
const invalid = () => executionFailure("invalid-provider-response", "The saved retry evidence is invalid")
const decode = <A>(schema: Schema.Codec<A, unknown>, value: unknown) => Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(Effect.mapError(invalid))
const hex = (bytes: Uint8Array) => Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")
export const savedAttempt = Effect.fn("Recovery.savedAttempt")(function* (row: ProviderAttemptRow) {
  const receipt = yield* decode(Schema.fromJsonString(StageReceipt), row.receipt_json)
  const intent = yield* decode(Schema.fromJsonString(AttemptIntent), row.intent_json)
  if (receipt.id !== row.id || receipt.ownerId !== row.owner_id || receipt.scope.documentId !== row.document_id || receipt.scope.runId !== row.run_id || receipt.requestFingerprint !== row.fingerprint || providerUnitKey(receipt) !== row.stage_key) return yield* invalid()
  const response = row.response_json === null ? null : yield* decode(Schema.fromJsonString(Schema.Json), row.response_json)
  if (receipt.state._tag === "completed") {
    const crypto = yield* Crypto.Crypto
    const hash = yield* crypto.digest("SHA-256", new TextEncoder().encode(providerJson(response))).pipe(Effect.map(hex), Effect.mapError(invalid))
    if (row.status !== "completed" || row.response_json === null || receipt.state.responseHash !== hash || row.validation_state !== receipt.state.validation._tag && row.validation_state !== "pending") return yield* invalid()
  }
  return { receipt, intent, response }
})
export const retrievableMineru = (receipt: StageReceipt): boolean => receipt.stage === "extraction" && receipt.configuration._tag === "extraction" && receipt.configuration.provider === "mineru" && (receipt.state._tag === "submitted" || receipt.state._tag === "unknown-completion") && receipt.state.providerRequestId === receipt.id && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(receipt.id)
const transientMeta = (value: Schema.Json): boolean => {
  const parsed = Schema.decodeUnknownResult(MetaEnvelope)(value, { onExcessProperty: "error" })
  if (Result.isFailure(parsed) || !parsed.success.complete || ![429, 502, 503, 504].includes(parsed.success.status)) return false
  const decoded = Base64.decode(parsed.success.bodyBase64)
  return Result.isSuccess(decoded) && Base64.encode(decoded.success) === parsed.success.bodyBase64
}
export const bindDocumentPolicy = Effect.fnUntraced(function* (db: Kysely<ApplicationDatabase>, query: typeof storageQuery, documentId: string, policy: GuardPolicy) {
  const saved = yield* query("retry-policy", () => db.selectFrom("document_policies").selectAll().where("document_id", "=", documentId).executeTakeFirst())
  if (saved !== undefined) {
    if (saved.budget_id !== policy.budgetId || providerJson(yield* decode(Schema.fromJsonString(GuardPolicy), saved.policy_json)) !== providerJson(policy)) return yield* executionFailure("conflict", "This document must retain its original processing policy and budget")
    return
  }
  const prior = yield* query("retry-policy", () => db.selectFrom("provider_attempts").select("id").where("document_id", "=", documentId).executeTakeFirst())
  if (prior !== undefined) return yield* executionFailure("processing-unavailable", "Historical attempts have no saved processing policy; new dispatch requires policy reconciliation")
  yield* query("retry-policy", () => db.insertInto("document_policies").values({ document_id: documentId, budget_id: policy.budgetId, policy_json: JSON.stringify(policy) }).execute())
})

export const makeRunRecovery = Effect.fn("makeRunRecovery")(function* (configuration: GuardPolicy, queueLimit: number) {
  const policy = yield* decode(GuardPolicy, configuration)
  yield* decode(Schema.Int.check(Schema.isGreaterThan(0)), queueLimit)
  const database = yield* StorageDatabase
  const crypto = yield* Crypto.Crypto
  const identifier = () => crypto.randomUUIDv4().pipe(Effect.mapError(() => executionFailure("provider-failed", "A retry identifier could not be allocated")))
  const requestRetry = Effect.fn("RunRecovery.requestRetry")(function* (raw: RetryRequest) {
    const request = yield* decode(RetryRequest, raw)
    return yield* database.transaction((db) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const documentRow = yield* database.query("retry-document", () => db.selectFrom("documents").selectAll().where("id", "=", request.documentId).where("owner_id", "=", request.ownerId).where("lifecycle", "=", "active").where("expires_at", ">", now).executeTakeFirst())
      if (documentRow === undefined) return yield* executionFailure("conflict", "The document is not available for retry")
      const previousRequest = yield* database.query("retry-request", () => db.selectFrom("retry_requests").selectAll().where("owner_id", "=", request.ownerId).where("request_key", "=", request.idempotencyKey).executeTakeFirst())
      if (previousRequest !== undefined) {
        if (previousRequest.document_id !== request.documentId || previousRequest.previous_run_id !== request.previousRunId || previousRequest.acknowledges_unknown !== Number(request.acknowledgesUnknownCompletion)) return yield* executionFailure("conflict", "The retry request key was already used for different input")
        return yield* decode(AcceptedRun, { documentId: previousRequest.document_id, runId: previousRequest.run_id })
      }
      const row = yield* database.query("retry-run", () => db.selectFrom("runs").selectAll().where("id", "=", request.previousRunId).where("owner_id", "=", request.ownerId).where("document_id", "=", request.documentId).executeTakeFirst())
      if (row === undefined || documentRow.latest_run_id !== row.id || row.state !== "failed" && row.state !== "interrupted") return yield* executionFailure("conflict", "Only the latest failed or interrupted run can be retried")
      const document = yield* decode(Schema.fromJsonString(Document), documentRow.document_json)
      const previous = yield* decode(Schema.fromJsonString(Run), row.run_json)
      if (policy.mode === "live" && !metaRuntimeConfiguration(previous.configuration)) return yield* executionFailure("processing-unavailable", "Historical non-Meta runs cannot be retried in this Meta-only runtime")
      const history = yield* database.query("retry-run-limit", () => db.selectFrom("runs").select((expression) => expression.fn.countAll<number>().as("count")).where("document_id", "=", document.id).where("owner_id", "=", request.ownerId).executeTakeFirstOrThrow())
      if (history.count > Math.min(previous.configuration.maxProviderAttempts, 999)) return yield* executionFailure("limit-exceeded", "The document retry-run allowance is exhausted")
      yield* bindDocumentPolicy(db, database.query, document.id, runGuardPolicy(policy, previous.configuration))
      if ((previous.state._tag === "failed" || previous.state._tag === "interrupted") && ["invalid-input", "unsupported-pdf", "encrypted-pdf", "empty-document"].includes(previous.state.failure.code)) return yield* executionFailure("invalid-provider-response", "This permanent input failure cannot be retried")
      const active = yield* database.query("retry-admission", () => db.selectFrom("runs").select("id").where("owner_id", "=", request.ownerId).where("state", "in", ["queued", "running"]).executeTakeFirst())
      const queued = yield* database.query("retry-admission", () => db.selectFrom("runs").select((expression) => expression.fn.countAll<number>().as("count")).where("state", "=", "queued").executeTakeFirstOrThrow())
      if (active !== undefined || queued.count >= queueLimit) return yield* executionFailure("conflict", "Processing admission is currently full")
      const rows = yield* database.query("retry-attempts", () => db.selectFrom("provider_attempts").selectAll().where("document_id", "=", document.id).where("owner_id", "=", request.ownerId).orderBy("created_at", "asc").orderBy("id", "asc").execute())
      if (rows.some((attempt) => ["prepared", "dispatching", "submitted", "unknown"].includes(attempt.status) && attempt.lease_expires_at > now)) return yield* executionFailure("conflict", "A previous provider attempt still holds its execution lease")
      const requests = yield* database.query("retry-chain", () => db.selectFrom("retry_requests").select(["run_id", "previous_run_id"]).where("document_id", "=", document.id).execute())
      const runOrder = new Map<string, number>()
      let cursor: string | undefined = previous.id
      while (cursor !== undefined) {
        if (runOrder.has(cursor)) return yield* invalid()
        runOrder.set(cursor, runOrder.size)
        const current: string = cursor
        cursor = requests.find((entry) => entry.run_id === current)?.previous_run_id
      }
      if (rows.some((attempt) => !runOrder.has(attempt.run_id))) return yield* invalid()
      const ordered = rows.toSorted((left, right) => (runOrder.get(right.run_id) ?? 0) - (runOrder.get(left.run_id) ?? 0) || left.created_at - right.created_at)
      const latest = new Map(ordered.map((attempt) => [`${attempt.stage_key}\n${attempt.fingerprint}`, attempt]))
      const grants: Array<ProviderAttemptRow> = []
      for (const attempt of latest.values()) {
        const evidence = yield* savedAttempt(attempt).pipe(Effect.provideService(Crypto.Crypto, crypto))
        const transient = (evidence.receipt.configuration._tag === "model" || evidence.receipt.configuration.provider === "meta") && transientMeta(evidence.response)
        if (attempt.status === "completed" && (attempt.validation_state === "accepted" || (attempt.validation_state === "rejected" || attempt.validation_state === "pending") && !transient)) continue
        if (retrievableMineru(evidence.receipt)) continue
        const uncertain = ["unknown", "dispatching", "submitted"].includes(attempt.status)
        if (uncertain && evidence.receipt.configuration._tag === "extraction" && evidence.receipt.configuration.provider !== "meta") return yield* executionFailure("provider-unknown-completion", "Extraction completion cannot be recovered; its existing job must not be submitted again")
        if (uncertain && !request.acknowledgesUnknownCompletion) return yield* executionFailure("provider-unknown-completion", "Retry must acknowledge possible repeated provider work and charges")
        const undispatched = attempt.status === "prepared" && attempt.dispatch_started_at === null && attempt.remote_id === null && evidence.receipt.state._tag === "prepared"
        const safeFailure = evidence.receipt.state._tag === "failed" && evidence.receipt.state.failure.retryable && attempt.actual_microusd === 0
        if (!uncertain && !undispatched && !transient && !safeFailure) return yield* executionFailure("invalid-provider-response", "Permanent provider failure or invalid output cannot be retried")
        if (rows.filter((other) => other.stage_key === attempt.stage_key && other.fingerprint === attempt.fingerprint).length >= previous.configuration.maxProviderAttempts) return yield* executionFailure("limit-exceeded", "The document retry-chain attempt allowance is exhausted")
        if (undispatched) {
          const receipt: StageReceipt = { ...evidence.receipt, state: { _tag: "failed", finishedAt: DateTime.formatIso(DateTime.makeUnsafe(now)), providerRequestId: null, failure: { code: "provider-failed", message: "The prior run stopped before dispatch", retryable: true, stage: evidence.receipt.stage, pageId: null, figureId: null } } }
          yield* database.query("retry-undispatched", () => db.updateTable("provider_attempts").set({ status: "failed", actual_microusd: 0, receipt_json: JSON.stringify(receipt), updated_at: now }).where("id", "=", attempt.id).execute())
          yield* database.query("retry-undispatched", () => db.updateTable("provider_charges").set({ actual_microusd: 0 }).where("attempt_id", "=", attempt.id).execute())
        }
        grants.push(attempt)
      }
      if (grants.length === 0 && (previous.state._tag === "failed" || previous.state._tag === "interrupted") && ["invalid-input", "unsupported-pdf", "encrypted-pdf", "empty-document", "invalid-provider-response"].includes(previous.state.failure.code)) return yield* executionFailure("invalid-provider-response", "This permanent processing failure cannot be retried")
      const needed = grants.reduce((total, attempt) => total + attempt.reserved_microusd, 0)
      const charged = rows.reduce((total, attempt) => total + (attempt.status === "prepared" && attempt.dispatch_started_at === null && attempt.remote_id === null ? 0 : attempt.actual_microusd ?? attempt.reserved_microusd), 0)
      const ledger = yield* database.query("retry-budget", () => db.selectFrom("provider_charges").selectAll().where("budget_id", "=", policy.budgetId).execute())
      const budgetUsed = ledger.reduce((total, charge) => total + (charge.actual_microusd ?? charge.reserved_microusd), 0)
      if (!Number.isSafeInteger(charged + needed) || charged + needed > Math.floor(previous.configuration.spendingCapUsd * 1_000_000) || !Number.isSafeInteger(budgetUsed + needed) || policy.authorizedBudgetMicrousd !== null && budgetUsed + needed > policy.authorizedBudgetMicrousd) return yield* executionFailure("limit-exceeded", "The original retry-chain spending allowance is exhausted")
      const requestId = yield* identifier()
      const run = yield* decode(Run, { ...previous, id: yield* identifier(), mastraRunId: yield* identifier(), createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)), state: { _tag: "queued" } })
      yield* database.query("retry-create-run", () => db.insertInto("runs").values({ id: run.id, document_id: document.id, owner_id: request.ownerId, state: "queued", mastra_run_id: run.mastraRunId ?? "", run_json: JSON.stringify(run), created_at: now, claim_token: null, worker_id: null, lease_expires_at: null }).execute())
      yield* database.query("retry-create-request", () => db.insertInto("retry_requests").values({ id: requestId, owner_id: request.ownerId, document_id: document.id, previous_run_id: previous.id, run_id: run.id, request_key: request.idempotencyKey, acknowledges_unknown: Number(request.acknowledgesUnknownCompletion), budget_id: policy.budgetId, created_at: now }).execute())
      for (const attempt of grants) {
        const authorizationId = yield* identifier()
        yield* database.query("retry-authorize", () => db.insertInto("retry_authorizations").values({ id: authorizationId, request_id: requestId, previous_attempt_id: attempt.id, run_id: run.id, stage_key: attempt.stage_key, fingerprint: attempt.fingerprint, acknowledges_unknown: Number(request.acknowledgesUnknownCompletion), consumed_attempt_id: null }).execute())
      }
      yield* database.query("retry-latest-run", () => db.updateTable("documents").set({ latest_run_id: run.id }).where("id", "=", document.id).where("latest_run_id", "=", previous.id).execute())
      yield* database.query("retry-enqueue", () => db.insertInto("accepted_jobs").values({ run_id: run.id }).execute())
      return AcceptedRun.make({ documentId: document.id, runId: run.id })
    }))
  })
  return RunRecovery.of({ requestRetry })
})
export const makeRunRecoveryLayer = (policy: GuardPolicy, queueLimit: number) => Layer.effect(RunRecovery, makeRunRecovery(policy, queueLimit))
