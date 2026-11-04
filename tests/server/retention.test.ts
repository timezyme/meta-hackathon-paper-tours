import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { SpanType } from "@mastra/core/observability"
import type { WorkflowRunState } from "@mastra/core/workflows"
import { Effect, Result } from "effect"
import { vi } from "vitest"
import { DocumentId, UserId } from "../../src/domain/index.ts"
import { makeDocumentRetention } from "../../src/server/retention.ts"
import { localTraceFixture } from "../fixtures/local-observability.ts"

const target = { documentId: DocumentId.make("doc-one"), ownerId: UserId.make("owner-one"), mastraRunIds: ["workflow-one"] }
const snapshot = (runId: string): WorkflowRunState => ({ runId, status: "success", value: {}, context: {}, serializedStepGraph: [], activePaths: [], activeStepsPath: {}, suspendedPaths: {}, resumeLabels: {}, waitingPaths: {}, timestamp: 1 })

describe("document-linked processing history purge", () => {
  it.live("flushes and deletes multiple trace batches and the target snapshot, preserving other documents and owners", () => Effect.gen(function* () {
    const { storage, mastra, instance, traces, workflows } = yield* localTraceFixture
    for (let index = 0; index < 105; index += 1) instance.startSpan({ type: SpanType.AGENT_RUN, name: "page-check", metadata: { documentId: target.documentId, resourceId: target.ownerId, runId: `attempt-${index}` } }).end()
    const legacy = instance.startSpan({ type: SpanType.WORKFLOW_RUN, name: "normalize-document", metadata: { resourceId: target.ownerId, runId: "workflow-one" } })
    legacy.end()
    const otherDocument = instance.startSpan({ type: SpanType.WORKFLOW_RUN, name: "normalize-document", metadata: { documentId: "doc-two", resourceId: target.ownerId, runId: "workflow-two" } })
    otherDocument.end()
    const otherOwner = instance.startSpan({ type: SpanType.WORKFLOW_RUN, name: "normalize-document", metadata: { documentId: target.documentId, resourceId: "owner-two", runId: "workflow-three" } })
    otherOwner.end()
    for (const [runId, resourceId] of [["workflow-one", target.ownerId], ["workflow-two", target.ownerId], ["workflow-three", "owner-two"]] as const) yield* Effect.promise(() => workflows.persistWorkflowSnapshot({ workflowName: "normalize-document", runId, resourceId, snapshot: snapshot(runId) }))
    const retention = makeDocumentRetention(storage, () => mastra.observability.flush())
    expect(yield* retention.purge(target)).toEqual({ traceCount: 106, snapshotCount: 1 })
    expect(yield* Effect.promise(() => traces.getTrace({ traceId: legacy.traceId }))).toBeNull()
    expect(yield* Effect.promise(() => traces.getTrace({ traceId: otherDocument.traceId }))).not.toBeNull()
    expect(yield* Effect.promise(() => traces.getTrace({ traceId: otherOwner.traceId }))).not.toBeNull()
    expect(yield* Effect.promise(() => workflows.getWorkflowRunById({ workflowName: "normalize-document", runId: "workflow-one" }))).toBeNull()
    expect(yield* Effect.promise(() => workflows.getWorkflowRunById({ workflowName: "normalize-document", runId: "workflow-two" }))).not.toBeNull()
    expect(yield* Effect.promise(() => workflows.getWorkflowRunById({ workflowName: "normalize-document", runId: "workflow-three" }))).not.toBeNull()
    expect(yield* retention.purge(target)).toEqual({ traceCount: 0, snapshotCount: 0 })
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("refuses to delete an owner-mismatched workflow snapshot", () => Effect.gen(function* () {
    const { storage, mastra, workflows } = yield* localTraceFixture
    yield* Effect.promise(() => workflows.persistWorkflowSnapshot({ workflowName: "normalize-document", runId: "workflow-one", resourceId: "owner-two", snapshot: snapshot("workflow-one") }))
    const result = yield* makeDocumentRetention(storage, () => mastra.observability.flush()).purge(target).pipe(Effect.result)
    expect(Result.isFailure(result) && result.failure.operation).toBe("scope")
    expect(yield* Effect.promise(() => workflows.getWorkflowRunById({ workflowName: "normalize-document", runId: "workflow-one" }))).not.toBeNull()
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("fails a stalled delete without looping or silently deleting snapshots", () => Effect.gen(function* () {
    const { storage, mastra, instance, traces, workflows } = yield* localTraceFixture
    instance.startSpan({ type: SpanType.WORKFLOW_RUN, name: "normalize-document", metadata: { documentId: target.documentId, resourceId: target.ownerId, runId: "workflow-one" } }).end()
    yield* Effect.promise(() => workflows.persistWorkflowSnapshot({ workflowName: "normalize-document", runId: "workflow-one", resourceId: target.ownerId, snapshot: snapshot("workflow-one") }))
    const spy = yield* Effect.acquireRelease(Effect.sync(() => vi.spyOn(traces, "batchDeleteTraces").mockResolvedValue(undefined)), (value) => Effect.sync(() => value.mockRestore()))
    const result = yield* makeDocumentRetention(storage, () => mastra.observability.flush()).purge(target).pipe(Effect.result)
    expect(Result.isFailure(result) && result.failure.operation).toBe("traces")
    expect(spy).toHaveBeenCalledTimes(1)
    expect(yield* Effect.promise(() => workflows.getWorkflowRunById({ workflowName: "normalize-document", runId: "workflow-one" }))).not.toBeNull()
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.live("surfaces a flush failure without exposing its payload", () => Effect.gen(function* () {
    const { storage } = yield* localTraceFixture
    const result = yield* makeDocumentRetention(storage, () => Promise.reject(new Error("PRIVATE-FLUSH-PAYLOAD"))).purge(target).pipe(Effect.result)
    expect(Result.isFailure(result) && result.failure.operation).toBe("flush")
    expect(JSON.stringify(result)).not.toContain("PRIVATE-FLUSH-PAYLOAD")
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
