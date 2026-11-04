import { LibsqlDialect } from "@libsql/kysely-libsql"
import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect"
import { Kysely, sql } from "kysely"
import { StorageFailure, storageFailure, type StorageOptions } from "./service.ts"

export interface DocumentRow {
  id: string
  owner_id: string
  document_json: string
  lifecycle: string
  expires_at: number
  latest_run_id: string
}
export interface RunRow {
  id: string
  document_id: string
  owner_id: string
  state: string
  mastra_run_id: string
  run_json: string
  created_at: number
  claim_token: string | null
  worker_id: string | null
  lease_expires_at: number | null
}
export interface ProviderAttemptRow {
  id: string
  owner_id: string
  document_id: string
  run_id: string
  stage_key: string
  fingerprint: string
  status: string
  receipt_json: string
  intent_json: string
  response_json: string | null
  claim_token: string
  lease_expires_at: number
  dispatch_started_at: number | null
  remote_id: string | null
  reserved_microusd: number
  actual_microusd: number | null
  created_at: number
  updated_at: number
  validation_state: string | null
}
export interface ApplicationDatabase {
  documents: DocumentRow
  runs: RunRow
  admission_requests: { owner_id: string; request_key: string; fingerprint: string; document_id: string; run_id: string }
  accepted_jobs: { run_id: string }
  provider_attempts: ProviderAttemptRow
  provider_charges: { attempt_id: string; budget_id: string; reserved_microusd: number; actual_microusd: number | null }
  outputs: { revision_id: string; document_id: string; run_id: string; manifest_json: string }
  ratings: { revision_id: string; owner_id: string; value: "up" | "down"; updated_at: number }
  document_policies: { document_id: string; budget_id: string; policy_json: string }
  retry_requests: { id: string; owner_id: string; document_id: string; previous_run_id: string; run_id: string; request_key: string; acknowledges_unknown: number; budget_id: string; created_at: number }
  retry_authorizations: { id: string; request_id: string; previous_attempt_id: string; run_id: string; stage_key: string; fingerprint: string; acknowledges_unknown: number; consumed_attempt_id: string | null }
  remote_cleanup: { job_id: string; document_id: string; created_at: number }
  validator_repairs: { attempt_id: string; owner_id: string; document_id: string; previous_run_id: string; run_id: string; response_hash: string; request_fingerprint: string; validator_fix_id: string; validator_fix_hash: string; old_receipt_json: string; new_receipt_json: string; policy_json: string; repaired_at: number }
}

export const storageQuery = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, StorageFailure> =>
  Effect.tryPromise({ try: run, catch: (cause) => storageFailure(operation, cause) }).pipe(Effect.uninterruptible)

export class StorageDatabase extends Context.Service<StorageDatabase, {
  readonly db: Kysely<ApplicationDatabase>
  readonly query: typeof storageQuery
  readonly transaction: <A, E, R>(work: (db: Kysely<ApplicationDatabase>) => Effect.Effect<A, E, R>) => Effect.Effect<A, E | StorageFailure, R>
}>()("amuseme/storage/StorageDatabase") {}

const migration = [
  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, document_json TEXT NOT NULL CHECK(json_valid(document_json)),
    lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','expired','deleted')), expires_at INTEGER NOT NULL, latest_run_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), owner_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','succeeded-with-issues','failed','interrupted')),
    mastra_run_id TEXT NOT NULL UNIQUE, run_json TEXT NOT NULL CHECK(json_valid(run_json)), created_at INTEGER NOT NULL,
    claim_token TEXT, worker_id TEXT, lease_expires_at INTEGER,
    CHECK((state='running' AND claim_token IS NOT NULL AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state!='running' AND claim_token IS NULL AND worker_id IS NULL AND lease_expires_at IS NULL))
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_owner ON runs(owner_id) WHERE state IN ('queued','running')",
  "CREATE UNIQUE INDEX IF NOT EXISTS one_running_run_globally ON runs((1)) WHERE state='running'",
  "CREATE INDEX IF NOT EXISTS document_owner ON documents(owner_id,lifecycle,expires_at)",
  `CREATE TABLE IF NOT EXISTS admission_requests (
    owner_id TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
    document_id TEXT NOT NULL REFERENCES documents(id), run_id TEXT NOT NULL REFERENCES runs(id),
    PRIMARY KEY(owner_id,request_key)
  )`,
  "CREATE TABLE IF NOT EXISTS accepted_jobs (run_id TEXT PRIMARY KEY REFERENCES runs(id))",
  `CREATE TABLE IF NOT EXISTS provider_attempts (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id), run_id TEXT NOT NULL REFERENCES runs(id),
    stage_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('prepared','dispatching','submitted','completed','failed','unknown')),
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),
    response_json TEXT, claim_token TEXT NOT NULL, lease_expires_at INTEGER NOT NULL, dispatch_started_at INTEGER,
    remote_id TEXT, reserved_microusd INTEGER NOT NULL CHECK(reserved_microusd>=0),
    actual_microusd INTEGER CHECK(actual_microusd>=0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    validation_state TEXT CHECK(validation_state IN ('pending','accepted','rejected'))
  )`,
  "CREATE INDEX IF NOT EXISTS attempts_for_stage ON provider_attempts(run_id,stage_key,created_at)",
  "CREATE INDEX IF NOT EXISTS attempt_status ON provider_attempts(status)",
  `CREATE TABLE IF NOT EXISTS provider_charges (
    attempt_id TEXT PRIMARY KEY, budget_id TEXT NOT NULL, reserved_microusd INTEGER NOT NULL CHECK(reserved_microusd>=0),
    actual_microusd INTEGER CHECK(actual_microusd>=0)
  )`,
  "CREATE INDEX IF NOT EXISTS charges_for_budget ON provider_charges(budget_id)",
  `CREATE TABLE IF NOT EXISTS outputs (
    revision_id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
    run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json))
  )`,
  `CREATE TABLE IF NOT EXISTS ratings (
    revision_id TEXT NOT NULL REFERENCES outputs(revision_id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
    value TEXT NOT NULL CHECK(value IN ('up','down')), updated_at INTEGER NOT NULL,
    PRIMARY KEY(revision_id,owner_id)
  )`,
  `CREATE TABLE IF NOT EXISTS document_policies (
    document_id TEXT PRIMARY KEY REFERENCES documents(id), budget_id TEXT NOT NULL,
    policy_json TEXT NOT NULL CHECK(json_valid(policy_json))
  )`,
  `CREATE TABLE IF NOT EXISTS retry_requests (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id),
    previous_run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
    request_key TEXT NOT NULL, acknowledges_unknown INTEGER NOT NULL CHECK(acknowledges_unknown IN (0,1)),
    budget_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(owner_id,request_key)
  )`,
  `CREATE TABLE IF NOT EXISTS retry_authorizations (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES retry_requests(id) ON DELETE CASCADE,
    previous_attempt_id TEXT NOT NULL REFERENCES provider_attempts(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(id), stage_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
    acknowledges_unknown INTEGER NOT NULL CHECK(acknowledges_unknown IN (0,1)),
    consumed_attempt_id TEXT UNIQUE REFERENCES provider_attempts(id), UNIQUE(run_id,stage_key)
  )`,
  "CREATE TABLE IF NOT EXISTS remote_cleanup (job_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, created_at INTEGER NOT NULL)",
  `CREATE TABLE IF NOT EXISTS validator_repairs (
    attempt_id TEXT PRIMARY KEY REFERENCES provider_attempts(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL, document_id TEXT NOT NULL REFERENCES documents(id),
    previous_run_id TEXT NOT NULL REFERENCES runs(id), run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
    response_hash TEXT NOT NULL, request_fingerprint TEXT NOT NULL, validator_fix_id TEXT NOT NULL, validator_fix_hash TEXT NOT NULL,
    old_receipt_json TEXT NOT NULL CHECK(json_valid(old_receipt_json)), new_receipt_json TEXT NOT NULL CHECK(json_valid(new_receipt_json)),
    policy_json TEXT NOT NULL CHECK(json_valid(policy_json)), repaired_at INTEGER NOT NULL
  )`,
] as const

export const makeStorageDatabase = Effect.fn("makeStorageDatabase")(function* (options: StorageOptions) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  if (!path.isAbsolute(options.dataDirectory)) {
    return yield* storageFailure("configuration", "Expected an absolute private data directory")
  }
  const directory = options.dataDirectory
  const databasePath = path.join(directory, "application.sqlite")
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
    yield* fs.chmod(directory, 0o700)
    const file = yield* fs.open(databasePath, { flag: "a", mode: 0o600, noFollow: true })
    yield* file.sync
    yield* fs.chmod(databasePath, 0o600)
  }).pipe(Effect.scoped, Effect.mapError((cause) => storageFailure("initialize", cause)))
  const url = yield* path.toFileUrl(databasePath).pipe(Effect.mapError((cause) => storageFailure("configuration", cause)))
  const db = yield* Effect.acquireRelease(
    Effect.try({ try: () => new Kysely<ApplicationDatabase>({ dialect: new LibsqlDialect({ url: url.href }) }), catch: (cause) => storageFailure("initialize", cause) }),
    (database) => storageQuery("close", () => database.destroy()).pipe(Effect.orDie),
  )
  const gate = yield* Semaphore.make(1)
  const transaction = <A, E, R>(work: (database: Kysely<ApplicationDatabase>) => Effect.Effect<A, E, R>) => gate.withPermit(
    Effect.gen(function* () {
      const tx = yield* Effect.acquireRelease(
        storageQuery("begin", () => db.startTransaction().execute()),
        (current) => current.isCommitted || current.isRolledBack ? Effect.void : storageQuery("rollback", () => current.rollback().execute()).pipe(Effect.orDie),
      )
      const value = yield* work(tx)
      yield* storageQuery("commit", () => tx.commit().execute())
      return value
    }).pipe(Effect.scoped, Effect.uninterruptible),
  )
  yield* storageQuery("configure", () => sql`PRAGMA foreign_keys=ON`.execute(db))
  yield* storageQuery("configure", () => sql`PRAGMA busy_timeout=5000`.execute(db))
  yield* storageQuery("configure", () => sql`PRAGMA synchronous=FULL`.execute(db))
  const version = yield* storageQuery("migration", () => sql<{ user_version: number }>`PRAGMA user_version`.execute(db))
  const currentVersion = yield* Schema.decodeUnknownEffect(Schema.Int)(version.rows[0]?.user_version).pipe(Effect.mapError((cause) => storageFailure("migration", cause)))
  if (currentVersion > 5) return yield* storageFailure("migration", "Application database is newer than this application")
  yield* transaction((database) => Effect.gen(function* () {
    yield* Effect.forEach(migration, (statement) => storageQuery("migration", () => sql.raw(statement).execute(database)), { discard: true })
    const columns = yield* storageQuery("migration", () => sql<{ name: string }>`PRAGMA table_info(provider_attempts)`.execute(database))
    if (!columns.rows.some((column) => column.name === "validation_state")) {
      yield* storageQuery("migration", () => sql`ALTER TABLE provider_attempts ADD COLUMN validation_state TEXT CHECK(validation_state IN ('pending','accepted','rejected'))`.execute(database))
    }
    const unaccounted = yield* storageQuery("migration", () => database.selectFrom("provider_attempts")
      .leftJoin("provider_charges", "provider_charges.attempt_id", "provider_attempts.id")
      .select("provider_attempts.id").where("provider_charges.attempt_id", "is", null).executeTakeFirst())
    if (unaccounted !== undefined) return yield* storageFailure("migration", "Provider attempts have no spending ledger; reconcile their authorized budget before opening this database")
    yield* storageQuery("migration", () => sql`PRAGMA user_version=5`.execute(database))
  }))
  return StorageDatabase.of({ db, query: storageQuery, transaction })
})

export const makeStorageDatabaseLayer = (options: StorageOptions) => Layer.effect(StorageDatabase, makeStorageDatabase(options))
