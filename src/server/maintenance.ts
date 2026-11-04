import { Effect, Redacted, Schema, Semaphore, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { DocumentStore, StorageDatabase, type StorageFailure } from "../storage/index.ts"
import { RetentionTarget, type makeDocumentRetention } from "./retention.ts"

export class MaintenanceFailure extends Schema.TaggedError<MaintenanceFailure>()("MaintenanceFailure", {
  operation: Schema.Literals(["configuration", "target", "response", "deadline"]),
  message: Schema.String,
}) {}
const failure = (operation: MaintenanceFailure["operation"]) => new MaintenanceFailure({ operation, message: "Document maintenance could not complete this operation." })
const JobId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u))
const batchSize = 10
const responseBytes = 65_536
export interface MaintenanceOptions {
  readonly purge: ReturnType<typeof makeDocumentRetention>["purge"]
  readonly mineru: { readonly endpoint: string; readonly token: Redacted.Redacted<string> } | null
}
export interface MaintenanceReport {
  readonly reconciliationFailed: boolean
  readonly documentsVisited: number
  readonly documentsPurged: number
  readonly localFailures: number
  readonly remoteAttempted: number
  readonly remoteDeleted: number
  readonly remotePending: number
  readonly remoteDisabled: boolean
}

export const makeDocumentMaintenance = Effect.fn("makeDocumentMaintenance")(function* (options: MaintenanceOptions) {
  const documents = yield* DocumentStore
  const database = yield* StorageDatabase
  const client = yield* HttpClient.HttpClient
  const serial = yield* Semaphore.make(1)
  let documentCursor = ""
  let remoteCursor = ""
  const remote = options.mineru
  const endpoint = remote === null ? null : URL.parse(remote.endpoint)
  if (remote !== null && (endpoint === null || endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "" || !/^(?:(?:[a-z0-9-]+--)?amuseme-(?:staging|production)-mineru(?:-[a-z0-9-]+)?\.(?:[a-z0-9-]+\.)?modal\.run|amuseme-[a-z0-9-]+\.invalid)$/iu.test(endpoint.hostname) || Redacted.value(remote.token).trim() === "")) return yield* failure("configuration")
  const base = endpoint?.href.replace(/\/$/u, "")
  const purgeRemote = Effect.fnUntraced(function* (jobId: string) {
    if (remote === null || base === undefined) return false
    yield* Schema.decodeUnknownEffect(JobId)(jobId).pipe(Effect.mapError(() => failure("target")))
    const url = `${base}/jobs/${jobId}`
    return yield* Effect.gen(function* () {
      const response = yield* client.execute(HttpClientRequest.make("DELETE")(url).pipe(HttpClientRequest.bearerToken(remote.token))).pipe(Effect.mapError(() => failure("response")))
      if (response.status >= 300 && response.status < 400 || response.url !== "" && response.url !== url) return yield* failure("response")
      const declared = response.headers["content-length"]
      if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > responseBytes)) return yield* failure("response")
      let received = 0
      yield* response.stream.pipe(Stream.runForEach((chunk) => {
        received += chunk.byteLength
        return received > responseBytes ? Effect.fail(failure("response")) : Effect.void
      }), Effect.catchTag("HttpClientError", (error) => error.reason._tag === "EmptyBodyError" ? Effect.void : Effect.fail(failure("response"))), Effect.mapError(() => failure("response")))
      if (declared !== undefined && Number(declared) !== received) return yield* failure("response")
      return response.status === 204 || response.status === 404
    }).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }), Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(failure("deadline")) }), Effect.scoped)
  })
  const runOnce = Effect.fn("DocumentMaintenance.runOnce")(function* (): Effect.fn.Return<MaintenanceReport, MaintenanceFailure | StorageFailure> {
    const reconciliation = yield* Effect.result(documents.reconcile())
    const localBatch = (after: string) => database.query("maintenance-documents", () => database.db.selectFrom("documents").select(["id", "owner_id"]).where("lifecycle", "in", ["deleted", "expired"]).where("id", ">", after).orderBy("id", "asc").limit(batchSize).execute())
    let inactive = yield* localBatch(documentCursor)
    if (inactive.length === 0 && documentCursor !== "") { documentCursor = ""; inactive = yield* localBatch(documentCursor) }
    const localResults = yield* Effect.forEach(inactive, (row) => Effect.gen(function* () {
      documentCursor = row.id
      const runRows = yield* database.query("maintenance-runs", () => database.db.selectFrom("runs").select(["state", "mastra_run_id"]).where("document_id", "=", row.id).where("owner_id", "=", row.owner_id).limit(1001).execute())
      if (runRows.some((run) => run.state === "running" || run.state === "queued")) return false
      const result = yield* Schema.decodeUnknownEffect(RetentionTarget)({ documentId: row.id, ownerId: row.owner_id, mastraRunIds: runRows.map((run) => run.mastra_run_id) }).pipe(Effect.mapError(() => failure("target")), Effect.flatMap(options.purge), Effect.result)
      return result._tag === "Success"
    }))
    let remoteAttempted = 0
    let remoteDeleted = 0
    if (remote !== null) {
      const remoteBatch = (after: string) => database.query("maintenance-remote", () => database.db.selectFrom("remote_cleanup").selectAll().where("job_id", ">", after).orderBy("job_id", "asc").limit(batchSize).execute())
      let pending = yield* remoteBatch(remoteCursor)
      if (pending.length === 0 && remoteCursor !== "") { remoteCursor = ""; pending = yield* remoteBatch(remoteCursor) }
      for (const row of pending) {
        remoteCursor = row.job_id
        remoteAttempted += 1
        const result = yield* Effect.result(purgeRemote(row.job_id))
        if (result._tag === "Success" && result.success) {
          const removed = yield* database.query("maintenance-confirm-remote", () => database.db.deleteFrom("remote_cleanup").where("job_id", "=", row.job_id).where("document_id", "=", row.document_id).where("created_at", "=", row.created_at).executeTakeFirst())
          remoteDeleted += Number(removed.numDeletedRows)
        }
      }
    }
    const remaining = yield* database.query("maintenance-pending", () => database.db.selectFrom("remote_cleanup").select((expression) => expression.fn.countAll<number>().as("count")).executeTakeFirstOrThrow())
    return { reconciliationFailed: reconciliation._tag === "Failure", documentsVisited: inactive.length, documentsPurged: localResults.filter(Boolean).length, localFailures: localResults.filter((value) => !value).length, remoteAttempted, remoteDeleted, remotePending: remaining.count, remoteDisabled: remote === null }
  }, serial.withPermit)
  return { runOnce }
})
