import { Clock, DateTime, Effect, Layer, Schema, Semaphore } from "effect"
import type { Kysely } from "kysely"
import { AcceptedRun, Document, DocumentDetail, Run, RunState, StageReceipt, UserId, boundaryParseOptions, validateRunTransition, type DocumentId } from "../domain/index.ts"
import { PdfLimits } from "../paper/pdf/index.ts"
import { StorageDatabase, makeStorageDatabaseLayer, type ApplicationDatabase, type DocumentRow, type RunRow } from "./database.ts"
import { makeSourceFiles } from "./files.ts"
import { Admission, DocumentStore, StorageFailure, documentNotFound, documentRetentionMilliseconds, storageConflict, storageFailure, uploadLimitReached, type DispatchClaim, type StorageOptions } from "./service.ts"

const Options = Schema.Struct({
  queueLimit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  retentionMilliseconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: documentRetentionMilliseconds })),
  maxUploadBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PdfLimits.maxBytes })),
  examplesOwnerId: Schema.optionalKey(UserId),
})
const Lease = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 86400000 }))
const iso = (milliseconds: number) => DateTime.formatIso(DateTime.makeUnsafe(milliseconds))
const decode = <A>(schema: Schema.Codec<A, unknown>, value: unknown, operation: string) =>
  Schema.decodeUnknownEffect(schema)(value, boundaryParseOptions).pipe(Effect.mapError((cause) => storageFailure(operation, cause)))
const decodeDocument = Effect.fnUntraced(function* (row: DocumentRow) {
  const document = yield* decode(Schema.fromJsonString(Document), row.document_json, "read-document")
  if (document.id !== row.id || document.ownerId !== row.owner_id || document.lifecycle._tag !== row.lifecycle || document.expiresAt !== iso(row.expires_at)) {
    return yield* storageFailure("read-document", "Document does not match its persisted identity or lifecycle")
  }
  return document
})
const decodeRun = Effect.fnUntraced(function* (row: RunRow) {
  const run = yield* decode(Schema.fromJsonString(Run), row.run_json, "read-run")
  if (run.id !== row.id || run.documentId !== row.document_id || run.ownerId !== row.owner_id || run.state._tag !== row.state || run.mastraRunId !== row.mastra_run_id) {
    return yield* storageFailure("read-run", "Run does not match its persisted identity or state")
  }
  return run
})
const decodeDetail = Effect.fnUntraced(function* (row: DocumentRow & { run_json: string; run_state: string; mastra_run_id: string }) {
  const document = yield* decodeDocument(row)
  const latestRun = yield* decode(Schema.fromJsonString(Run), row.run_json, "read-run")
  if (latestRun.documentId !== document.id || latestRun.ownerId !== document.ownerId || latestRun.id !== row.latest_run_id || latestRun.state._tag !== row.run_state || latestRun.mastraRunId !== row.mastra_run_id) {
    return yield* storageFailure("read-document", "Latest run does not match its document or persisted state")
  }
  return yield* decode(DocumentDetail, { document, latestRun, currentRevisionId: "revisionId" in latestRun.state ? latestRun.state.revisionId : null }, "read-document")
})
const terminal = (state: RunState) => state._tag !== "queued" && state._tag !== "running"
const modelFingerprint = (model: Run["configuration"]["pageCheck"]) => [model.provider, model.model, model.reasoning, model.promptName, model.promptVersion, model.maxOutputTokens]
const unavailableState = (now: number, code: "storage-failed" | "expired" | "provider-unknown-completion" | "limit-exceeded", message: string): RunState => ({
  _tag: code === "storage-failed" ? "failed" : "interrupted", finishedAt: iso(now),
  failure: { code, message, retryable: code !== "expired", stage: null, pageId: null, figureId: null },
})

export const makeDocumentStore = Effect.fn("makeDocumentStore")(function* (options: StorageOptions) {
  const settings = yield* decode(Options, {
    queueLimit: options.queueLimit,
    retentionMilliseconds: options.retentionMilliseconds ?? documentRetentionMilliseconds,
    maxUploadBytes: options.maxUploadBytes ?? PdfLimits.maxBytes,
    ...(options.examplesOwnerId === undefined ? {} : { examplesOwnerId: options.examplesOwnerId }),
  }, "configuration")
  const database = yield* StorageDatabase
  const { db, query, transaction } = database
  const files = yield* makeSourceFiles(options.dataDirectory, settings.maxUploadBytes)
  const staging = yield* Semaphore.make(2)
  const reconciliation = yield* Semaphore.make(1)
  const inFlightFiles = new Set<string>()
  let initialReconciliation = true
  const saveRun = (connection: Kysely<ApplicationDatabase>, run: Run, fields: Partial<RunRow> = {}) =>
    query("write-run", () => connection.updateTable("runs").set({
      ...fields, state: run.state._tag, run_json: JSON.stringify(run),
      ...(terminal(run.state) ? { claim_token: null, worker_id: null, lease_expires_at: null } : {}),
    }).where("id", "=", run.id).execute())
  const finish = Effect.fnUntraced(function* (connection: Kysely<ApplicationDatabase>, row: RunRow, state: RunState) {
    const run = yield* decodeRun(row)
    const updated = yield* decode(Run, { ...run, state }, "write-run")
    yield* saveRun(connection, updated)
    if (terminal(state)) yield* query("finish-job", () => connection.deleteFrom("accepted_jobs").where("run_id", "=", row.id).execute())
    return updated
  })
  const expireClaims = Effect.fnUntraced(function* (connection: Kysely<ApplicationDatabase>, now: number) {
    const expired = yield* query("recover-claims", () => connection.selectFrom("runs").selectAll().where("state", "=", "running").where("lease_expires_at", "<=", now).execute())
    let stopped = 0
    for (const row of expired) {
      const run = yield* decodeRun(row)
      const attempts = yield* query("recover-attempts", () => connection.selectFrom("provider_attempts").selectAll().where("run_id", "=", row.id).execute())
      if (attempts.some((attempt) => ["prepared", "dispatching", "submitted", "unknown"].includes(attempt.status) && attempt.lease_expires_at > now)) continue
      let unsafe = false
      for (const attempt of attempts) {
        if (!["dispatching", "submitted", "unknown"].includes(attempt.status) && !(attempt.status === "prepared" && attempt.dispatch_started_at !== null)) continue
        const receipt = yield* decode(Schema.fromJsonString(StageReceipt), attempt.receipt_json, "recover-attempt")
        if (receipt.configuration._tag !== "extraction" || receipt.configuration.provider !== "mineru" || attempt.remote_id !== attempt.id || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(attempt.id)) unsafe = true
      }
      const deadline = run.state._tag === "running" ? DateTime.toEpochMillis(DateTime.makeUnsafe(run.state.startedAt)) + run.configuration.deadlineMilliseconds : now
      if (unsafe || deadline <= now) {
        yield* finish(connection, row, unavailableState(now, unsafe ? "provider-unknown-completion" : "limit-exceeded", unsafe ? "Provider completion is unknown; an explicit acknowledged retry is required" : "The original run deadline elapsed"))
        stopped += 1
      }
    }
    return stopped
  })
  const retainCleanup = Effect.fnUntraced(function* (connection: Kysely<ApplicationDatabase>, documentId: string, now: number) {
    const attempts = yield* query("retain-remote-cleanup", () => connection.selectFrom("provider_attempts").select(["id", "receipt_json"]).where("document_id", "=", documentId).execute())
    for (const attempt of attempts) {
      const receipt = yield* decode(Schema.fromJsonString(StageReceipt), attempt.receipt_json, "retain-remote-cleanup")
      if (receipt.stage === "extraction" && receipt.configuration._tag === "extraction" && receipt.configuration.provider === "mineru") yield* query("retain-remote-cleanup", () => connection.insertInto("remote_cleanup").values({ job_id: attempt.id, document_id: documentId, created_at: now }).onConflict((conflict) => conflict.column("job_id").doNothing()).execute())
    }
    yield* query("clear-retry-requests", () => connection.deleteFrom("retry_requests").where("document_id", "=", documentId).execute())
    yield* query("clear-document-policy", () => connection.deleteFrom("document_policies").where("document_id", "=", documentId).execute())
  })
  const expireDocuments = Effect.fnUntraced(function* (connection: Kysely<ApplicationDatabase>, now: number) {
    const expired = yield* query("expire-documents", () => connection.selectFrom("documents").selectAll().where("lifecycle", "=", "active").where("expires_at", "<=", now).execute())
    for (const row of expired) {
      const document = yield* decodeDocument(row)
      yield* query("expire-document", () => connection.updateTable("documents").set({ lifecycle: "expired", document_json: JSON.stringify({ ...document, lifecycle: { _tag: "expired", at: iso(now) } }) }).where("id", "=", row.id).execute())
      const active = yield* query("expire-run", () => connection.selectFrom("runs").selectAll().where("document_id", "=", row.id).where("state", "in", ["queued", "running"]).execute())
      for (const run of active) yield* finish(connection, run, unavailableState(now, "expired", "Document retention period ended"))
      yield* retainCleanup(connection, row.id, now)
      yield* query("expire-attempts", () => connection.deleteFrom("provider_attempts").where("document_id", "=", row.id).execute())
      yield* query("expire-outputs", () => connection.deleteFrom("outputs").where("document_id", "=", row.id).execute())
    }
  })
  const detail = Effect.fn("DocumentStore.detail")(function* (ownerId: UserId, documentId: DocumentId) {
    const now = yield* Clock.currentTimeMillis
    const row = yield* query("read-document", () => db.selectFrom("documents")
      .innerJoin("runs", "runs.id", "documents.latest_run_id")
      .selectAll("documents").select(["runs.run_json", "runs.state as run_state", "runs.mastra_run_id"])
      .where("documents.id", "=", documentId).where("documents.owner_id", "=", ownerId)
      .where("documents.lifecycle", "=", "active").where("documents.expires_at", ">", now).executeTakeFirst())
    if (row === undefined) return yield* documentNotFound()
    return yield* decodeDetail(row)
  })
  const list = Effect.fn("DocumentStore.list")(function* (ownerId: UserId) {
    const now = yield* Clock.currentTimeMillis
    const rows = yield* query("list-documents", () => db.selectFrom("documents").innerJoin("runs", "runs.id", "documents.latest_run_id")
      .selectAll("documents").select(["runs.run_json", "runs.state as run_state", "runs.mastra_run_id"])
      .where("documents.owner_id", "=", ownerId).where("documents.lifecycle", "=", "active").where("documents.expires_at", ">", now).orderBy("documents.expires_at", "desc").execute())
    return yield* Effect.forEach(rows, decodeDetail)
  })
  const listExamples = Effect.fn("DocumentStore.listExamples")(function* (readerId: UserId) {
    if (settings.examplesOwnerId === undefined || settings.examplesOwnerId === readerId) return null
    return yield* list(settings.examplesOwnerId)
  })
  const readableOwner = Effect.fn("DocumentStore.readableOwner")(function* (readerId: UserId, documentId: DocumentId) {
    const now = yield* Clock.currentTimeMillis
    const owners = settings.examplesOwnerId === undefined ? [readerId] : [readerId, settings.examplesOwnerId]
    const row = yield* query("read-document-owner", () => db.selectFrom("documents").select("owner_id")
      .where("id", "=", documentId).where("owner_id", "in", owners)
      .where("lifecycle", "=", "active").where("expires_at", ">", now).executeTakeFirst())
    if (row === undefined) return yield* documentNotFound()
    return yield* decode(UserId, row.owner_id, "read-document-owner")
  })
  const countUploads = (connection: Kysely<ApplicationDatabase>, ownerId: UserId) => query("upload-count", () => connection.selectFrom("documents")
    .select((expression) => expression.fn.countAll<number>().as("count")).where("owner_id", "=", ownerId).executeTakeFirstOrThrow()).pipe(Effect.map((row) => Number(row.count)))
  const admit = Effect.fn("DocumentStore.admit")(function* (input: Admission) {
    const request = yield* Schema.decodeUnknownEffect(Admission)(input, boundaryParseOptions).pipe(
      Effect.mapError((cause) => new StorageFailure({ code: "invalid-input", operation: "admit", message: "Invalid document submission", cause })),
    )
    if (request.bytes.byteLength === 0 || request.bytes.byteLength > settings.maxUploadBytes) {
      return yield* new StorageFailure({ code: "limit-exceeded", operation: "admit", message: "Document exceeds the upload byte limit", cause: undefined })
    }
    const bytes = new Uint8Array(request.bytes)
    const configuration = structuredClone(request.configuration)
    const sourceHash = yield* files.hash(bytes)
    const fingerprint = yield* files.hash(new TextEncoder().encode(JSON.stringify([
      sourceHash, request.originalFilename, request.pageCount, request.pipelineVersion, configuration.extractionProvider,
      configuration.extractionVersion, ...(configuration.extractionModel === undefined ? [] : [modelFingerprint(configuration.extractionModel)]), modelFingerprint(configuration.pageCheck), modelFingerprint(configuration.headings),
      modelFingerprint(configuration.figures), configuration.maxProviderAttempts, configuration.deadlineMilliseconds, configuration.spendingCapUsd,
      ...(configuration.guide === undefined ? [] : [modelFingerprint(configuration.guide)]),
    ])))
    const previous = yield* query("read-admission", () => db.selectFrom("admission_requests").selectAll()
      .where("owner_id", "=", request.ownerId).where("request_key", "=", request.idempotencyKey).executeTakeFirst())
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) return yield* storageConflict("admit", "This request key was already used for a different submission")
      const accepted = yield* decode(AcceptedRun, { documentId: previous.document_id, runId: previous.run_id }, "read-admission")
      yield* detail(request.ownerId, accepted.documentId)
      return accepted
    }
    if (request.uploadLimit !== undefined && (yield* countUploads(db, request.ownerId)) >= request.uploadLimit) return yield* uploadLimitReached(request.uploadLimit)
    const id = yield* files.identifier()
    const runId = yield* files.identifier()
    const mastraRunId = yield* files.identifier()
    const now = yield* Clock.currentTimeMillis
    const document = yield* decode(Document, {
      schemaVersion: "1", id, ownerId: request.ownerId, originalFilename: request.originalFilename,
      mediaType: "application/pdf", byteCount: request.bytes.byteLength, sourceHash, pageCount: request.pageCount,
      sourceArtifact: "source.pdf", createdAt: iso(now), expiresAt: iso(now + settings.retentionMilliseconds), lifecycle: { _tag: "active" },
    }, "admit")
    const run = yield* decode(Run, {
      id: runId, documentId: document.id, ownerId: request.ownerId, pipelineVersion: request.pipelineVersion,
      schemaVersion: "1", configuration, createdAt: iso(now), mastraRunId, state: { _tag: "queued" },
    }, "admit")
    inFlightFiles.add(document.id)
    let sourceCreated = false
    return yield* Effect.gen(function* () {
      yield* files.write(document.id, bytes)
      sourceCreated = true
      const accepted = yield* transaction((connection) => Effect.gen(function* () {
        const admissionTime = yield* Clock.currentTimeMillis
        yield* expireDocuments(connection, admissionTime)
        yield* expireClaims(connection, admissionTime)
        const repeated = yield* query("read-admission", () => connection.selectFrom("admission_requests").selectAll()
          .where("owner_id", "=", request.ownerId).where("request_key", "=", request.idempotencyKey).executeTakeFirst())
        if (repeated !== undefined) {
          if (repeated.fingerprint !== fingerprint) return yield* storageConflict("admit", "This request key was already used for a different submission")
          const activeDocument = yield* query("read-admission", () => connection.selectFrom("documents").select("id")
            .where("id", "=", repeated.document_id).where("owner_id", "=", request.ownerId).where("lifecycle", "=", "active").where("expires_at", ">", admissionTime).executeTakeFirst())
          if (activeDocument === undefined) return yield* documentNotFound()
          return yield* decode(AcceptedRun, { documentId: repeated.document_id, runId: repeated.run_id }, "read-admission")
        }
        if (request.uploadLimit !== undefined && (yield* countUploads(connection, request.ownerId)) >= request.uploadLimit) return yield* uploadLimitReached(request.uploadLimit)
        const active = yield* query("admission-limit", () => connection.selectFrom("runs").select("id").where("owner_id", "=", request.ownerId).where("state", "in", ["queued", "running"]).executeTakeFirst())
        if (active !== undefined) return yield* storageConflict("admit", "A document is already queued or processing for this account")
        const count = yield* query("queue-limit", () => connection.selectFrom("runs").select((expression) => expression.fn.countAll<number>().as("count")).where("state", "=", "queued").executeTakeFirstOrThrow())
        if (count.count >= settings.queueLimit) return yield* new StorageFailure({ code: "queue-full", operation: "admit", message: "The document queue is full", cause: undefined })
        yield* query("admit-document", () => connection.insertInto("documents").values({
          id: document.id, owner_id: document.ownerId, document_json: JSON.stringify(document), lifecycle: "active", expires_at: now + settings.retentionMilliseconds, latest_run_id: run.id,
        }).execute())
        yield* query("admit-run", () => connection.insertInto("runs").values({
          id: run.id, document_id: document.id, owner_id: document.ownerId, state: "queued", mastra_run_id: mastraRunId,
          run_json: JSON.stringify(run), created_at: now, claim_token: null, worker_id: null, lease_expires_at: null,
        }).execute())
        yield* query("admit-request", () => connection.insertInto("admission_requests").values({ owner_id: document.ownerId, request_key: request.idempotencyKey, fingerprint, document_id: document.id, run_id: run.id }).execute())
        yield* query("admit-job", () => connection.insertInto("accepted_jobs").values({ run_id: run.id }).execute())
        return { documentId: document.id, runId: run.id }
      }))
      if (accepted.documentId !== document.id) yield* files.remove(document.id)
      return accepted
    }).pipe(
      Effect.onError(() => Effect.gen(function* () {
        if (!sourceCreated) return
        const committed = yield* query("admission-recovery", () => db.selectFrom("documents").select("id").where("id", "=", document.id).executeTakeFirst())
        if (committed === undefined) yield* files.remove(document.id)
      }).pipe(Effect.catch(() => Effect.logWarning("Admission file reconciliation deferred until restart")))),
      Effect.ensuring(Effect.sync(() => { inFlightFiles.delete(document.id) })),
    )
  }, staging.withPermit)
  const claimNext = Effect.fn("DocumentStore.claimNext")(function* (input: { readonly workerId: string; readonly leaseMilliseconds: number; readonly budget?: { readonly id: string; readonly authorizedMicrousd: number | null } }) {
    yield* decode(Document.fields.ownerId, input.workerId, "claim")
    yield* decode(Lease, input.leaseMilliseconds, "claim")
    const token = yield* files.identifier()
    return yield* transaction((connection) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      yield* expireDocuments(connection, now)
      yield* expireClaims(connection, now)
      const runningRows = yield* query("claim", () => connection.selectFrom("runs").selectAll().where("state", "=", "running").orderBy("created_at", "asc").orderBy("id", "asc").execute())
      for (const running of runningRows) {
        if (running.lease_expires_at === null || running.lease_expires_at > now) continue
        const activeAttempt = yield* query("claim-recovery", () => connection.selectFrom("provider_attempts").select("id").where("run_id", "=", running.id).where("status", "in", ["prepared", "dispatching", "submitted", "unknown"]).where("lease_expires_at", ">", now).executeTakeFirst())
        if (activeAttempt !== undefined) continue
        const documentRow = yield* query("claim-document", () => connection.selectFrom("documents").selectAll().where("id", "=", running.document_id).executeTakeFirstOrThrow())
        const run = yield* decodeRun(running)
        const document = yield* decodeDocument(documentRow)
        yield* saveRun(connection, run, { claim_token: token, worker_id: input.workerId, lease_expires_at: now + input.leaseMilliseconds })
        return { document, run, claimToken: token, leaseExpiresAt: now + input.leaseMilliseconds, recovered: true }
      }
      if (runningRows.length >= 2) return null
      const candidate = yield* query("claim", () => connection.selectFrom("runs").innerJoin("accepted_jobs", "accepted_jobs.run_id", "runs.id")
        .innerJoin("documents", "documents.id", "runs.document_id").selectAll("runs")
        .where("runs.state", "=", "queued").where("documents.lifecycle", "=", "active").where("documents.expires_at", ">", now)
        .orderBy("runs.created_at", "asc").orderBy("runs.id", "asc").executeTakeFirst())
      if (candidate === undefined) return null
      const documentRow = yield* query("claim-document", () => connection.selectFrom("documents").selectAll().where("id", "=", candidate.document_id).executeTakeFirstOrThrow())
      const document = yield* decodeDocument(documentRow)
      const before = yield* decodeRun(candidate)
      if (runningRows.length > 0 && input.budget !== undefined && input.budget.authorizedMicrousd !== null) {
        const budget = input.budget
        const runningIds = runningRows.map((running) => running.id)
        const charges = yield* query("claim-budget", () => connection.selectFrom("provider_charges").leftJoin("provider_attempts", "provider_attempts.id", "provider_charges.attempt_id")
          .select(["provider_charges.reserved_microusd", "provider_charges.actual_microusd"]).where("provider_charges.budget_id", "=", budget.id)
          .where((row) => row.or([row("provider_attempts.run_id", "is", null), row("provider_attempts.run_id", "not in", runningIds)])).execute())
        const usedByFinishedRuns = charges.reduce((sum, charge) => sum + (charge.actual_microusd ?? charge.reserved_microusd), 0)
        let runningCaps = Math.floor(before.configuration.spendingCapUsd * 1_000_000)
        for (const running of runningRows) runningCaps += Math.floor((yield* decodeRun(running)).configuration.spendingCapUsd * 1_000_000)
        if (!Number.isSafeInteger(usedByFinishedRuns + runningCaps) || usedByFinishedRuns + runningCaps > input.budget.authorizedMicrousd) return null
      }
      const run = yield* decode(Run, { ...before, state: { _tag: "running", startedAt: iso(now), progress: { stage: "extraction", completedUnits: 0, totalUnits: null } } }, "claim")
      yield* saveRun(connection, run, { claim_token: token, worker_id: input.workerId, lease_expires_at: now + input.leaseMilliseconds })
      return { document, run, claimToken: token, leaseExpiresAt: now + input.leaseMilliseconds, recovered: false }
    }))
  })
  const claimedRow = Effect.fnUntraced(function* (connection: Kysely<ApplicationDatabase>, claim: DispatchClaim, now: number) {
    const row = yield* query("fence", () => connection.selectFrom("runs").innerJoin("documents", "documents.id", "runs.document_id").selectAll("runs")
      .where("runs.id", "=", claim.run.id).where("runs.document_id", "=", claim.document.id).where("runs.owner_id", "=", claim.document.ownerId)
      .where("runs.state", "=", "running").where("runs.claim_token", "=", claim.claimToken).where("runs.lease_expires_at", ">", now)
      .where("documents.lifecycle", "=", "active").where("documents.expires_at", ">", now).executeTakeFirst())
    if (row === undefined) return yield* storageConflict("fence", "Processing claim is no longer active")
    return row
  })
  const renewClaim = Effect.fn("DocumentStore.renewClaim")(function* (claim: DispatchClaim, leaseMilliseconds: number) {
    yield* decode(Lease, leaseMilliseconds, "renew-claim")
    return yield* transaction((connection) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const row = yield* claimedRow(connection, claim, now)
      const run = yield* decodeRun(row)
      yield* saveRun(connection, run, { lease_expires_at: now + leaseMilliseconds })
      return { ...claim, run, leaseExpiresAt: now + leaseMilliseconds }
    }))
  })
  const updateRun = Effect.fn("DocumentStore.updateRun")(function* (claim: DispatchClaim, next: RunState) {
    const state = yield* decode(RunState, next, "update-run")
    if (state._tag === "succeeded" || state._tag === "succeeded-with-issues") return yield* storageConflict("update-run", "Successful runs must publish their complete output atomically")
    return yield* transaction((connection) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const row = yield* claimedRow(connection, claim, now)
      const current = yield* decodeRun(row)
      if (validateRunTransition(current, { ...current, state }).length > 0) return yield* storageConflict("update-run", "Invalid processing state transition")
      return yield* finish(connection, row, state)
    }))
  })
  const recoverExpiredClaims = Effect.fn("DocumentStore.recoverExpiredClaims")(function* () {
    return yield* transaction((connection) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      return yield* expireClaims(connection, now)
    }))
  })
  const removeDocument = Effect.fn("DocumentStore.delete")(function* (ownerId: UserId, documentId: DocumentId) {
    yield* transaction((connection) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const row = yield* query("delete-document", () => connection.selectFrom("documents").selectAll().where("id", "=", documentId).where("owner_id", "=", ownerId).where("lifecycle", "=", "active").where("expires_at", ">", now).executeTakeFirst())
      if (row === undefined) return yield* documentNotFound()
      const runRow = yield* query("delete-document", () => connection.selectFrom("runs").selectAll().where("id", "=", row.latest_run_id).executeTakeFirstOrThrow())
      const run = yield* decodeRun(runRow)
      if (!terminal(run.state)) return yield* storageConflict("delete-document", "Wait until processing finishes before deleting this document")
      const document = yield* decodeDocument(row)
      yield* query("delete-document", () => connection.updateTable("documents").set({ lifecycle: "deleted", document_json: JSON.stringify({ ...document, lifecycle: { _tag: "deleted", at: iso(now) } }) }).where("id", "=", document.id).execute())
      yield* retainCleanup(connection, document.id, now)
      yield* query("delete-attempts", () => connection.deleteFrom("provider_attempts").where("document_id", "=", document.id).execute())
      yield* query("delete-outputs", () => connection.deleteFrom("outputs").where("document_id", "=", document.id).execute())
    }))
    yield* files.remove(documentId)
  })
  const reconcile = Effect.fn("DocumentStore.reconcile")(function* () {
    if (initialReconciliation) yield* files.cleanupTemporary()
    yield* transaction((connection) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      yield* expireDocuments(connection, now)
      yield* expireClaims(connection, now)
    }))
    if (initialReconciliation) {
      const rows = yield* query("reconcile", () => db.selectFrom("documents").selectAll().where("lifecycle", "=", "active").execute())
      for (const row of rows) {
        const document = yield* decodeDocument(row)
        const source = yield* files.read(document).pipe(Effect.result)
        if (source._tag === "Failure") {
          yield* transaction((connection) => Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const active = yield* query("recover-source", () => connection.selectFrom("runs").selectAll().where("document_id", "=", row.id).where("state", "in", ["queued", "running"]).execute())
            for (const run of active) yield* finish(connection, run, unavailableState(now, "storage-failed", "The original document is unavailable or damaged"))
          }))
        }
      }
    }
    for (const entry of yield* files.entries()) yield* transaction((connection) => Effect.gen(function* () {
      const row = yield* query("reconcile-file", () => connection.selectFrom("documents").select("lifecycle").where("id", "=", entry).executeTakeFirst())
      if (row?.lifecycle !== "active" && !inFlightFiles.has(entry)) yield* files.remove(entry)
    }))
    initialReconciliation = false
  }, reconciliation.withPermit)
  yield* reconcile()
  return DocumentStore.of({
    admit, list, listExamples, readableOwner, detail, claimNext,
    uploadCount: (ownerId) => countUploads(db, ownerId), renewClaim, updateRun, recoverExpiredClaims, delete: removeDocument, reconcile,
    status: (ownerId, documentId) => detail(ownerId, documentId).pipe(Effect.map((value) => value.latestRun)),
    original: Effect.fn("DocumentStore.original")(function* (ownerId, documentId) {
      const { document } = yield* detail(ownerId, documentId)
      const bytes = yield* files.read(document)
      yield* detail(ownerId, documentId)
      return { document, bytes }
    }),
    originalFile: Effect.fn("DocumentStore.originalFile")(function* (ownerId, documentId) {
      const { document } = yield* detail(ownerId, documentId)
      return { document, privatePath: yield* files.sourcePath(document) }
    }),
  })
})

export const makeDocumentStoreLayer = (options: StorageOptions) => Layer.effect(DocumentStore, makeDocumentStore(options)).pipe(
  Layer.provideMerge(makeStorageDatabaseLayer(options)),
)
