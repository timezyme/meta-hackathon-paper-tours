import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Crypto, DateTime, Effect, FileSystem, Layer, Result, Schema } from "effect"
import { Document, Run, StageReceipt } from "../../src/domain/index.ts"
import { AttemptInput, AttemptIntent, ProviderAdapter, ProviderGuard, executionFailure, makeProviderGuardLayer, type GuardPolicy } from "../../src/processing/index.ts"
import { makeValidatorRepair, ValidatorRepairRequest, type ValidateRepair } from "../../src/processing/validator-repair.ts"
import { Admission, DocumentStore, StorageDatabase, makeDocumentStoreLayer, type StorageOptions } from "../../src/storage/index.ts"
import { storageFailure } from "../../src/storage/service.ts"

const policy: GuardPolicy = { mode: "fixture", enabled: true, metaCredentialConfigured: false, mineruCredentialConfigured: false, mineruEndpoint: null, budgetId: "repair-budget", authorizedBudgetMicrousd: 1_000_000, maximumCostMicrousd: { extraction: 100_000, "page-check": 100_000, headings: 100_000, figures: 100_000 }, maxConcurrentCalls: 1, maxOutputTokens: 1000, maxRequestBytes: 10_000, maxResponseBytes: 10_000, callDeadlineMilliseconds: 1000 }
const model = { provider: "fixture", model: "offline", reasoning: "high", promptName: "check", promptVersion: "1", maxOutputTokens: 1000 }
const admission = (ownerId = "repair-reader") => Schema.decodeUnknownEffect(Admission)({ ownerId, idempotencyKey: "upload", originalFilename: "source.pdf", bytes: new TextEncoder().encode("%PDF-1.7 offline"), pageCount: 2, pipelineVersion: "1", configuration: { extractionProvider: "fixture", extractionVersion: "1", pageCheck: model, headings: model, figures: model, maxProviderAttempts: 3, deadlineMilliseconds: 100_000, spendingCapUsd: 1 } })
const input = (page = "page-1") => Schema.decodeUnknownEffect(AttemptInput)({ stage: "page-check", pageIds: [page], figureId: null, inputHashes: ["a".repeat(64)], request: { page, text: "Retained François α" }, supportsIdempotency: false, retry: { _tag: "none" } })
const cropInput = Schema.decodeUnknownEffect(AttemptInput)({
  stage: "figures", task: "figure-crop", pageIds: ["page-1"], figureId: "figure-page-1-block-3",
  inputHashes: ["a".repeat(64), "b".repeat(64)], request: { figure: "figure-page-1-block-3", round: 1 },
  supportsIdempotency: false, retry: { _tag: "none" },
})
const stop = (claim: Parameters<DocumentStore["Service"]["updateRun"]>[0]) => Effect.gen(function* () { return yield* (yield* DocumentStore).updateRun(claim, { _tag: "failed", finishedAt: DateTime.formatIso(yield* DateTime.now), failure: { code: "invalid-provider-response", message: "Old validator rejected a valid join", retryable: false, stage: "page-check", pageId: null, figureId: null } }) })
const accept: ValidateRepair = ({ response, receipt }) => response !== null && receipt.stage === "page-check" ? Result.succeed(undefined) : Result.fail(executionFailure("invalid-provider-response", "Still invalid"))
const acceptCrop: ValidateRepair = ({ receipt }) => receipt.task === "figure-crop"
  ? Result.succeed(undefined) : Result.fail(executionFailure("invalid-provider-response", "Still invalid"))
const fixture = (extraInFlight = false, attempt = input()) => Effect.gen(function* () {
  const store = yield* DocumentStore
  yield* store.admit(yield* admission())
  const claim = yield* store.claimNext({ workerId: "repair-worker", leaseMilliseconds: 10_000 })
  if (claim === null) return yield* Effect.die("Expected work")
  const guard = yield* ProviderGuard
  const submitted = yield* attempt
  expect(yield* Effect.result(guard.execute(claim, submitted))).toMatchObject({ _tag: "Failure", failure: { code: "invalid-provider-response" } })
  if (extraInFlight) yield* guard.prepare(claim, yield* input("page-2"))
  yield* stop(claim)
  const { db, query } = yield* StorageDatabase
  const row = yield* query("fixture", () => db.selectFrom("provider_attempts").selectAll().where("validation_state", "=", "rejected").executeTakeFirstOrThrow())
  const receipt = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StageReceipt))(row.receipt_json)
  if (receipt.state._tag !== "completed") return yield* Effect.die("Expected complete saved response")
  const request = yield* Schema.decodeUnknownEffect(ValidatorRepairRequest)({ ownerId: claim.document.ownerId, documentId: claim.document.id, previousRunId: claim.run.id, attemptId: row.id, responseHash: receipt.state.responseHash, validatorFixId: "page-join-furniture-1", validatorFixHash: "f".repeat(64) })
  return { claim, row, receipt, request, submitted }
})
const snapshot = Effect.gen(function* () {
  const { db, query } = yield* StorageDatabase
  return {
    attempts: yield* query("fixture", () => db.selectFrom("provider_attempts").selectAll().orderBy("id").execute()),
    charges: yield* query("fixture", () => db.selectFrom("provider_charges").selectAll().orderBy("attempt_id").execute()),
    runs: yield* query("fixture", () => db.selectFrom("runs").selectAll().orderBy("id").execute()),
    documents: yield* query("fixture", () => db.selectFrom("documents").selectAll().orderBy("id").execute()),
    policies: yield* query("fixture", () => db.selectFrom("document_policies").selectAll().execute()),
    audits: yield* query("fixture", () => db.selectFrom("validator_repairs").selectAll().execute()),
    retries: yield* query("fixture", () => db.selectFrom("retry_requests").selectAll().execute()),
    grants: yield* query("fixture", () => db.selectFrom("retry_authorizations").selectAll().execute()),
    jobs: yield* query("fixture", () => db.selectFrom("accepted_jobs").selectAll().orderBy("run_id").execute()),
  }
})
const withFixture = <A, E>(work: Effect.Effect<A, E, DocumentStore | ProviderGuard | StorageDatabase | ProviderAdapter | Crypto.Crypto>) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const options: StorageOptions = { dataDirectory: yield* fs.makeTempDirectoryScoped(), queueLimit: 5 }
  let calls = 0
  const provider = Layer.succeed(ProviderAdapter, {
    invoke: () => Effect.sync(() => { calls += 1; return { response: { preserved: "Saved Unicode α", joins: [] }, usage: { _tag: "unavailable" as const, reason: "Offline fixture" }, actualCostMicrousd: 70_000 } }),
    validate: () => Effect.fail(executionFailure("invalid-provider-response", "Old validator rejected a valid join")),
  })
  const value = yield* work.pipe(Effect.provide(Layer.merge(makeProviderGuardLayer(policy), provider).pipe(Layer.provideMerge(makeDocumentStoreLayer(options)))))
  expect(calls).toBe(1)
  return value
}).pipe(Effect.provide(NodeServices.layer))

describe("local saved-response validator repair", () => {
  for (const withGuidePolicy of [false, true]) it.effect(`atomically audits and replays a repair without a new call or charge under ${withGuidePolicy ? "new guide-capable" : "historical"} policy`, () => withFixture(Effect.gen(function* () {
    const saved = yield* fixture()
    const before = yield* snapshot
    const helper = yield* makeValidatorRepair(withGuidePolicy ? { ...policy, maximumCostMicrousd: { ...policy.maximumCostMicrousd, guide: 100_000 } } : policy, 5)
    let validations = 0
    const validator: ValidateRepair = (evidence) => { validations += 1; expect(evidence.receipt).toEqual(saved.receipt); expect(evidence.intent.request).toEqual(saved.submitted.request); return accept(evidence) }
    const results = yield* Effect.all(Array.from({ length: 5 }, () => helper.repair(saved.request, validator)), { concurrency: "unbounded" })
    const accepted = results[0]
    expect(new Set(results.map((result) => result.runId)).size).toBe(1)
    expect(validations).toBe(1)
    const after = yield* snapshot
    expect(after.charges).toEqual(before.charges)
    expect(after.policies).toEqual(before.policies)
    expect(after.grants).toEqual([])
    expect(after.attempts).toHaveLength(1)
    expect(after.attempts[0]).toMatchObject({ response_json: saved.row.response_json, intent_json: saved.row.intent_json, fingerprint: saved.row.fingerprint, actual_microusd: 70_000, reserved_microusd: 100_000, validation_state: "accepted" })
    expect(after.audits).toHaveLength(1)
    expect(after.audits[0]).toMatchObject({ old_receipt_json: saved.row.receipt_json, new_receipt_json: after.attempts[0]?.receipt_json, response_hash: saved.request.responseHash, request_fingerprint: saved.row.fingerprint, validator_fix_id: saved.request.validatorFixId, validator_fix_hash: saved.request.validatorFixHash, previous_run_id: saved.claim.run.id, run_id: accepted?.runId })
    const current = yield* (yield* DocumentStore).claimNext({ workerId: "new-worker", leaseMilliseconds: 10_000 })
    if (current === null) return yield* Effect.die("Expected repaired run")
    expect(current.run.id).toBe(accepted?.runId)
    expect(current.run.configuration).toEqual(saved.claim.run.configuration)
    expect(current.run.pipelineVersion).toBe(saved.claim.run.pipelineVersion)
    expect(current.document.sourceHash).toBe(saved.claim.document.sourceHash)
    const replayed = yield* (yield* ProviderGuard).execute(current, saved.submitted)
    expect(replayed.delivery).toBe("reused")
    expect(replayed.receipt.id).toBe(saved.receipt.id)
    expect(yield* helper.repair(saved.request, () => Result.fail(executionFailure("invalid-provider-response", "Must not run")))).toEqual(accepted)
    yield* stop(current)
    yield* (yield* DocumentStore).delete(current.document.ownerId, current.document.id)
    const deleted = yield* snapshot
    expect(deleted.audits).toEqual([])
    expect(deleted.attempts).toEqual([])
    expect(deleted.charges).toEqual(before.charges)
  })))

  for (const change of ["response-hash", "wire", "request", "source", "configuration", "missing-policy", "different-policy", "charge", "accepted", "latest", "run-state", "queue", "lease", "run-limit"] as const) it.effect(`fails closed for ${change} without partial changes`, () => withFixture(Effect.gen(function* () {
    const saved = yield* fixture(change === "lease")
    const { db, query } = yield* StorageDatabase
    let request = saved.request
    let configuration = policy
    if (change === "response-hash") request = { ...request, responseHash: yield* Schema.decodeUnknownEffect(ValidatorRepairRequest.fields.responseHash)("0".repeat(64)) }
    if (change === "wire") yield* query("fixture", () => db.updateTable("provider_attempts").set({ response_json: JSON.stringify({ changed: true }) }).where("id", "=", saved.row.id).execute())
    if (change === "request") {
      const intent = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AttemptIntent))(saved.row.intent_json)
      yield* query("fixture", () => db.updateTable("provider_attempts").set({ intent_json: JSON.stringify({ ...intent, request: { changed: true } }) }).where("id", "=", saved.row.id).execute())
    }
    if (change === "source") {
      const document = yield* Schema.decodeUnknownEffect(Document)({ ...saved.claim.document, sourceHash: "0".repeat(64) })
      yield* query("fixture", () => db.updateTable("documents").set({ document_json: JSON.stringify(document) }).where("id", "=", document.id).execute())
    }
    if (change === "configuration" || change === "run-state") {
      const row = yield* query("fixture", () => db.selectFrom("runs").selectAll().where("id", "=", saved.claim.run.id).executeTakeFirstOrThrow())
      const run = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Run))(row.run_json)
      const changed = change === "configuration" ? { ...run, configuration: { ...run.configuration, pageCheck: { ...run.configuration.pageCheck, promptVersion: "different" } } } : { ...run, state: { ...run.state, _tag: "interrupted" } }
      yield* query("fixture", () => db.updateTable("runs").set({ state: changed.state._tag, run_json: JSON.stringify(changed) }).where("id", "=", row.id).execute())
    }
    if (change === "missing-policy") yield* query("fixture", () => db.deleteFrom("document_policies").execute())
    if (change === "different-policy") configuration = { ...policy, authorizedBudgetMicrousd: 2_000_000 }
    if (change === "charge") yield* query("fixture", () => db.updateTable("provider_charges").set({ actual_microusd: 0 }).execute())
    if (change === "accepted") yield* query("fixture", () => db.updateTable("provider_attempts").set({ validation_state: "accepted" }).execute())
    if (change === "latest") yield* query("fixture", () => db.updateTable("documents").set({ latest_run_id: "other-run" }).execute())
    if (change === "queue") yield* (yield* DocumentStore).admit(yield* admission("other-reader"))
    if (change === "run-limit") {
      const original = yield* query("fixture", () => db.selectFrom("runs").selectAll().where("id", "=", saved.claim.run.id).executeTakeFirstOrThrow())
      const run = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Run))(original.run_json)
      for (const index of [1, 2, 3]) yield* query("fixture", () => db.insertInto("runs").values({ ...original, id: `previous-${index}`, mastra_run_id: `previous-mastra-${index}`, run_json: JSON.stringify({ ...run, id: `previous-${index}`, mastraRunId: `previous-mastra-${index}` }) }).execute())
    }
    const before = yield* snapshot
    const helper = yield* makeValidatorRepair(configuration, change === "queue" ? 1 : 5)
    let validations = 0
    expect((yield* helper.repair(request, (evidence) => { validations += 1; return accept(evidence) }).pipe(Effect.result))._tag).toBe("Failure")
    expect(validations).toBe(0)
    expect(yield* snapshot).toEqual(before)
  })))

  it.effect("leaves the rejected receipt untouched when the current validator still rejects it", () => withFixture(Effect.gen(function* () {
    const saved = yield* fixture()
    const before = yield* snapshot
    const helper = yield* makeValidatorRepair(policy, 5)
    expect(yield* helper.repair(saved.request, () => Result.fail(executionFailure("invalid-provider-response", "Still invalid"))).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: "invalid-provider-response" } })
    expect(yield* snapshot).toEqual(before)
  })))

  it.effect("repairs a rejected figure-crop review, keyed by its task", () => withFixture(Effect.gen(function* () {
    const saved = yield* fixture(false, cropInput)
    expect(saved.receipt.task).toBe("figure-crop")
    const helper = yield* makeValidatorRepair(policy, 5)
    const accepted = yield* helper.repair(saved.request, acceptCrop)
    const after = yield* snapshot
    expect(after.attempts).toMatchObject([{ id: saved.row.id, validation_state: "accepted" }])
    expect(after.audits).toMatchObject([{ attempt_id: saved.row.id, request_fingerprint: saved.row.fingerprint }])
    expect(after.audits[0]?.run_id).toBe(accepted.runId)
    const current = yield* (yield* DocumentStore).claimNext({ workerId: "new-worker", leaseMilliseconds: 10_000 })
    if (current === null) return yield* Effect.die("Expected repaired run")
    const replayed = yield* (yield* ProviderGuard).execute(current, saved.submitted)
    expect(replayed).toMatchObject({ delivery: "reused", receipt: { id: saved.receipt.id, task: "figure-crop" } })
  })))

  it.effect("rolls back receipt and run writes when the audit cannot be persisted", () => withFixture(Effect.gen(function* () {
    const saved = yield* fixture()
    const before = yield* snapshot
    const database = yield* StorageDatabase
    const fault = StorageDatabase.of({ ...database, query: (operation, work) => operation === "repair-audit" ? Effect.fail(storageFailure("fixture", "Injected audit failure")) : database.query(operation, work) })
    const helper = yield* makeValidatorRepair(policy, 5).pipe(Effect.provideService(StorageDatabase, fault))
    expect((yield* helper.repair(saved.request, accept).pipe(Effect.result))._tag).toBe("Failure")
    expect(yield* snapshot).toEqual(before)
  })))

  for (const field of ["validatorFixId", "validatorFixHash"] as const) it.effect(`rejects a different ${field} after repair without a second run or validation`, () => withFixture(Effect.gen(function* () {
    const saved = yield* fixture()
    const helper = yield* makeValidatorRepair(policy, 5)
    yield* helper.repair(saved.request, accept)
    const before = yield* snapshot
    const request = yield* Schema.decodeUnknownEffect(ValidatorRepairRequest)({ ...saved.request, [field]: field === "validatorFixId" ? "another-fix" : "0".repeat(64) })
    expect(yield* helper.repair(request, () => Result.fail(executionFailure("invalid-provider-response", "Must not run"))).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: "conflict" } })
    expect(yield* snapshot).toEqual(before)
  })))

  for (const behavior of ["throw", "mutate"] as const) it.effect(`rejects a validator that attempts to ${behavior}`, () => withFixture(Effect.gen(function* () {
    const saved = yield* fixture()
    const before = yield* snapshot
    const helper = yield* makeValidatorRepair(policy, 5)
    expect(yield* helper.repair(saved.request, (evidence) => {
      if (behavior === "throw") throw new Error("Invalid local validator")
      Reflect.set(evidence.receipt, "pipelineVersion", "changed")
      return Result.succeed(undefined)
    }).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: "invalid-provider-response" } })
    expect(yield* snapshot).toEqual(before)
  })))

  it.effect("reopens the durable audit and returns the original repaired run without a validator call", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const options: StorageOptions = { dataDirectory: yield* fs.makeTempDirectoryScoped(), queueLimit: 5 }
    const provider = Layer.succeed(ProviderAdapter, { invoke: () => Effect.succeed({ response: { saved: true }, usage: { _tag: "unavailable" as const, reason: "Offline fixture" }, actualCostMicrousd: 70_000 }), validate: () => Effect.fail(executionFailure("invalid-provider-response", "Old validator")) })
    const first = yield* Effect.gen(function* () {
      const saved = yield* fixture()
      const helper = yield* makeValidatorRepair(policy, 5)
      return { request: saved.request, accepted: yield* helper.repair(saved.request, accept), before: yield* snapshot }
    }).pipe(Effect.provide(Layer.merge(makeProviderGuardLayer(policy), provider).pipe(Layer.provideMerge(makeDocumentStoreLayer(options)))))
    yield* Effect.gen(function* () {
      const helper = yield* makeValidatorRepair(policy, 5)
      expect(yield* helper.repair(first.request, () => Result.fail(executionFailure("invalid-provider-response", "Must not run")))).toEqual(first.accepted)
      expect(yield* snapshot).toEqual(first.before)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))
})
