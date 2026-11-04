// Holds a SQLite read lock from its own process, like the Modal snapshot sidecar.
// Prints "locked" once the shared lock is held, waits for a line on stdin, holds
// the lock for <hold milliseconds> more, then prints "released <epoch ms>".
import { DatabaseSync } from "node:sqlite"

const [databasePath, table, hold] = process.argv.slice(2)
if (databasePath === undefined || table === undefined || hold === undefined) throw new Error("Usage: read-lock-holder.mjs <database> <table> <hold milliseconds>")
const database = new DatabaseSync(databasePath, { readOnly: true })
database.exec("BEGIN")
database.prepare(`SELECT count(*) FROM "${table}"`).get()
process.stdout.write("locked\n")
process.stdin.once("data", () => setTimeout(() => {
  database.exec("ROLLBACK")
  database.close()
  process.stdout.write(`released ${Date.now()}\n`)
  process.exit(0)
}, Number(hold)))
