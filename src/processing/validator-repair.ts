import { Clock, Crypto, DateTime, Effect, Result, Schema } from "effect"
import { AcceptedRun, ArtifactHash, Document, DocumentId, ProviderAttemptId, Run, RunId, StageReceipt, UserId, stageConfiguration } from "../domain/index.ts"
import { StorageDatabase } from "../storage/database.ts"
import { AttemptIntent, GuardPolicy, executionFailure, type ExecutionFailure } from "./contracts.ts"
import { providerJson as json } from "./recovery.ts"

export const ValidatorRepairRequest = Schema.Struct({
  ownerId: UserId, documentId: DocumentId, previousRunId: RunId, attemptId: ProviderAttemptId, responseHash: ArtifactHash,
  validatorFixId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u)), validatorFixHash: ArtifactHash,
})
export type ValidatorRepairRequest = typeof ValidatorRepairRequest.Type
export interface RepairEvidence {
  readonly document: Document
  readonly run: Run
  readonly receipt: StageReceipt
  readonly intent: AttemptIntent
  readonly response: Schema.Json
}
export type ValidateRepair = (evidence: RepairEvidence) => Result.Result<void, ExecutionFailure>
const conflict = (message: string) => executionFailure("conflict", message)
const invalid = () => executionFailure("invalid-provider-response", "The saved validator-repair evidence is invalid")
const decode = <A>(schema: Schema.Codec<A, unknown>, value: unknown) => Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(Effect.mapError(invalid))

export const makeValidatorRepair = Effect.fn("makeValidatorRepair")(function* (configuration: GuardPolicy, queueLimit: number) {
  const policy = yield* decode(GuardPolicy, configuration)
  yield* decode(Schema.Int.check(Schema.isGreaterThan(0)), queueLimit)
  const database = yield* StorageDatabase
  const crypto = yield* Crypto.Crypto
  const hash = (value: Schema.Json) => crypto.digest("SHA-256", new TextEncoder().encode(json(value))).pipe(Effect.map((bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")), Effect.mapError(invalid))
  const identifier = () => crypto.randomUUIDv4().pipe(Effect.mapError(invalid))

  const repair = Effect.fn("ValidatorRepair.repair")(function* (raw: ValidatorRepairRequest, validateSaved: ValidateRepair) {
    const request = yield* decode(ValidatorRepairRequest, raw)
    return yield* database.transaction((db) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const documentRow = yield* database.query("repair-document", () => db.selectFrom("documents").selectAll().where("id", "=", request.documentId).where("owner_id", "=", request.ownerId).where("lifecycle", "=", "active").where("expires_at", ">", now).executeTakeFirst())
      const runRow = yield* database.query("repair-run", () => db.selectFrom("runs").selectAll().where("id", "=", request.previousRunId).where("owner_id", "=", request.ownerId).where("document_id", "=", request.documentId).executeTakeFirst())
      const row = yield* database.query("repair-attempt", () => db.selectFrom("provider_attempts").selectAll().where("id", "=", request.attemptId).where("owner_id", "=", request.ownerId).where("document_id", "=", request.documentId).where("run_id", "=", request.previousRunId).executeTakeFirst())
      if (documentRow === undefined || runRow === undefined || row === undefined) return yield* conflict("The requested document, run, or provider attempt is unavailable")
      const document = yield* decode(Schema.fromJsonString(Document), documentRow.document_json)
      const run = yield* decode(Schema.fromJsonString(Run), runRow.run_json)
      const receipt = yield* decode(Schema.fromJsonString(StageReceipt), row.receipt_json)
      const intent = yield* decode(Schema.fromJsonString(AttemptIntent), row.intent_json)
      if (row.status !== "completed" || receipt.state._tag !== "completed" || row.response_json === null) return yield* conflict("Only a complete saved provider response can be revalidated")
      const response = yield* decode(Schema.fromJsonString(Schema.Json), row.response_json)
      if (document.id !== request.documentId || document.ownerId !== request.ownerId || document.lifecycle._tag !== "active" || DateTime.toEpochMillis(DateTime.makeUnsafe(document.expiresAt)) !== documentRow.expires_at || run.id !== request.previousRunId || run.documentId !== document.id || run.ownerId !== document.ownerId || run.mastraRunId !== runRow.mastra_run_id || run.state._tag !== runRow.state || receipt.id !== row.id || receipt.ownerId !== document.ownerId || receipt.scope.documentId !== document.id || receipt.scope.runId !== run.id || receipt.scope.sourceHash !== document.sourceHash || receipt.pipelineVersion !== run.pipelineVersion || receipt.schemaVersion !== run.schemaVersion || receipt.requestFingerprint !== row.fingerprint || json({ stage: receipt.stage, pageIds: receipt.pageIds.toSorted(), figureId: receipt.figureId }) !== row.stage_key) return yield* invalid()
      const binding = yield* database.query("repair-policy", () => db.selectFrom("document_policies").selectAll().where("document_id", "=", document.id).executeTakeFirst())
      if (binding === undefined) return yield* conflict("Historical processing policy must be reconciled before validator repair")
      const originalPolicy = yield* decode(Schema.fromJsonString(GuardPolicy), binding.policy_json)
      if (binding.budget_id !== policy.budgetId || json(originalPolicy) !== json(policy)) return yield* conflict("Validator repair must retain the original processing policy and budget")
      const expectedConfiguration = stageConfiguration(run.configuration, receipt.stage)
      const maxOutputTokens = expectedConfiguration._tag === "model" ? expectedConfiguration.maxOutputTokens : expectedConfiguration.model?.maxOutputTokens ?? null
      if (json(receipt.configuration) !== json(expectedConfiguration) || intent.maxOutputTokens !== maxOutputTokens || maxOutputTokens !== null && maxOutputTokens > policy.maxOutputTokens || intent.maxResponseBytes !== policy.maxResponseBytes || intent.maximumCostMicrousd !== policy.maximumCostMicrousd[receipt.stage] || row.reserved_microusd !== intent.maximumCostMicrousd || intent.clientIdempotencyKey !== null && intent.clientIdempotencyKey !== receipt.id) return yield* invalid()
      const fingerprint = yield* hash({ ownerId: run.ownerId, documentId: document.id, sourceHash: document.sourceHash, pipelineVersion: run.pipelineVersion, schemaVersion: run.schemaVersion, stage: receipt.stage, pageIds: receipt.pageIds, figureId: receipt.figureId, inputHashes: receipt.inputHashes, configuration: receipt.configuration, request: intent.request, supportsIdempotency: intent.clientIdempotencyKey !== null, maxResponseBytes: policy.maxResponseBytes, callDeadlineMilliseconds: policy.callDeadlineMilliseconds })
      if (fingerprint !== receipt.requestFingerprint || (yield* hash(response)) !== request.responseHash || receipt.state.responseHash !== request.responseHash) return yield* invalid()
      if (new TextEncoder().encode(json(intent.request)).length > policy.maxRequestBytes || new TextEncoder().encode(json(response)).length > intent.maxResponseBytes || receipt.state.usage._tag === "reported" && receipt.state.usage.outputTokens !== null && maxOutputTokens !== null && receipt.state.usage.outputTokens > maxOutputTokens || row.actual_microusd !== null && row.actual_microusd > row.reserved_microusd) return yield* invalid()
      const charge = yield* database.query("repair-charge", () => db.selectFrom("provider_charges").selectAll().where("attempt_id", "=", row.id).executeTakeFirst())
      if (charge === undefined || charge.budget_id !== policy.budgetId || charge.actual_microusd !== row.actual_microusd || charge.reserved_microusd !== row.reserved_microusd) return yield* invalid()
      const audit = yield* database.query("repair-existing", () => db.selectFrom("validator_repairs").selectAll().where("attempt_id", "=", row.id).executeTakeFirst())
      if (audit !== undefined) {
        if (audit.owner_id !== request.ownerId || audit.document_id !== request.documentId || audit.previous_run_id !== request.previousRunId || audit.response_hash !== request.responseHash || audit.request_fingerprint !== fingerprint || audit.validator_fix_id !== request.validatorFixId || audit.validator_fix_hash !== request.validatorFixHash || audit.new_receipt_json !== row.receipt_json || json(yield* decode(Schema.fromJsonString(GuardPolicy), audit.policy_json)) !== json(policy) || row.validation_state !== "accepted" || receipt.state.validation._tag !== "accepted") return yield* conflict("This response already has a different validator repair")
        const old = yield* decode(Schema.fromJsonString(StageReceipt), audit.old_receipt_json)
        if (old.state._tag !== "completed" || old.state.validation._tag !== "rejected" || json({ ...old, state: { ...old.state, validation: { _tag: "accepted" } } }) !== json(receipt)) return yield* invalid()
        const lineage = yield* database.query("repair-lineage", () => db.selectFrom("retry_requests").selectAll().where("run_id", "=", audit.run_id).where("previous_run_id", "=", run.id).where("document_id", "=", document.id).where("owner_id", "=", run.ownerId).where("budget_id", "=", policy.budgetId).executeTakeFirst())
        if (lineage === undefined) return yield* invalid()
        return yield* decode(AcceptedRun, { documentId: document.id, runId: audit.run_id })
      }
      if (documentRow.latest_run_id !== run.id || runRow.state !== "failed" || run.state._tag !== "failed" || run.state.failure.code !== "invalid-provider-response" || runRow.claim_token !== null || runRow.worker_id !== null || runRow.lease_expires_at !== null || row.validation_state !== "rejected" || receipt.state.validation._tag !== "rejected" || receipt.state.validation.failure.code !== "invalid-provider-response") return yield* conflict("Only the latest failed run's rejected response can be repaired")
      const history = yield* database.query("repair-history", () => db.selectFrom("runs").select((expression) => expression.fn.countAll<number>().as("count")).where("document_id", "=", document.id).where("owner_id", "=", document.ownerId).executeTakeFirstOrThrow())
      if (history.count > Math.min(run.configuration.maxProviderAttempts, 999)) return yield* executionFailure("limit-exceeded", "The document retry-run allowance is exhausted")
      const active = yield* database.query("repair-admission", () => db.selectFrom("runs").select("id").where("owner_id", "=", document.ownerId).where("state", "in", ["queued", "running"]).executeTakeFirst())
      const queued = yield* database.query("repair-admission", () => db.selectFrom("runs").select((expression) => expression.fn.countAll<number>().as("count")).where("state", "=", "queued").executeTakeFirstOrThrow())
      const executing = yield* database.query("repair-lease", () => db.selectFrom("provider_attempts").select("id").where("document_id", "=", document.id).where("status", "in", ["prepared", "dispatching", "submitted", "unknown"]).where("lease_expires_at", ">", now).executeTakeFirst())
      if (active !== undefined || queued.count >= queueLimit || executing !== undefined) return yield* conflict("Processing admission or a provider execution lease prevents validator repair")
      const evidence = { document, run, receipt, intent, response }
      const before = json(evidence)
      const validation = yield* Effect.try({ try: () => validateSaved(evidence), catch: invalid })
      yield* Effect.fromResult(validation)
      if (json(evidence) !== before) return yield* invalid()
      const runId = yield* identifier()
      const mastraRunId = yield* identifier()
      const requestId = yield* identifier()
      const repairedAt = yield* Clock.currentTimeMillis
      if (repairedAt >= documentRow.expires_at) return yield* conflict("The document expired before validator repair completed")
      const acceptedReceipt: StageReceipt = { ...receipt, state: { ...receipt.state, validation: { _tag: "accepted" } } }
      const fresh = yield* decode(Run, { ...run, id: runId, mastraRunId, createdAt: DateTime.formatIso(DateTime.makeUnsafe(repairedAt)), state: { _tag: "queued" } })
      const changed = yield* database.query("repair-receipt", () => db.updateTable("provider_attempts").set({ receipt_json: JSON.stringify(acceptedReceipt), validation_state: "accepted", updated_at: repairedAt }).where("id", "=", row.id).where("status", "=", "completed").where("validation_state", "=", "rejected").where("receipt_json", "=", row.receipt_json).where("response_json", "=", row.response_json).where("intent_json", "=", row.intent_json).executeTakeFirst())
      if (changed.numUpdatedRows !== 1n) return yield* conflict("The saved response changed before validator repair")
      yield* database.query("repair-new-run", () => db.insertInto("runs").values({ id: fresh.id, document_id: document.id, owner_id: document.ownerId, state: "queued", mastra_run_id: fresh.mastraRunId ?? "", run_json: JSON.stringify(fresh), created_at: repairedAt, claim_token: null, worker_id: null, lease_expires_at: null }).execute())
      yield* database.query("repair-request", () => db.insertInto("retry_requests").values({ id: requestId, owner_id: document.ownerId, document_id: document.id, previous_run_id: run.id, run_id: fresh.id, request_key: requestId, acknowledges_unknown: 0, budget_id: policy.budgetId, created_at: repairedAt }).execute())
      yield* database.query("repair-audit", () => db.insertInto("validator_repairs").values({ attempt_id: receipt.id, owner_id: document.ownerId, document_id: document.id, previous_run_id: run.id, run_id: fresh.id, response_hash: request.responseHash, request_fingerprint: fingerprint, validator_fix_id: request.validatorFixId, validator_fix_hash: request.validatorFixHash, old_receipt_json: row.receipt_json, new_receipt_json: JSON.stringify(acceptedReceipt), policy_json: binding.policy_json, repaired_at: repairedAt }).execute())
      const latest = yield* database.query("repair-latest-run", () => db.updateTable("documents").set({ latest_run_id: fresh.id }).where("id", "=", document.id).where("latest_run_id", "=", run.id).where("lifecycle", "=", "active").executeTakeFirst())
      if (latest.numUpdatedRows !== 1n) return yield* conflict("The current document run changed during validator repair")
      yield* database.query("repair-enqueue", () => db.insertInto("accepted_jobs").values({ run_id: fresh.id }).execute())
      return AcceptedRun.make({ documentId: document.id, runId: fresh.id })
    }))
  })
  return { repair }
})
