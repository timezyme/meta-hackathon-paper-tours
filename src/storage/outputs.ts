import { Clock, Context, DateTime, Effect, Layer, Schema } from "effect"
import type { Kysely } from "kysely"
import { ArtifactManifest, CanonicalDocument, Extraction, ImageManifest, ProcessingReport, RatingValue, Run, validatePublication, validateRunTransition, type DocumentId, type OutputRevisionId, type UserId } from "../domain/index.ts"
import { ArtifactStore } from "./artifacts.ts"
import { StorageDatabase, type ApplicationDatabase } from "./database.ts"
import { DocumentStore, StorageFailure, documentNotFound, storageConflict, type DispatchClaim } from "./service.ts"

export const Publication = Schema.Struct({ extraction: Extraction, canonical: CanonicalDocument, images: ImageManifest, manifest: ArtifactManifest, report: ProcessingReport })
export type Publication = typeof Publication.Type
export class OutputStore extends Context.Service<OutputStore, {
  readonly publish: (claim: DispatchClaim, publication: Publication) => Effect.Effect<Run, StorageFailure>
  readonly manifest: (ownerId: UserId, documentId: DocumentId, revisionId: OutputRevisionId) => Effect.Effect<ArtifactManifest, StorageFailure>
  readonly read: (ownerId: UserId, documentId: DocumentId, revisionId: OutputRevisionId, filename: string) => Effect.Effect<{ readonly bytes: Uint8Array; readonly entry: ArtifactManifest["entries"][number] }, StorageFailure>
  readonly rating: (ownerId: UserId, documentId: DocumentId, revisionId: OutputRevisionId) => Effect.Effect<"up" | "down" | null, StorageFailure>
  readonly rate: (ownerId: UserId, documentId: DocumentId, revisionId: OutputRevisionId, value: "up" | "down" | null) => Effect.Effect<void, StorageFailure>
}>()("amuseme/storage/OutputStore") {}

const invalid = (cause: unknown) => new StorageFailure({ code: "invalid-artifacts", operation: "output", message: "The normalized output is incomplete or damaged", cause })
const decode = <A>(schema: Schema.Codec<A, unknown>, value: unknown) => Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(Effect.mapError(invalid))
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const sameBytes = (one: Uint8Array, two: Uint8Array) => one.length === two.length && one.every((byte, index) => byte === two[index])

export const makeOutputStore = Effect.fn("makeOutputStore")(function* () {
  const documents = yield* DocumentStore
  const artifacts = yield* ArtifactStore
  const database = yield* StorageDatabase
  const { db, query, transaction } = database
  const lookup = Effect.fnUntraced(function* (connection: Kysely<ApplicationDatabase>, ownerId: UserId, documentId: DocumentId, revisionId: OutputRevisionId) {
    const now = yield* Clock.currentTimeMillis
    const row = yield* query("read-output", () => connection.selectFrom("outputs").innerJoin("documents", "documents.id", "outputs.document_id")
      .selectAll("outputs").where("documents.id", "=", documentId).where("documents.owner_id", "=", ownerId)
      .where("documents.lifecycle", "=", "active").where("documents.expires_at", ">", now).where("outputs.revision_id", "=", revisionId).executeTakeFirst())
    if (row === undefined) return yield* documentNotFound()
    const manifest = yield* decode(Schema.fromJsonString(ArtifactManifest), row.manifest_json)
    if (manifest.scope.documentId !== documentId || manifest.scope.revisionId !== revisionId || manifest.scope.runId !== row.run_id) return yield* invalid("Manifest scope does not match its publication")
    return manifest
  })
  const manifest = (ownerId: UserId, documentId: DocumentId, revisionId: OutputRevisionId) => lookup(db, ownerId, documentId, revisionId)
  const read = Effect.fn("OutputStore.read")(function* (ownerId: UserId, documentId: DocumentId, revisionId: OutputRevisionId, filename: string) {
    const published = yield* manifest(ownerId, documentId, revisionId)
    const entry = published.entries.find((item) => item.path === filename)
    if (entry === undefined) return yield* documentNotFound()
    const bytes = yield* artifacts.read(ownerId, documentId, { hash: entry.hash, byteCount: entry.byteCount })
    yield* manifest(ownerId, documentId, revisionId)
    return { bytes, entry }
  })
  const publish = Effect.fn("OutputStore.publish")(function* (claim: DispatchClaim, input: Publication) {
    const publication = yield* decode(Publication, input)
    const { document } = yield* documents.detail(claim.document.ownerId, claim.document.id)
    for (const entry of publication.manifest.entries) {
      const bytes = yield* artifacts.read(claim.document.ownerId, claim.document.id, { hash: entry.hash, byteCount: entry.byteCount })
      const expected = entry.path === "document.json" ? publication.canonical : entry.path === "images.json" ? publication.images : entry.path === "processing-report.json" ? publication.report : undefined
      if (expected !== undefined && !sameBytes(bytes, jsonBytes(expected))) return yield* invalid("Stored JSON bytes differ from the publication")
    }
    return yield* transaction((connection) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const row = yield* query("publish-fence", () => connection.selectFrom("runs").innerJoin("documents", "documents.id", "runs.document_id").selectAll("runs")
        .where("runs.id", "=", claim.run.id).where("runs.owner_id", "=", claim.document.ownerId).where("runs.document_id", "=", claim.document.id)
        .where("runs.state", "=", "running").where("runs.claim_token", "=", claim.claimToken).where("runs.lease_expires_at", ">", now)
        .where("documents.lifecycle", "=", "active").where("documents.expires_at", ">", now).executeTakeFirst())
      if (row === undefined) return yield* storageConflict("publish", "The processing claim is no longer active")
      const current = yield* decode(Schema.fromJsonString(Run), row.run_json)
      if (current.state._tag !== "running") return yield* invalid("Publication requires a running document")
      const run = yield* decode(Run, { ...current, state: { _tag: publication.report.issues.length > 0 ? "succeeded-with-issues" : "succeeded", startedAt: current.state.startedAt, finishedAt: DateTime.formatIso(DateTime.makeUnsafe(now)), revisionId: publication.canonical.scope.revisionId } })
      const violations = [...validatePublication({ document, run, ...publication }), ...validateRunTransition(current, run)]
      if (violations.length > 0) return yield* invalid(violations)
      for (const { receipt } of publication.report.receipts) {
        const saved = yield* query("publish-receipt", () => connection.selectFrom("provider_attempts").select(["receipt_json", "validation_state", "status"])
          .where("id", "=", receipt.id).where("owner_id", "=", claim.document.ownerId).where("document_id", "=", claim.document.id).executeTakeFirst())
        if (saved === undefined || saved.receipt_json !== JSON.stringify(receipt)
          || (receipt.state._tag === "completed" && receipt.state.validation._tag === "accepted" && (saved.status !== "completed" || saved.validation_state !== "accepted"))) return yield* invalid("Report receipt differs from its durable provider record")
      }
      yield* query("publish-output", () => connection.insertInto("outputs").values({ revision_id: publication.canonical.scope.revisionId, document_id: claim.document.id, run_id: run.id, manifest_json: JSON.stringify(publication.manifest) }).execute())
      yield* query("publish-run", () => connection.updateTable("runs").set({ state: run.state._tag, run_json: JSON.stringify(run), claim_token: null, worker_id: null, lease_expires_at: null }).where("id", "=", run.id).execute())
      yield* query("publish-queue", () => connection.deleteFrom("accepted_jobs").where("run_id", "=", run.id).execute())
      return run
    }))
  })
  const rating = Effect.fn("OutputStore.rating")(function* (ownerId: UserId, documentId: DocumentId, revisionId: OutputRevisionId) {
    yield* manifest(ownerId, documentId, revisionId)
    const row = yield* query("read-rating", () => db.selectFrom("ratings").select("value").where("revision_id", "=", revisionId).where("owner_id", "=", ownerId).executeTakeFirst())
    return row === undefined ? null : yield* decode(RatingValue, row.value)
  })
  const rate = Effect.fn("OutputStore.rate")(function* (ownerId: UserId, documentId: DocumentId, revisionId: OutputRevisionId, value: "up" | "down" | null) {
    const decoded = yield* decode(Schema.NullOr(RatingValue), value)
    yield* transaction((connection) => Effect.gen(function* () {
      yield* lookup(connection, ownerId, documentId, revisionId)
      if (decoded === null) {
        yield* query("clear-rating", () => connection.deleteFrom("ratings").where("revision_id", "=", revisionId).where("owner_id", "=", ownerId).execute())
      } else {
        const now = yield* Clock.currentTimeMillis
        yield* query("write-rating", () => connection.insertInto("ratings").values({ revision_id: revisionId, owner_id: ownerId, value: decoded, updated_at: now })
          .onConflict((conflict) => conflict.columns(["revision_id", "owner_id"]).doUpdateSet({ value: decoded, updated_at: now })).execute())
      }
    }))
  })
  return OutputStore.of({ publish, manifest, read, rating, rate })
})

export const makeOutputStoreLayer = Layer.effect(OutputStore, makeOutputStore())
