import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, FileSystem, Path, Result } from "effect"
import { sql, type Kysely } from "kysely"
import { StorageDatabase, makeStorageDatabaseLayer, type ApplicationDatabase, type StorageOptions } from "../../src/storage/index.ts"
import { holdReadLock } from "../fixtures/read-lock.ts"

const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-database-" })
  const options: StorageOptions = { dataDirectory: path.join(root, "private"), queueLimit: 10 }
  return { options, databasePath: path.join(options.dataDirectory, "application.sqlite") }
})
const insert = (database: Kysely<ApplicationDatabase>, id: string) => sql`INSERT INTO documents (id, owner_id, document_json, lifecycle, expires_at, latest_run_id) VALUES (${id}, 'owner', '{}', 'active', 0, 'run')`.execute(database)
const write = (id: string) => Effect.flatMap(StorageDatabase, ({ transaction, query }) => transaction((database) => query("test-write", () => insert(database, id))))
const ids = Effect.flatMap(StorageDatabase, ({ db, query }) => query("test-read", () => db.selectFrom("documents").select("id").orderBy("id").execute()))

describe("application database", () => {
  it.live("waits for another process's read lock instead of failing with SQLITE_BUSY", () => Effect.gen(function* () {
    const { options, databasePath } = yield* fixture()
    yield* Effect.gen(function* () {
      yield* write("before-lock")
      const lock = yield* holdReadLock(databasePath, "documents", 300)
      yield* lock.arm
      yield* write("during-lock")
      const finished = yield* Clock.currentTimeMillis
      const releasedAt = yield* lock.released
      // A write that finished before the release never met the lock, so it proves nothing.
      expect(finished).toBeGreaterThanOrEqual(releasedAt)
      expect((yield* ids).map((row) => row.id)).toEqual(["before-lock", "during-lock"])
    }).pipe(Effect.scoped, Effect.provide(makeStorageDatabaseLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)), 15000)

  // Kysely's SQLite adapter runs one query at a time, but the libsql client still
  // swaps connections around transactions. Read the settings inside and after one.
  it.live("keeps the busy timeout and foreign keys on the connections used around transactions", () => Effect.gen(function* () {
    const { options } = yield* fixture()
    yield* Effect.gen(function* () {
      const { db, query, transaction } = yield* StorageDatabase
      const settings = (database: Kysely<ApplicationDatabase>) => Effect.all({
        timeout: query("test-read", () => sql<{ timeout: number }>`PRAGMA busy_timeout`.execute(database)).pipe(Effect.map((result) => result.rows[0]?.timeout)),
        foreignKeys: query("test-read", () => sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(database)).pipe(Effect.map((result) => result.rows[0]?.foreign_keys)),
      })
      const inside = yield* transaction(settings)
      expect(inside).toEqual({ timeout: 5000, foreignKeys: 1 })
      expect(yield* settings(db)).toEqual({ timeout: 5000, foreignKeys: 1 })
      expect(yield* transaction(settings)).toEqual({ timeout: 5000, foreignKeys: 1 })
    }).pipe(Effect.provide(makeStorageDatabaseLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)), 15000)

  it.live("fails a write held up past the timeout, rolls it back, and writes again once the lock is gone", () => Effect.gen(function* () {
    const { options, databasePath } = yield* fixture()
    yield* Effect.gen(function* () {
      yield* write("before-lock")
      yield* Effect.gen(function* () {
        const lock = yield* holdReadLock(databasePath, "documents", 7000)
        yield* lock.arm
        const started = yield* Clock.currentTimeMillis
        const blocked = yield* Effect.result(write("blocked"))
        const waited = (yield* Clock.currentTimeMillis) - started
        expect(Result.isFailure(blocked)).toBe(true)
        expect(waited).toBeGreaterThanOrEqual(4500)
        expect(waited).toBeLessThan(6900)
        yield* lock.released
      }).pipe(Effect.scoped)
      yield* write("after-lock")
      expect((yield* ids).map((row) => row.id)).toEqual(["after-lock", "before-lock"])
    }).pipe(Effect.provide(makeStorageDatabaseLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)), 20000)
})
