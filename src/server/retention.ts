import type { MastraCompositeStore } from "@mastra/core/storage"
import { Effect, Schema } from "effect"
import { DocumentId, UserId } from "../domain/index.ts"

const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u))
export const RetentionTarget = Schema.Struct({ documentId: DocumentId, ownerId: UserId, mastraRunIds: Schema.Array(Identifier).check(Schema.isMaxLength(1000)) })
export type RetentionTarget = typeof RetentionTarget.Type
export class RetentionFailure extends Schema.TaggedError<RetentionFailure>()("RetentionFailure", {
  operation: Schema.Literals(["target", "flush", "stores", "traces", "snapshots", "scope", "deadline"]),
  message: Schema.String,
}) {}
const failure = (operation: RetentionFailure["operation"]) => new RetentionFailure({ operation, message: "Local processing history cleanup did not complete." })

export const makeDocumentRetention = (storage: Pick<MastraCompositeStore, "getStore">, flush: () => Promise<void>) => {
  const purge = Effect.fn("DocumentRetention.purge")(function* (input: RetentionTarget) {
    const target = yield* Schema.decodeUnknownEffect(RetentionTarget)(input, { onExcessProperty: "error" }).pipe(Effect.mapError(() => failure("target")))
    yield* Effect.tryPromise({ try: flush, catch: () => failure("flush") })
    const traces = yield* Effect.tryPromise({ try: () => storage.getStore("observability"), catch: () => failure("stores") })
    const workflows = yield* Effect.tryPromise({ try: () => storage.getStore("workflows"), catch: () => failure("stores") })
    if (traces === undefined || workflows === undefined) return yield* failure("stores")
    let traceCount = 0
    let snapshotCount = 0
    const runIds = [...new Set(target.mastraRunIds)]
    for (const runId of [null, ...runIds]) {
      const seen = new Set<string>()
      for (let batch = 0; batch < 100; batch += 1) {
        const listed = yield* Effect.tryPromise({ try: () => traces.listTraces({
          filters: { resourceId: target.ownerId, ...(runId === null ? { metadata: { documentId: target.documentId } } : { runId }) },
          pagination: { page: 0, perPage: 100 }, orderBy: { field: "startedAt", direction: "ASC" },
        }), catch: () => failure("traces") })
        if (listed.spans.length === 0) break
        if (listed.spans.some((span) => span.resourceId !== target.ownerId || (runId === null ? span.metadata?.documentId !== target.documentId : span.runId !== runId))) return yield* failure("scope")
        const ids = [...new Set(listed.spans.map((span) => span.traceId))]
        if (ids.some((id) => seen.has(id))) return yield* failure("traces")
        yield* Effect.tryPromise({ try: () => traces.batchDeleteTraces({ traceIds: ids }), catch: () => failure("traces") })
        for (const id of ids) seen.add(id)
        traceCount += ids.length
        if (batch === 99) return yield* failure("traces")
      }
    }
    for (const runId of runIds) {
      const saved = yield* Effect.tryPromise({ try: () => workflows.getWorkflowRunById({ runId, workflowName: "normalize-document" }), catch: () => failure("snapshots") })
      if (saved === null) continue
      if (saved.resourceId !== target.ownerId || saved.runId !== runId || saved.workflowName !== "normalize-document") return yield* failure("scope")
      yield* Effect.tryPromise({ try: () => workflows.deleteWorkflowRunById({ runId, workflowName: "normalize-document" }), catch: () => failure("snapshots") })
      snapshotCount += 1
    }
    return { traceCount, snapshotCount }
  }, (effect) => effect.pipe(Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.fail(failure("deadline")) })))
  return { purge }
}
