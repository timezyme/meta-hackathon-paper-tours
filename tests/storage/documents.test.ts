import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Clock, DateTime, Effect, FileSystem, Path, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import { sql } from "kysely"
import { UserId, type RunState } from "../../src/domain/index.ts"
import { Admission, DocumentStore, StorageDatabase, makeDocumentStoreLayer, type DispatchClaim, type StorageOptions } from "../../src/storage/index.ts"
import { contractFixture } from "../fixtures/contracts.ts"
import sources from "../fixtures/sources.json" with { type: "json" }

const configuration = contractFixture().run.configuration
const one = Schema.decodeUnknownSync(UserId)("user-one")
const two = Schema.decodeUnknownSync(UserId)("user-two")
const three = Schema.decodeUnknownSync(UserId)("user-three")
const fixture = Effect.fnUntraced(function* (extra: Partial<StorageOptions> = {}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-storage-" })
  return { dataDirectory: path.join(root, "private"), queueLimit: 10, ...extra }
})
const admission = Effect.fnUntraced(function* (ownerId = one, key = "upload-one", extra: Partial<Admission> = {}) {
  const fs = yield* FileSystem.FileSystem
  const bytes = yield* fs.readFile(new URL("../fixtures/normal.pdf", import.meta.url).pathname)
  return yield* Schema.decodeUnknownEffect(Admission)({
    ownerId, idempotencyKey: key, bytes, originalFilename: "normal.pdf", pageCount: 1, pipelineVersion: "1", configuration, ...extra,
  })
})
const failedState = Effect.gen(function* (): Effect.fn.Return<RunState> {
  const now = yield* Clock.currentTimeMillis
  return { _tag: "failed", finishedAt: DateTime.formatIso(DateTime.makeUnsafe(now)), failure: { code: "provider-failed", message: "Deterministic fixture failure", retryable: true, stage: "extraction", pageId: null, figureId: null } }
})
const claim = Effect.gen(function* () {
  const store = yield* DocumentStore
  const claimed = yield* store.claimNext({ workerId: "worker-one", leaseMilliseconds: 10000 })
  if (claimed === null) return yield* Effect.die("Expected accepted work")
  return claimed
})
const counts = Effect.gen(function* () {
  const { db, query } = yield* StorageDatabase
  return {
    documents: (yield* query("test", () => db.selectFrom("documents").selectAll().execute())).length,
    runs: (yield* query("test", () => db.selectFrom("runs").selectAll().execute())).length,
    requests: (yield* query("test", () => db.selectFrom("admission_requests").selectAll().execute())).length,
    jobs: (yield* query("test", () => db.selectFrom("accepted_jobs").selectAll().execute())).length,
  }
})

describe("durable private document storage", () => {
  it.effect("persists accepted work, exact source bytes, hashes, private modes and Mastra association across restart", () => Effect.gen(function* () {
    const options = yield* fixture()
    const request = yield* admission()
    const accepted = yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const admitted = yield* store.admit(request)
      expect(yield* counts).toEqual({ documents: 1, runs: 1, requests: 1, jobs: 1 })
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      expect((yield* fs.stat(path.join(options.dataDirectory, "application.sqlite"))).mode & 0o777).toBe(0o600)
      expect((yield* fs.stat(path.join(options.dataDirectory, "documents", admitted.documentId))).mode & 0o777).toBe(0o700)
      expect((yield* fs.stat(path.join(options.dataDirectory, "documents", admitted.documentId, "source.pdf"))).mode & 0o777).toBe(0o600)
      const detail = yield* store.detail(one, admitted.documentId)
      expect(detail.document.sourceHash).toBe(sources.normal.sha256)
      expect(detail.latestRun.state._tag).toBe("queued")
      expect(detail.latestRun.mastraRunId).not.toBeNull()
      return { accepted: admitted, detail }
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      expect(yield* store.admit(request)).toEqual(accepted.accepted)
      expect(yield* store.detail(one, accepted.accepted.documentId)).toEqual(accepted.detail)
      expect(Array.from((yield* store.original(one, accepted.accepted.documentId)).bytes)).toEqual(Array.from(request.bytes))
      expect((yield* store.status(one, accepted.accepted.documentId)).state._tag).toBe("queued")
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("coalesces concurrent identical submissions and rejects changed filename, bytes, page count, pipeline and configuration", () => Effect.gen(function* () {
    const options = yield* fixture()
    const request = yield* admission()
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const accepted = yield* Effect.all(Array.from({ length: 12 }, () => store.admit(request)), { concurrency: "unbounded" })
      expect(new Set(accepted.map((value) => value.documentId)).size).toBe(1)
      expect(new Set(accepted.map((value) => value.runId)).size).toBe(1)
      expect(yield* counts).toEqual({ documents: 1, runs: 1, requests: 1, jobs: 1 })
      for (const extra of [
        { originalFilename: "different.pdf" }, { bytes: new Uint8Array([1, 2, 3]) }, { pageCount: 2 },
        { pipelineVersion: "2" }, { configuration: { ...configuration, spendingCapUsd: 1 } },
      ]) {
        const result = yield* store.admit({ ...request, ...extra }).pipe(Effect.result)
        expect(Result.isFailure(result) && result.failure.code).toBe("conflict")
      }
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      expect((yield* fs.readDirectory(path.join(options.dataDirectory, "documents"))).length).toBe(1)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("isolates identical documents and idempotency keys between owners", () => Effect.gen(function* () {
    const options = yield* fixture()
    const first = yield* admission()
    const second = yield* admission(two)
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const [a, b] = yield* Effect.all([store.admit(first), store.admit(second)], { concurrency: "unbounded" })
      expect(a.documentId).not.toBe(b.documentId)
      expect((yield* store.list(one)).map((item) => item.document.id)).toEqual([a.documentId])
      expect((yield* store.list(two)).map((item) => item.document.id)).toEqual([b.documentId])
      for (const operation of [store.detail(two, a.documentId), store.status(two, a.documentId), store.original(two, a.documentId), store.delete(two, a.documentId)]) {
        const result = yield* operation.pipe(Effect.result)
        expect(Result.isFailure(result) && result.failure.code).toBe("not-found")
      }
      expect((yield* store.original(one, a.documentId)).bytes).toEqual((yield* store.original(two, b.documentId)).bytes)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("bounds queued jobs separately from executing work and enforces one active job per owner", () => Effect.gen(function* () {
    const options = yield* fixture({ queueLimit: 1 })
    const first = yield* admission()
    const duplicateOwner = yield* admission(one, "another-key")
    const second = yield* admission(two)
    const third = yield* admission(three)
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      yield* store.admit(first)
      expect((yield* store.admit(duplicateOwner).pipe(Effect.flip)).code).toBe("conflict")
      expect((yield* store.admit(second).pipe(Effect.flip)).code).toBe("queue-full")
      const claimed = yield* claim
      yield* store.admit(second)
      expect((yield* store.admit(third).pipe(Effect.flip)).code).toBe("queue-full")
      expect(yield* store.claimNext({ workerId: "worker-two", leaseMilliseconds: 10000 })).toBeNull()
      yield* store.updateRun(claimed, yield* failedState)
      expect((yield* claim).document.ownerId).toBe(two)
      expect(yield* counts).toEqual({ documents: 2, runs: 2, requests: 2, jobs: 1 })
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("grants one concurrent global claim and rejects stale or terminal updates", () => Effect.gen(function* () {
    const options = yield* fixture()
    const requests = yield* Effect.all([admission(), admission(two), admission(three)])
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      yield* Effect.forEach(requests, store.admit)
      const results = yield* Effect.all(Array.from({ length: 8 }, (_, index) => store.claimNext({ workerId: `worker-${index}`, leaseMilliseconds: 10000 })), { concurrency: "unbounded" })
      const claims = results.filter((value): value is DispatchClaim => value !== null)
      expect(claims).toHaveLength(1)
      const current = claims[0]
      if (current === undefined) return yield* Effect.die("Missing unique claim")
      const forged = { ...current, claimToken: "different-fence" }
      expect((yield* store.updateRun(forged, yield* failedState).pipe(Effect.flip)).code).toBe("conflict")
      expect((yield* store.updateRun(current, { _tag: "queued" }).pipe(Effect.flip)).code).toBe("conflict")
      yield* store.updateRun(current, yield* failedState)
      expect((yield* store.renewClaim(current, 10000).pipe(Effect.flip)).code).toBe("conflict")
      expect((yield* store.updateRun(current, yield* failedState).pipe(Effect.flip)).code).toBe("conflict")
      expect((yield* store.status(current.document.ownerId, current.document.id)).state._tag).toBe("failed")
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("preserves the original run start time across progress updates", () => Effect.gen(function* () {
    const options = yield* fixture()
    const request = yield* admission()
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      yield* store.admit(request)
      const current = yield* claim
      const original = current.run.state
      if (original._tag !== "running") return yield* Effect.die("Expected a running claim")
      yield* TestClock.adjust(1001)
      const now = yield* DateTime.now
      const changed = { ...original, startedAt: DateTime.formatIso(now) }
      expect((yield* store.updateRun(current, changed).pipe(Effect.flip)).code).toBe("conflict")
      expect((yield* store.status(one, current.document.id)).state).toEqual(original)
      const progress = { ...original, progress: { stage: "page-check" as const, completedUnits: 0, totalUnits: 1 } }
      expect((yield* store.updateRun(current, progress)).state).toEqual(progress)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("reclaims an expired claim with no dispatched work while preserving its original run", () => Effect.gen(function* () {
    const options = yield* fixture()
    const request = yield* admission()
    const accepted = yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const admitted = yield* store.admit(request)
      const current = yield* claim
      yield* TestClock.adjust(10001)
      expect((yield* store.renewClaim(current, 10000).pipe(Effect.flip)).code).toBe("conflict")
      return admitted
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const state = (yield* store.status(one, accepted.documentId)).state
      expect(state._tag).toBe("running")
      const replacement = yield* store.claimNext({ workerId: "replacement", leaseMilliseconds: 10000 })
      expect(replacement?.recovered).toBe(true)
      expect(replacement?.run.id).toBe(accepted.runId)
      expect((yield* counts).jobs).toBe(1)
      expect(yield* store.admit(request)).toEqual(accepted)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects unsafe filenames, invalid page counts and upload limits without records or jobs", () => Effect.gen(function* () {
    const options = yield* fixture({ maxUploadBytes: 2048 })
    const request = yield* admission()
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      for (const originalFilename of ["../secret.pdf", "x/y.pdf", "x\\y.pdf", "x\n.pdf", "", "x".repeat(256)]) {
        expect((yield* store.admit({ ...request, originalFilename }).pipe(Effect.flip)).code).toBe("invalid-input")
      }
      for (const pageCount of [0, -1, 1.5, 51]) expect((yield* store.admit({ ...request, pageCount }).pipe(Effect.flip)).code).toBe("invalid-input")
      for (const bytes of [new Uint8Array(), new Uint8Array(2049)]) expect((yield* store.admit({ ...request, bytes }).pipe(Effect.flip)).code).toBe("limit-exceeded")
      expect(yield* counts).toEqual({ documents: 0, runs: 0, requests: 0, jobs: 0 })
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rolls back all database admission rows when the outbox insert fails", () => Effect.gen(function* () {
    const options = yield* fixture()
    const request = yield* admission()
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const { db, query } = yield* StorageDatabase
      yield* query("fixture", () => sql.raw("CREATE TRIGGER fail_outbox BEFORE INSERT ON accepted_jobs BEGIN SELECT RAISE(ABORT, 'fixture failure'); END").execute(db))
      expect((yield* store.admit(request).pipe(Effect.flip)).code).toBe("storage-failed")
      expect(yield* counts).toEqual({ documents: 0, runs: 0, requests: 0, jobs: 0 })
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      expect(yield* fs.readDirectory(path.join(options.dataDirectory, "documents"))).toEqual([])
      yield* query("fixture", () => sql.raw("DROP TRIGGER fail_outbox").execute(db))
      yield* store.admit(request)
      expect((yield* counts).jobs).toBe(1)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects a failed private file write before creating any job", () => Effect.gen(function* () {
    const options = yield* fixture()
    const request = yield* admission()
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = path.join(options.dataDirectory, "documents")
      yield* fs.remove(directory, { recursive: true })
      yield* fs.writeFileString(directory, "not a directory")
      expect((yield* store.admit(request).pipe(Effect.flip)).code).toBe("storage-failed")
      expect(yield* counts).toEqual({ documents: 0, runs: 0, requests: 0, jobs: 0 })
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("reconciles abandoned files and damaged accepted sources before they can dispatch", () => Effect.gen(function* () {
    const options = yield* fixture()
    const request = yield* admission()
    const accepted = yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      return yield* store.admit(request)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = path.join(options.dataDirectory, "documents")
    yield* fs.makeDirectory(path.join(directory, "orphan-before-commit"))
    yield* fs.writeFileString(path.join(directory, "orphan-before-commit", ".source.tmp"), "partial upload")
    yield* fs.writeFile(path.join(directory, accepted.documentId, "source.pdf"), new Uint8Array(request.bytes.byteLength))
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      expect((yield* store.status(one, accepted.documentId)).state._tag).toBe("failed")
      expect((yield* store.original(one, accepted.documentId).pipe(Effect.flip)).code).toBe("storage-failed")
      expect(yield* store.claimNext({ workerId: "worker", leaseMilliseconds: 10000 })).toBeNull()
      expect(yield* fs.exists(path.join(directory, "orphan-before-commit"))).toBe(false)
      expect((yield* counts).jobs).toBe(0)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("conceals expiry immediately and cleans expired files on restart", () => Effect.gen(function* () {
    const options = yield* fixture({ retentionMilliseconds: 1000 })
    const request = yield* admission()
    const accepted = yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const admitted = yield* store.admit(request)
      yield* TestClock.adjust(1001)
      expect(yield* store.list(one)).toEqual([])
      expect((yield* store.detail(one, admitted.documentId).pipe(Effect.flip)).code).toBe("not-found")
      expect((yield* store.original(one, admitted.documentId).pipe(Effect.flip)).code).toBe("not-found")
      expect((yield* store.admit(request).pipe(Effect.flip)).code).toBe("not-found")
      return admitted
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      expect(yield* fs.exists(path.join(options.dataDirectory, "documents", accepted.documentId))).toBe(false)
      expect((yield* store.detail(two, accepted.documentId).pipe(Effect.flip)).code).toBe("not-found")
      expect((yield* counts).jobs).toBe(0)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("permits only terminal deletion and keeps deleted IDs concealed after restart", () => Effect.gen(function* () {
    const options = yield* fixture()
    const request = yield* admission()
    const accepted = yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const admitted = yield* store.admit(request)
      expect((yield* store.delete(one, admitted.documentId).pipe(Effect.flip)).code).toBe("conflict")
      const current = yield* claim
      yield* store.updateRun(current, yield* failedState)
      yield* store.delete(one, admitted.documentId)
      expect(yield* store.list(one)).toEqual([])
      expect((yield* store.detail(one, admitted.documentId).pipe(Effect.flip)).code).toBe("not-found")
      expect((yield* store.detail(two, admitted.documentId).pipe(Effect.flip)).code).toBe("not-found")
      return admitted
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      expect((yield* store.original(one, accepted.documentId).pipe(Effect.flip)).code).toBe("not-found")
      expect((yield* store.admit(request).pipe(Effect.flip)).code).toBe("not-found")
      expect(yield* fs.exists(path.join(options.dataDirectory, "documents", accepted.documentId))).toBe(false)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("retains charged and outstanding provider reservations when private document payload is deleted", () => Effect.gen(function* () {
    const options = yield* fixture()
    const request = yield* admission()
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const { db, query } = yield* StorageDatabase
      const accepted = yield* store.admit(request)
      const current = yield* claim
      yield* store.updateRun(current, yield* failedState)
      yield* query("fixture", () => db.insertInto("provider_charges").values([
        { attempt_id: "spent-attempt", budget_id: "authorized-budget", reserved_microusd: 1000, actual_microusd: 900 },
        { attempt_id: "uncertain-attempt", budget_id: "authorized-budget", reserved_microusd: 2000, actual_microusd: null },
      ]).execute())
      yield* store.delete(one, accepted.documentId)
      const charges = yield* query("fixture", () => db.selectFrom("provider_charges").selectAll().orderBy("attempt_id").execute())
      expect(charges).toEqual([
        { attempt_id: "spent-attempt", budget_id: "authorized-budget", reserved_microusd: 1000, actual_microusd: 900 },
        { attempt_id: "uncertain-attempt", budget_id: "authorized-budget", reserved_microusd: 2000, actual_microusd: null },
      ])
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("enforces global running uniqueness in SQLite even when callers bypass the store methods", () => Effect.gen(function* () {
    const options = yield* fixture()
    const first = yield* admission()
    const second = yield* admission(two)
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const { db, query } = yield* StorageDatabase
      yield* store.admit(first)
      yield* store.admit(second)
      const current = yield* claim
      const other = yield* query("fixture", () => db.selectFrom("runs").selectAll().where("state", "=", "queued").executeTakeFirstOrThrow())
      const error = yield* query("fixture", () => db.updateTable("runs").set({ state: "running", claim_token: "bypassed", worker_id: "other-worker", lease_expires_at: current.leaseExpiresAt }).where("id", "=", other.id).execute()).pipe(Effect.flip)
      expect(error.code).toBe("storage-failed")
      expect(String(error.cause)).toContain("UNIQUE")
      expect((yield* query("fixture", () => db.selectFrom("runs").select("id").where("state", "=", "running").execute()))).toHaveLength(1)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("frees expired queue capacity before a fresh admission without requiring restart", () => Effect.gen(function* () {
    const options = yield* fixture({ retentionMilliseconds: 1000, queueLimit: 1 })
    const first = yield* admission()
    const second = yield* admission(one, "fresh-request")
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const old = yield* store.admit(first)
      yield* TestClock.adjust(1001)
      const fresh = yield* store.admit(second)
      expect(fresh.documentId).not.toBe(old.documentId)
      expect((yield* claim).document.id).toBe(fresh.documentId)
      expect((yield* counts).jobs).toBe(1)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("replays an equivalent configuration regardless of property order", () => Effect.gen(function* () {
    const options = yield* fixture()
    const request = yield* admission()
    const reordered = yield* Schema.decodeUnknownEffect(Admission)({ ...request, configuration: Object.fromEntries(Object.entries(request.configuration).toReversed()) })
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const accepted = yield* store.admit(request)
      expect(yield* store.admit(reordered)).toEqual(accepted)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("refuses to migrate provider attempts whose spending reservation cannot be attributed", () => Effect.gen(function* () {
    const options = yield* fixture()
    const request = yield* admission()
    yield* Effect.gen(function* () {
      const accepted = yield* (yield* DocumentStore).admit(request)
      const { db, query } = yield* StorageDatabase
      yield* query("fixture", () => db.insertInto("provider_attempts").values({
        id: "legacy-attempt", owner_id: one, document_id: accepted.documentId, run_id: accepted.runId,
        stage_key: "extraction", fingerprint: "legacy", status: "unknown", receipt_json: "{}", intent_json: "{}",
        response_json: null, claim_token: "legacy", lease_expires_at: 1, dispatch_started_at: 0, remote_id: null,
        reserved_microusd: 100000, actual_microusd: null, created_at: 0, updated_at: 1, validation_state: null,
      }).execute())
      yield* query("fixture", () => sql`PRAGMA user_version=1`.execute(db))
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
    const reopened = yield* Effect.gen(function* () { yield* DocumentStore }).pipe(Effect.provide(makeDocumentStoreLayer(options)), Effect.result)
    expect(reopened).toMatchObject({ _tag: "Failure", failure: { code: "storage-failed", operation: "migration" } })
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("upgrades version-one application tables while preserving accepted work", () => Effect.gen(function* () {
    const options = yield* fixture()
    const request = yield* admission()
    const accepted = yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const { db, query } = yield* StorageDatabase
      const admitted = yield* store.admit(request)
      yield* query("fixture", () => sql`ALTER TABLE provider_attempts DROP COLUMN validation_state`.execute(db))
      yield* query("fixture", () => sql`DROP TABLE provider_charges`.execute(db))
      yield* query("fixture", () => sql`PRAGMA user_version=1`.execute(db))
      return admitted
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
    yield* Effect.gen(function* () {
      const store = yield* DocumentStore
      const { db, query } = yield* StorageDatabase
      expect(yield* store.admit(request)).toEqual(accepted)
      const columns = yield* query("fixture", () => sql<{ name: string }>`PRAGMA table_info(provider_attempts)`.execute(db))
      expect(columns.rows.map((row) => row.name)).toContain("validation_state")
      expect(yield* query("fixture", () => db.selectFrom("provider_charges").selectAll().execute())).toEqual([])
      expect((yield* query("fixture", () => sql<{ user_version: number }>`PRAGMA user_version`.execute(db))).rows[0]?.user_version).toBe(5)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))
})
