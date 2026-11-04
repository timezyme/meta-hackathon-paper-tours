import { Clock, Crypto, DateTime, Effect, Equal, Exit, Layer, Schema, Semaphore } from "effect"
import type { Kysely } from "kysely"
import {
  ArtifactHash,
  Document,
  ProviderAttemptId,
  Run,
  StageReceipt,
  stageConfiguration,
  validateReceiptReuse,
  type ReuseRequest,
} from "../domain/index.ts"
import { StorageDatabase, type ApplicationDatabase, type DispatchClaim, type ProviderAttemptRow } from "../storage/index.ts"
import {
  AttemptInput,
  AttemptIntent,
  GuardPolicy,
  ProviderAdapter,
  ProviderGuard,
  ProviderResponse,
  executionFailure,
  type AttemptTicket,
  type ExecutionFailure,
  type GuardError,
  type GuardedResponse,
  type PreparedAttempt,
} from "./contracts.ts"
import {
  chargedMicrousd,
  metaRuntimeConfiguration,
  exceedsStageReservation,
  remainingHeadroomMicrousd,
  processingAvailability,
  runGuardPolicy,
  stageReservation,
} from "./policy.ts"
import { requestFingerprint } from "./fingerprint.ts"
import { bindDocumentPolicy, providerJson as json, providerUnitKey, retrievableMineru } from "./recovery.ts"

const timestamp = (milliseconds: number) => DateTime.formatIso(DateTime.makeUnsafe(milliseconds))
const invalidStored = () => executionFailure("invalid-provider-response", "The saved provider attempt is invalid")
type ReceiptExpectation = ReuseRequest & Pick<StageReceipt, "configuration" | "inputHashes">
const checkExpectedReceipt = Effect.fn("ProviderGuard.checkExpectedReceipt")(function* (
  receipt: StageReceipt,
  expected: ReceiptExpectation,
) {
  const mismatches = validateReceiptReuse(receipt, expected).filter((issue) => issue.path !== "receipt.state")
  if (
    mismatches.length !== 0 ||
    !Equal.equals(receipt.configuration, expected.configuration) ||
    !Equal.equals(receipt.inputHashes, expected.inputHashes)
  )
    return yield* invalidStored()
  return receipt
})
const decodeReceipt = Effect.fn("ProviderGuard.decodeReceipt")(function* (row: ProviderAttemptRow) {
  const receipt = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StageReceipt))(row.receipt_json).pipe(
    Effect.mapError(invalidStored),
  )
  if (
    receipt.id !== row.id ||
    receipt.ownerId !== row.owner_id ||
    receipt.scope.documentId !== row.document_id ||
    receipt.scope.runId !== row.run_id ||
    receipt.requestFingerprint !== row.fingerprint ||
    providerUnitKey(receipt) !== row.stage_key
  )
    return yield* invalidStored()
  return receipt
})
const decodeIntent = (row: ProviderAttemptRow) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AttemptIntent))(row.intent_json).pipe(Effect.mapError(invalidStored))
const rejected = (message: string) => ({
  _tag: "rejected" as const,
  failure: { code: "invalid-provider-response" as const, message, retryable: false, stage: null, pageId: null, figureId: null },
})

export const makeProviderGuard = Effect.fn("makeProviderGuard")(function* (configuration: GuardPolicy) {
  const policy = yield* Schema.decodeUnknownEffect(GuardPolicy)(configuration).pipe(
    Effect.mapError(() => executionFailure("processing-unavailable", "Processing limits are invalid")),
  )
  const database = yield* StorageDatabase
  const slots = yield* Semaphore.make(policy.maxConcurrentCalls)
  const crypto = yield* Crypto.Crypto
  const hash = (value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.map((bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")),
      Effect.mapError(() => executionFailure("provider-failed", "Could not fingerprint the provider input")),
    )
  const fingerprintOf = (run: Run, document: Document, input: AttemptInput, settings: StageReceipt["configuration"]) =>
    requestFingerprint({
      run,
      document,
      unit: input,
      configuration: settings,
      request: input.request,
      supportsIdempotency: input.supportsIdempotency,
      policy,
    }).pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.mapError(invalidStored))
  const available = () => {
    const status = processingAvailability(policy)
    return status.available
      ? Effect.void
      : Effect.fail(executionFailure("processing-unavailable", status.reason ?? "Processing is unavailable"))
  }
  const assertClaim = Effect.fn("ProviderGuard.assertClaim")(function* (
    db: Kysely<ApplicationDatabase>,
    claim: DispatchClaim,
    now: number,
  ) {
    const row = yield* database.query("provider-claim", () =>
      db.selectFrom("runs").selectAll().where("id", "=", claim.run.id).executeTakeFirst(),
    )
    if (
      row === undefined ||
      row.state !== "running" ||
      row.claim_token !== claim.claimToken ||
      row.lease_expires_at === null ||
      row.lease_expires_at <= now
    )
      return yield* executionFailure("conflict", "The processing claim is no longer current")
    const run = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Run))(row.run_json).pipe(Effect.mapError(invalidStored))
    if (policy.mode === "live" && !metaRuntimeConfiguration(run.configuration))
      return yield* executionFailure(
        "processing-unavailable",
        "This runtime permits only Meta model processing; historical non-Meta runs remain readable",
      )
    const documentRow = yield* database.query("provider-document", () =>
      db.selectFrom("documents").selectAll().where("id", "=", run.documentId).executeTakeFirst(),
    )
    if (documentRow === undefined || documentRow.lifecycle !== "active" || documentRow.expires_at <= now)
      return yield* executionFailure("conflict", "The document is no longer available for processing")
    const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Document))(documentRow.document_json).pipe(
      Effect.mapError(invalidStored),
    )
    if (
      run.ownerId !== claim.run.ownerId ||
      run.documentId !== claim.document.id ||
      document.ownerId !== run.ownerId ||
      document.sourceHash !== claim.document.sourceHash ||
      run.mastraRunId === null
    )
      return yield* executionFailure("conflict", "The processing claim does not match the saved run")
    return { run, document }
  })
  const replay = Effect.fn("ProviderGuard.replay")(function* (row: ProviderAttemptRow, expected: ReceiptExpectation) {
    const receipt = yield* decodeReceipt(row).pipe(Effect.flatMap((saved) => checkExpectedReceipt(saved, expected)))
    if (row.status !== "completed" || receipt.state._tag !== "completed" || row.response_json === null) return yield* invalidStored()
    if (row.validation_state === "accepted") {
      if (validateReceiptReuse(receipt, expected).length !== 0) return yield* invalidStored()
    } else if (row.validation_state !== "pending" || receipt.state.validation._tag !== "rejected") return yield* invalidStored()
    const response = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(row.response_json).pipe(
      Effect.mapError(invalidStored),
    )
    const outputHash = yield* hash(json(response))
    if (outputHash !== receipt.state.responseHash) return yield* invalidStored()
    return { delivery: "reused" as const, receipt, response }
  })
  const resolveRetryInput = Effect.fnUntraced(function* (db: Kysely<ApplicationDatabase>, claim: DispatchClaim, raw: AttemptInput) {
    const input = yield* Schema.decodeUnknownEffect(AttemptInput)(raw, { onExcessProperty: "error" }).pipe(Effect.mapError(invalidStored))
    const key = providerUnitKey(input)
    const grants = yield* database.query("retry-lookup", () =>
      db
        .selectFrom("retry_authorizations")
        .innerJoin("retry_requests", "retry_requests.id", "retry_authorizations.request_id")
        .selectAll("retry_authorizations")
        .where("retry_authorizations.run_id", "=", claim.run.id)
        .where("retry_authorizations.stage_key", "=", key)
        .where("retry_requests.owner_id", "=", claim.document.ownerId)
        .where("retry_requests.document_id", "=", claim.document.id)
        .where("retry_requests.budget_id", "=", policy.budgetId)
        .execute(),
    )
    const stageSettings = stageConfiguration(claim.run.configuration, input.stage)
    const fingerprint =
      input.retry._tag === "authorized" || stageSettings === undefined || grants.length === 0
        ? null
        : yield* fingerprintOf(claim.run, claim.document, input, stageSettings)
    const supplied = input.retry
    const authorization =
      grants.find((grant) =>
        supplied._tag === "authorized" ? grant.id === supplied.authorizationId : grant.fingerprint === fingerprint,
      ) ?? grants[0]
    if (authorization === undefined) {
      if (input.retry._tag === "authorized")
        return yield* executionFailure("conflict", "Retry requires a persisted owner-authorized request")
      return input
    }
    if (fingerprint !== null && authorization.fingerprint !== fingerprint) {
      const completed = yield* database.query("retry-completed", () =>
        db
          .selectFrom("provider_attempts")
          .select("id")
          .where("owner_id", "=", claim.document.ownerId)
          .where("document_id", "=", claim.document.id)
          .where("stage_key", "=", key)
          .where("fingerprint", "=", fingerprint)
          .where("status", "=", "completed")
          .executeTakeFirst(),
      )
      if (completed !== undefined) return input
    }
    const retry = {
      _tag: "authorized" as const,
      previousAttemptId: ProviderAttemptId.make(authorization.previous_attempt_id),
      authorizationId: authorization.id,
      acknowledgesUnknownCompletion: authorization.acknowledges_unknown === 1,
    }
    if (input.retry._tag === "authorized" && !Equal.equals(input.retry, retry))
      return yield* executionFailure("conflict", "Retry authorization differs from its persisted request")
    return { ...input, retry }
  })
  const retryInput = (claim: DispatchClaim, raw: AttemptInput) => resolveRetryInput(database.db, claim, raw)
  const prepare = Effect.fn("ProviderGuard.prepare")(function* (
    claim: DispatchClaim,
    supplied: AttemptInput,
  ): Effect.fn.Return<PreparedAttempt, GuardError> {
    yield* available()
    const attemptId = yield* crypto.randomUUIDv4().pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ProviderAttemptId)),
      Effect.mapError(() => executionFailure("provider-failed", "Could not allocate a provider attempt")),
    )
    const reserve = () =>
      database.transaction((db) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const { run, document } = yield* assertClaim(db, claim, now)
          const input = yield* resolveRetryInput(db, claim, supplied)
          if (new TextEncoder().encode(json(input.request)).length > policy.maxRequestBytes)
            return yield* executionFailure("limit-exceeded", "The provider request exceeds its byte limit")
          const providerConfiguration = stageConfiguration(run.configuration, input.stage)
          const reserved = stageReservation(policy, input.stage, input.task)
          if (providerConfiguration === undefined || reserved === undefined)
            return yield* executionFailure(
              "processing-unavailable",
              "This provider stage requires an explicit model configuration and reservation",
            )
          const maxOutputTokens =
            providerConfiguration._tag === "model"
              ? providerConfiguration.maxOutputTokens
              : (providerConfiguration.model?.maxOutputTokens ?? null)
          if (maxOutputTokens !== null && maxOutputTokens > policy.maxOutputTokens)
            return yield* executionFailure("limit-exceeded", "The model output limit exceeds the configured allowance")
          const startedAt = run.state._tag === "running" ? DateTime.toEpochMillis(DateTime.makeUnsafe(run.state.startedAt)) : now
          const deadlineAt = Math.min(startedAt + run.configuration.deadlineMilliseconds, now + policy.callDeadlineMilliseconds)
          if (deadlineAt <= now) return yield* executionFailure("limit-exceeded", "The run deadline has elapsed")
          const fingerprint = yield* fingerprintOf(run, document, input, providerConfiguration)
          const expected: ReceiptExpectation = {
            ownerId: run.ownerId,
            scope: { documentId: document.id, runId: run.id, sourceHash: document.sourceHash },
            pipelineVersion: run.pipelineVersion,
            schemaVersion: run.schemaVersion,
            requestFingerprint: fingerprint,
            stage: input.stage,
            pageIds: input.pageIds,
            figureId: input.figureId,
            ...(input.task === undefined ? {} : { task: input.task }),
            configuration: providerConfiguration,
            inputHashes: input.inputHashes,
          }
          const stageKey = providerUnitKey(input)
          const previous = yield* database.query("provider-attempts", () =>
            db
              .selectFrom("provider_attempts")
              .selectAll()
              .where("owner_id", "=", run.ownerId)
              .where("document_id", "=", document.id)
              .orderBy("created_at", "asc")
              .execute(),
          )
          const sameStage = previous.filter((row) => row.stage_key === stageKey)
          const completedCandidates = sameStage.toReversed().filter((row) => row.fingerprint === fingerprint && row.status === "completed")
          const completed =
            completedCandidates.find((row) => row.validation_state === "accepted") ??
            completedCandidates.find((row) => row.validation_state === "pending") ??
            completedCandidates[0]
          const adopt = Effect.fnUntraced(function* (row: ProviderAttemptRow, receipt: StageReceipt, firstDispatch: boolean) {
            if (row.lease_expires_at > now)
              return yield* executionFailure("conflict", "A previous provider execution lease is still active")
            const active = yield* database.query("provider-concurrency", () =>
              db
                .selectFrom("provider_attempts")
                .select("id")
                .where("status", "in", ["prepared", "dispatching", "submitted", "unknown"])
                .where("lease_expires_at", ">", now)
                .execute(),
            )
            if (active.length >= policy.maxConcurrentCalls) return yield* Effect.fail("provider-busy" as const)
            const intent = { ...(yield* decodeIntent(row)), deadlineAt }
            const changed = yield* database.query("provider-adopt", () =>
              db
                .updateTable("provider_attempts")
                .set({
                  claim_token: claim.claimToken,
                  lease_expires_at: deadlineAt,
                  ...(firstDispatch ? { intent_json: JSON.stringify(intent) } : {}),
                  updated_at: now,
                })
                .where("id", "=", row.id)
                .where("claim_token", "=", row.claim_token)
                .where("status", "=", row.status)
                .where("lease_expires_at", "<=", now)
                .executeTakeFirst(),
            )
            if (changed.numUpdatedRows !== 1n) return yield* executionFailure("conflict", "Another worker adopted this provider attempt")
            return { claim, receipt, intent }
          })
          const reuseOrAdopt = Effect.fnUntraced(function* () {
            if (completed !== undefined)
              return {
                _tag: completed.validation_state === "pending" ? ("validation" as const) : ("reused" as const),
                result: yield* replay(completed, expected),
              }
            yield* bindDocumentPolicy(db, database.query, document.id, runGuardPolicy(policy, run.configuration))
            const prepared = sameStage.find(
              (row) => row.status === "prepared" && row.fingerprint === fingerprint && row.claim_token === claim.claimToken,
            )
            if (prepared !== undefined && prepared.lease_expires_at > now)
              return {
                _tag: "prepared" as const,
                ticket: {
                  claim,
                  receipt: yield* decodeReceipt(prepared).pipe(Effect.flatMap((receipt) => checkExpectedReceipt(receipt, expected))),
                  intent: yield* decodeIntent(prepared),
                },
              }
            const unfinished = sameStage
              .toReversed()
              .find((row) => row.fingerprint === fingerprint && ["prepared", "dispatching", "submitted", "unknown"].includes(row.status))
            if (unfinished !== undefined) {
              const receipt = yield* decodeReceipt(unfinished).pipe(Effect.flatMap((value) => checkExpectedReceipt(value, expected)))
              const firstDispatch =
                unfinished.run_id === run.id &&
                unfinished.status === "prepared" &&
                unfinished.dispatch_started_at === null &&
                unfinished.remote_id === null &&
                receipt.state._tag === "prepared"
              const retrieval = retrievableMineru(receipt)
              if (!firstDispatch && !retrieval)
                return yield* executionFailure(
                  "provider-unknown-completion",
                  "This provider attempt needs explicit acknowledged retry authorization",
                )
              return {
                _tag: firstDispatch ? ("prepared" as const) : ("retrieve" as const),
                ticket: yield* adopt(unfinished, receipt, firstDispatch),
              }
            }
            return null
          })
          let retryHeadroom = input.headroomMicrousd ?? 0
          let consumeAuthorization: Effect.Effect<void, GuardError> = Effect.void
          const planned = yield* Effect.gen(function* (): Effect.fn.Return<PreparedAttempt | null, GuardError | "provider-busy"> {
            const retry = input.retry
            switch (retry._tag) {
              case "none": {
                const existing = yield* reuseOrAdopt()
                if (existing !== null) return existing
                if (sameStage.length > 0)
                  return yield* executionFailure(
                    "provider-unknown-completion",
                    "This stage already has an attempt; explicit retry authorization is required",
                  )
                return null
              }
              case "review": {
                const existing = yield* reuseOrAdopt()
                if (existing !== null) return existing
                const prior = sameStage.find((row) => row.id === retry.previousAttemptId)
                if (
                  prior === undefined ||
                  prior.status !== "completed" ||
                  (prior.validation_state !== "rejected" && prior.validation_state !== "accepted")
                )
                  return yield* executionFailure("conflict", "A Muse review must reference a completed answer for this unit")
                if (sameStage.some((row) => ["dispatching", "submitted", "unknown"].includes(row.status)))
                  return yield* executionFailure("provider-unknown-completion", "This unit has unresolved provider work")
                if (sameStage.length >= run.configuration.maxProviderAttempts)
                  return yield* executionFailure("limit-exceeded", "The stage attempt allowance leaves no room for a Muse review")
                retryHeadroom = retry.headroomMicrousd
                return null
              }
              case "authorized": {
                yield* bindDocumentPolicy(db, database.query, document.id, runGuardPolicy(policy, run.configuration))
                const grant = yield* database.query("retry-check", () =>
                  db
                    .selectFrom("retry_authorizations")
                    .selectAll()
                    .where("id", "=", retry.authorizationId)
                    .where("run_id", "=", run.id)
                    .executeTakeFirst(),
                )
                if (
                  grant === undefined ||
                  grant.previous_attempt_id !== retry.previousAttemptId ||
                  grant.fingerprint !== fingerprint ||
                  grant.stage_key !== stageKey ||
                  grant.acknowledges_unknown !== Number(retry.acknowledgesUnknownCompletion)
                )
                  return yield* executionFailure("conflict", "The persisted retry does not authorize this exact provider input")
                for (const row of sameStage) {
                  const saved = yield* decodeIntent(row)
                  if (saved.retry._tag !== "authorized" || saved.retry.authorizationId !== retry.authorizationId) continue
                  if (saved.retry.previousAttemptId !== retry.previousAttemptId || row.fingerprint !== fingerprint)
                    return yield* executionFailure("conflict", "Retry authorization was already used for different input")
                  if (row.status === "completed")
                    return {
                      _tag: row.validation_state === "pending" ? ("validation" as const) : ("reused" as const),
                      result: yield* replay(row, expected),
                    }
                  if (row.status === "prepared" && row.dispatch_started_at === null && row.remote_id === null) {
                    const receipt = yield* decodeReceipt(row).pipe(Effect.flatMap((value) => checkExpectedReceipt(value, expected)))
                    return {
                      _tag: "prepared" as const,
                      ticket:
                        row.claim_token === claim.claimToken && row.lease_expires_at > now
                          ? { claim, receipt, intent: saved }
                          : yield* adopt(row, receipt, true),
                    }
                  }
                  return yield* executionFailure("provider-unknown-completion", "This authorized retry was already dispatched")
                }
                if (sameStage.length === 0) return yield* executionFailure("conflict", "There is no previous stage attempt to retry")
                const prior = sameStage.find((row) => row.id === retry.previousAttemptId)
                if (prior === undefined)
                  return yield* executionFailure("conflict", "Retry authorization must reference a saved stage attempt")
                if (
                  sameStage.some((row) => ["dispatching", "submitted", "unknown"].includes(row.status)) &&
                  !retry.acknowledgesUnknownCompletion
                )
                  return yield* executionFailure("provider-unknown-completion", "A retry must acknowledge possible repeated provider work")
                if (
                  sameStage.some(
                    (row) => ["prepared", "dispatching", "submitted", "unknown"].includes(row.status) && row.lease_expires_at > now,
                  )
                )
                  return yield* executionFailure("conflict", "A previous stage attempt may still be executing")
                consumeAuthorization = Effect.gen(function* () {
                  const authorizationId = retry.authorizationId
                  const consumed = yield* database.query("retry-consume", () =>
                    db
                      .updateTable("retry_authorizations")
                      .set({ consumed_attempt_id: attemptId })
                      .where("id", "=", authorizationId)
                      .where("run_id", "=", run.id)
                      .where("consumed_attempt_id", "is", null)
                      .executeTakeFirst(),
                  )
                  if (consumed.numUpdatedRows !== 1n)
                    return yield* executionFailure("conflict", "Retry authorization has already been consumed")
                })
                return null
              }
            }
          })
          if (planned !== null) return planned
          if (sameStage.filter((row) => row.fingerprint === fingerprint).length >= run.configuration.maxProviderAttempts)
            return yield* executionFailure("limit-exceeded", "The document retry-chain stage attempt allowance is exhausted")
          if (exceedsStageReservation(policy, input, maxOutputTokens, reserved))
            return yield* executionFailure("limit-exceeded", "The request's worst-case provider charge exceeds its stage reservation")
          let headroom = retryHeadroom
          const pageNumber = input.pageIds.length === 1 ? Number(/^page-([1-9]\d*)$/u.exec(input.pageIds[0] ?? "")?.[1]) : NaN
          if (headroom > 0 && (input.stage === "extraction" || input.task === "figure-crop") && pageNumber <= document.pageCount) {
            const chargedAhead: Array<number> = []
            for (let later = pageNumber + 1; later <= document.pageCount; later += 1) {
              const key = providerUnitKey({ stage: "extraction", pageIds: [`page-${later}`], figureId: null })
              for (const ahead of previous.filter((row) => row.run_id === run.id && row.stage_key === key)) {
                if ((yield* decodeIntent(ahead)).retry._tag === "review") continue
                // SAFETY: Later initial extractions already occupy their serial headroom; their refunds must not fund earlier optional calls.
                chargedAhead.push(Math.min(ahead.actual_microusd ?? ahead.reserved_microusd, policy.maximumCostMicrousd.extraction))
                break
              }
            }
            headroom = remainingHeadroomMicrousd([headroom], chargedAhead)
          }
          const charged = previous.reduce((sum, row) => sum + (row.actual_microusd ?? row.reserved_microusd), 0) + headroom
          const runCap = Math.floor(run.configuration.spendingCapUsd * 1_000_000)
          const cap = Math.min(runCap, policy.authorizedBudgetMicrousd ?? runCap)
          if (!Number.isSafeInteger(charged + reserved) || charged + reserved > cap)
            return yield* executionFailure("limit-exceeded", "The run spending allowance is exhausted, including outstanding charges")
          const ledger = yield* database.query("provider-budget", () =>
            db.selectFrom("provider_charges").selectAll().where("budget_id", "=", policy.budgetId).execute(),
          )
          const budgetUsed = ledger.reduce((sum, charge) => sum + (charge.actual_microusd ?? charge.reserved_microusd), 0) + headroom
          if (
            !Number.isSafeInteger(budgetUsed + reserved) ||
            (policy.authorizedBudgetMicrousd !== null && budgetUsed + reserved > policy.authorizedBudgetMicrousd)
          )
            return yield* executionFailure("limit-exceeded", "The authorized processing budget is exhausted, including outstanding charges")
          const active = yield* database.query("provider-concurrency", () =>
            db
              .selectFrom("provider_attempts")
              .select("id")
              .where("status", "in", ["prepared", "dispatching", "submitted", "unknown"])
              .where("lease_expires_at", ">", now)
              .execute(),
          )
          if (active.length >= policy.maxConcurrentCalls) return yield* Effect.fail("provider-busy" as const)
          const receipt = yield* Schema.decodeUnknownEffect(StageReceipt)({
            id: attemptId,
            ownerId: run.ownerId,
            scope: { documentId: document.id, runId: run.id, sourceHash: document.sourceHash },
            stage: input.stage,
            pageIds: input.pageIds,
            figureId: input.figureId,
            ...(input.task === undefined ? {} : { task: input.task }),
            requestFingerprint: fingerprint,
            inputHashes: input.inputHashes,
            pipelineVersion: run.pipelineVersion,
            schemaVersion: run.schemaVersion,
            configuration: providerConfiguration,
            preparedAt: timestamp(now),
            state: { _tag: "prepared" },
          }).pipe(Effect.mapError(invalidStored))
          const intent: AttemptIntent = {
            request: input.request,
            clientIdempotencyKey: input.supportsIdempotency ? attemptId : null,
            maximumCostMicrousd: reserved,
            maxOutputTokens,
            maxResponseBytes: policy.maxResponseBytes,
            deadlineAt,
            retry: input.retry,
          }
          yield* database.query("provider-prepare", () =>
            db
              .insertInto("provider_attempts")
              .values({
                id: attemptId,
                owner_id: run.ownerId,
                document_id: document.id,
                run_id: run.id,
                stage_key: stageKey,
                fingerprint,
                status: "prepared",
                validation_state: null,
                receipt_json: JSON.stringify(receipt),
                intent_json: JSON.stringify(intent),
                response_json: null,
                claim_token: claim.claimToken,
                lease_expires_at: deadlineAt,
                dispatch_started_at: null,
                remote_id: null,
                reserved_microusd: reserved,
                actual_microusd: null,
                created_at: now,
                updated_at: now,
              })
              .execute(),
          )
          yield* consumeAuthorization
          yield* database.query("provider-reserve", () =>
            db
              .insertInto("provider_charges")
              .values({ attempt_id: attemptId, budget_id: policy.budgetId, reserved_microusd: reserved, actual_microusd: null })
              .execute(),
          )
          return { _tag: "prepared" as const, ticket: { claim, receipt, intent } }
        }),
      )
    while (true) {
      const result = yield* reserve().pipe(Effect.result)
      if (result._tag === "Success") return result.success
      if (result.failure !== "provider-busy") return yield* Effect.fail(result.failure)
      yield* Effect.sleep("100 millis")
    }
  })
  const mutate = Effect.fn("ProviderGuard.mutate")(function* (
    ticket: AttemptTicket,
    work: (row: ProviderAttemptRow, receipt: StageReceipt, now: number) => Effect.Effect<Partial<ProviderAttemptRow>, ExecutionFailure>,
    requireClaim: boolean,
  ) {
    return yield* database.transaction((db) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        if (requireClaim) yield* assertClaim(db, ticket.claim, now)
        else {
          const run = yield* database.query("provider-writer", () =>
            db.selectFrom("runs").select("claim_token").where("id", "=", ticket.claim.run.id).executeTakeFirst(),
          )
          if (run === undefined || (run.claim_token !== null && run.claim_token !== ticket.claim.claimToken))
            return yield* executionFailure("conflict", "A new worker has fenced the previous provider writer")
        }
        const row = yield* database.query("provider-read", () =>
          db
            .selectFrom("provider_attempts")
            .selectAll()
            .where("id", "=", ticket.receipt.id)
            .where("claim_token", "=", ticket.claim.claimToken)
            .executeTakeFirst(),
        )
        if (row === undefined) return yield* executionFailure("conflict", "The provider attempt claim is no longer current")
        const receipt = yield* decodeReceipt(row).pipe(Effect.flatMap((saved) => checkExpectedReceipt(saved, ticket.receipt)))
        const updates = yield* work(row, receipt, now)
        yield* database.query("provider-save", () =>
          db
            .updateTable("provider_attempts")
            .set({ ...updates, updated_at: now })
            .where("id", "=", row.id)
            .where("claim_token", "=", ticket.claim.claimToken)
            .execute(),
        )
        if (updates.actual_microusd !== undefined)
          yield* database.query("provider-charge", () =>
            db.updateTable("provider_charges").set({ actual_microusd: updates.actual_microusd }).where("attempt_id", "=", row.id).execute(),
          )
        return { ...row, ...updates, updated_at: now }
      }),
    )
  })
  const unknown = (ticket: AttemptTicket, reason: string) =>
    mutate(
      ticket,
      (row, receipt, now) =>
        Effect.succeed(
          row.status === "dispatching" || row.status === "submitted"
            ? {
                status: "unknown",
                receipt_json: JSON.stringify({
                  ...receipt,
                  state: { _tag: "unknown-completion", observedAt: timestamp(now), providerRequestId: row.remote_id, reason },
                }),
              }
            : {},
        ),
      false,
    ).pipe(Effect.asVoid)
  const validateSaved = Effect.fn("ProviderGuard.validateSaved")(function* (
    claim: DispatchClaim,
    result: GuardedResponse,
    expected: ReceiptExpectation,
  ) {
    const adapter = yield* ProviderAdapter
    const row = yield* database.query("provider-validation", () =>
      database.db.selectFrom("provider_attempts").selectAll().where("id", "=", result.receipt.id).executeTakeFirst(),
    )
    if (row === undefined || row.owner_id !== claim.run.ownerId || row.document_id !== claim.document.id || row.status !== "completed")
      return yield* invalidStored()
    const saved = yield* replay(row, expected)
    const intent = yield* decodeIntent(row)
    const receipt = saved.receipt
    if (receipt.state._tag !== "completed") return yield* invalidStored()
    const validate = Effect.gen(function* () {
      if (
        new TextEncoder().encode(json(saved.response)).length > intent.maxResponseBytes ||
        (receipt.state._tag === "completed" &&
          receipt.state.usage._tag === "reported" &&
          receipt.state.usage.outputTokens !== null &&
          intent.maxOutputTokens !== null &&
          receipt.state.usage.outputTokens > intent.maxOutputTokens)
      )
        return yield* executionFailure("limit-exceeded", "The provider response exceeds its configured output limit")
      if (row.actual_microusd !== null && row.actual_microusd > intent.maximumCostMicrousd)
        return yield* executionFailure("limit-exceeded", "The provider charge exceeded its reserved maximum")
      yield* adapter.validate(saved.response, receipt)
    })
    const validation = yield* Effect.result(
      validate.pipe(
        Effect.timeoutOrElse({
          duration: policy.callDeadlineMilliseconds,
          orElse: () => Effect.fail(executionFailure("provider-failed", "Local response validation exceeded its deadline")),
        }),
      ),
    )
    if (validation._tag === "Failure" && validation.failure.code === "provider-failed") return yield* validation.failure
    const accepted = yield* database.transaction((db) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* assertClaim(db, claim, now)
        const state = receipt.state
        if (state._tag !== "completed") return yield* invalidStored()
        const updated: StageReceipt = {
          ...receipt,
          state: { ...state, validation: validation._tag === "Success" ? { _tag: "accepted" } : rejected(validation.failure.message) },
        }
        const changed = yield* database.query("provider-validation", () =>
          db
            .updateTable("provider_attempts")
            .set({
              validation_state: validation._tag === "Success" ? "accepted" : "rejected",
              receipt_json: JSON.stringify(updated),
              updated_at: now,
            })
            .where("id", "=", row.id)
            .where("response_json", "=", row.response_json)
            .where("receipt_json", "=", row.receipt_json)
            .where("validation_state", "=", row.validation_state)
            .executeTakeFirst(),
        )
        if (changed.numUpdatedRows !== 1n)
          return yield* executionFailure("conflict", "The saved provider response changed during validation")
        return updated
      }),
    )
    if (validation._tag === "Failure") return yield* validation.failure
    return { ...result, receipt: accepted, response: saved.response }
  })
  const complete = Effect.fn("ProviderGuard.complete")(function* (
    ticket: AttemptTicket,
    response: ProviderResponse,
    allowed: ReadonlyArray<string>,
  ) {
    const responseJson = json(response.response)
    const responseHash = yield* hash(responseJson).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ArtifactHash)),
      Effect.mapError(invalidStored),
    )
    const raw = yield* mutate(
      ticket,
      (row, receipt, now) => {
        if (!allowed.includes(row.status))
          return Effect.fail(executionFailure("conflict", "The provider result arrived after its attempt stopped"))
        return Effect.succeed({
          status: "completed",
          validation_state: "pending",
          response_json: responseJson,
          actual_microusd: chargedMicrousd(policy, receipt.configuration, response),
          receipt_json: JSON.stringify({
            ...receipt,
            state: {
              _tag: "completed",
              finishedAt: timestamp(now),
              providerRequestId: row.remote_id,
              responseHash,
              durationMilliseconds: now - (row.dispatch_started_at ?? now),
              usage: response.usage,
              validation: rejected("The saved response has not passed stage validation"),
            },
          }),
        })
      },
      false,
    )
    const receipt = yield* decodeReceipt(raw)
    return yield* validateSaved(
      ticket.claim,
      { delivery: receipt.scope.runId === ticket.claim.run.id ? "performed" : "reused", receipt, response: response.response },
      ticket.receipt,
    )
  })
  const dispatch = Effect.fn("ProviderGuard.dispatch")(function* (
    ticket: AttemptTicket,
  ): Effect.fn.Return<GuardedResponse, GuardError, ProviderAdapter> {
    yield* available()
    const adapter = yield* ProviderAdapter
    const started = yield* mutate(
      ticket,
      (row, receipt, now) => {
        if (
          policy.mode === "live" &&
          (!metaRuntimeConfiguration(ticket.claim.run.configuration) || receipt.configuration.provider !== "meta")
        )
          return Effect.fail(executionFailure("processing-unavailable", "This runtime permits only Meta model dispatch"))
        return row.status !== "prepared" || row.lease_expires_at <= now
          ? Effect.fail(executionFailure("provider-unknown-completion", "This provider attempt cannot be dispatched again"))
          : Effect.succeed({ status: "dispatching", dispatch_started_at: now })
      },
      true,
    )
    const intent = yield* decodeIntent(started)
    const submitted = (providerRequestId: string) =>
      Schema.decodeUnknownEffect(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)))(providerRequestId).pipe(
        Effect.mapError(() => executionFailure("invalid-provider-response", "The provider request ID is invalid")),
        Effect.flatMap((remoteId) =>
          mutate(
            ticket,
            (row, receipt, now) => {
              if (row.remote_id !== null && row.remote_id !== remoteId)
                return Effect.fail(executionFailure("conflict", "The provider request ID changed"))
              if (!["dispatching", "submitted", "unknown"].includes(row.status))
                return Effect.fail(executionFailure("conflict", "The provider attempt is already terminal"))
              return Effect.succeed({
                status: "submitted",
                remote_id: remoteId,
                receipt_json: JSON.stringify({
                  ...receipt,
                  state: { _tag: "submitted", submittedAt: timestamp(now), providerRequestId: remoteId },
                }),
              })
            },
            false,
          ),
        ),
        Effect.asVoid,
      )
    const invoke = Effect.gen(function* () {
      const preparedReceipt = yield* decodeReceipt(started)
      const response = yield* adapter.invoke({ attemptId: ticket.receipt.id, receipt: preparedReceipt, intent, submitted }).pipe(
        Effect.catchTag("ProviderFailure", (error) =>
          error.certainty === "not-submitted"
            ? mutate(
                ticket,
                (row, receipt, now) =>
                  row.remote_id === null && row.status === "dispatching"
                    ? Effect.succeed({
                        status: "failed",
                        actual_microusd: 0,
                        receipt_json: JSON.stringify({
                          ...receipt,
                          state: {
                            _tag: "failed",
                            finishedAt: timestamp(now),
                            providerRequestId: null,
                            failure: {
                              code: "provider-failed",
                              message: error.message,
                              retryable: false,
                              stage: receipt.stage,
                              pageId: null,
                              figureId: null,
                            },
                          },
                        }),
                      })
                    : Effect.fail(executionFailure("provider-unknown-completion", "Provider acceptance was already recorded")),
                false,
              ).pipe(Effect.andThen(Effect.fail(executionFailure("provider-failed", error.message))))
            : Effect.fail(executionFailure("provider-unknown-completion", error.message)),
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(ProviderResponse)),
        Effect.mapError((error) =>
          error._tag === "SchemaError"
            ? executionFailure("invalid-provider-response", "The provider returned an invalid response envelope")
            : error,
        ),
      )
      return yield* complete(ticket, response, ["dispatching", "submitted"])
    })
    const now = yield* Clock.currentTimeMillis
    return yield* invoke.pipe(
      Effect.timeoutOrElse({
        duration: Math.max(0, intent.deadlineAt - now),
        orElse: () =>
          Effect.fail(executionFailure("provider-unknown-completion", "The provider deadline elapsed; remote completion is unknown")),
      }),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? unknown(ticket, "Execution ended without a durable accepted response") : Effect.void,
      ),
    )
  })
  const retrieve = Effect.fn("ProviderGuard.retrieve")(function* (ticket: AttemptTicket) {
    if (policy.mode === "live")
      return yield* executionFailure("processing-unavailable", "Historical non-Meta provider retrieval is disabled in this runtime")
    const adapter = yield* ProviderAdapter
    const get = adapter.retrieve
    if (get === undefined || !retrievableMineru(ticket.receipt))
      return yield* executionFailure("provider-unknown-completion", "This provider has no safe saved-job retrieval method")
    const now = yield* Clock.currentTimeMillis
    return yield* Effect.gen(function* () {
      yield* mutate(ticket, () => Effect.succeed({}), true)
      const response = yield* get(ticket.receipt).pipe(
        Effect.catchTag("ProviderFailure", () =>
          Effect.fail(executionFailure("provider-unknown-completion", "The existing extraction job could not be retrieved")),
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(ProviderResponse)),
        Effect.mapError((error) => (error._tag === "SchemaError" ? invalidStored() : error)),
      )
      return yield* complete(ticket, response, ["submitted", "unknown"])
    }).pipe(
      Effect.timeoutOrElse({
        duration: Math.max(0, ticket.intent.deadlineAt - now),
        orElse: () =>
          Effect.fail(executionFailure("provider-unknown-completion", "Retrieval deadline elapsed; the original job remains unresolved")),
      }),
    )
  })
  const execute = Effect.fn("ProviderGuard.execute")(function* (claim: DispatchClaim, input: AttemptInput) {
    const prepared = yield* prepare(claim, input)
    if (prepared._tag === "prepared") return yield* dispatch(prepared.ticket)
    if (prepared._tag === "retrieve") return yield* retrieve(prepared.ticket)
    return prepared._tag === "validation" ? yield* validateSaved(claim, prepared.result, prepared.result.receipt) : prepared.result
  }, slots.withPermit)
  const savedRejection = Effect.fn("ProviderGuard.rejected")(function* (claim: DispatchClaim, raw: AttemptInput) {
    const input = yield* Schema.decodeUnknownEffect(AttemptInput)(raw, { onExcessProperty: "error" }).pipe(Effect.mapError(invalidStored))
    const stageSettings = stageConfiguration(claim.run.configuration, input.stage)
    if (stageSettings === undefined) return null
    const fingerprint = yield* fingerprintOf(claim.run, claim.document, input, stageSettings)
    const stageKey = providerUnitKey(input)
    const row = yield* database.query("provider-rejected", () =>
      database.db
        .selectFrom("provider_attempts")
        .selectAll()
        .where("owner_id", "=", claim.document.ownerId)
        .where("document_id", "=", claim.document.id)
        .where("stage_key", "=", stageKey)
        .where("fingerprint", "=", fingerprint)
        .where("status", "=", "completed")
        .where("validation_state", "=", "rejected")
        .orderBy("created_at", "desc")
        .executeTakeFirst(),
    )
    if (row === undefined) return null
    const expected: ReceiptExpectation = {
      ownerId: claim.run.ownerId,
      scope: { documentId: claim.document.id, runId: claim.run.id, sourceHash: claim.document.sourceHash },
      pipelineVersion: claim.run.pipelineVersion,
      schemaVersion: claim.run.schemaVersion,
      requestFingerprint: fingerprint,
      stage: input.stage,
      pageIds: input.pageIds,
      figureId: input.figureId,
      ...(input.task === undefined ? {} : { task: input.task }),
      configuration: stageSettings,
      inputHashes: input.inputHashes,
    }
    const receipt = yield* decodeReceipt(row).pipe(Effect.flatMap((saved) => checkExpectedReceipt(saved, expected)))
    if (receipt.state._tag !== "completed" || receipt.state.validation._tag !== "rejected" || row.response_json === null)
      return yield* invalidStored()
    const response = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(row.response_json).pipe(
      Effect.mapError(invalidStored),
    )
    if ((yield* hash(json(response))) !== receipt.state.responseHash) return yield* invalidStored()
    return { delivery: receipt.scope.runId === claim.run.id ? ("performed" as const) : ("reused" as const), receipt, response }
  })
  const reconcile = Effect.fn("ProviderGuard.reconcile")(function* () {
    return yield* database.transaction((db) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const rows = yield* database.query("provider-reconcile", () =>
          db
            .selectFrom("provider_attempts")
            .selectAll()
            .where("status", "in", ["dispatching", "submitted"])
            .where("lease_expires_at", "<=", now)
            .execute(),
        )
        for (const row of rows) {
          const receipt = yield* decodeReceipt(row)
          yield* database.query("provider-reconcile", () =>
            db
              .updateTable("provider_attempts")
              .set({
                status: "unknown",
                updated_at: now,
                receipt_json: JSON.stringify({
                  ...receipt,
                  state: {
                    _tag: "unknown-completion",
                    observedAt: timestamp(now),
                    providerRequestId: row.remote_id,
                    reason: "The worker stopped before saving a response",
                  },
                }),
              })
              .where("id", "=", row.id)
              .execute(),
          )
        }
        return rows.length
      }),
    )
  })
  return ProviderGuard.of({ retryInput, prepare, dispatch, execute, rejected: savedRejection, reconcile })
})

export const makeProviderGuardLayer = (policy: GuardPolicy) => Layer.effect(ProviderGuard, makeProviderGuard(policy))
