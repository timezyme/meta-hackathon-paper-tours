import { RequestContext } from "@mastra/core/request-context"
import { createStep, createWorkflow } from "@mastra/core/workflows"
import { DateTime, Effect, Predicate, Result, Schema } from "effect"
import { Failure, RunState, type Stage } from "../domain/index.ts"
import { Assembled, Corrected, Described, Extracted, Hierarchy, Published, WorkInput, type Checkpoint } from "../processing/checkpoints.ts"
import { RunStarter, executionFailure } from "../processing/index.ts"
import type { DispatchClaim } from "../storage/index.ts"

import { WorkflowStageFailure } from "../processing/contracts.ts"
export type RunNormalizationStep = (claim: DispatchClaim, stage: typeof Stage.Type, input: Checkpoint, signal: AbortSignal) => Promise<{ readonly _tag: "success"; readonly value: Checkpoint } | { readonly _tag: "failure"; readonly failure: Failure }>
const standard = <A, E>(schema: Schema.Codec<A, E>) => Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))
const permitKey = "amusemeNormalizationPermit"
interface Permit { readonly claim: DispatchClaim; readonly signal: AbortSignal; failure: Failure | null; active: boolean }
const EmptyRecord = Schema.Record(Schema.String, Schema.Never)
const UnstartedSnapshot = Schema.Struct({
  runId: Schema.String, status: Schema.Literal("pending"), timestamp: Schema.Number,
  value: EmptyRecord, context: EmptyRecord, serializedStepGraph: Schema.Array(Schema.Unknown),
  activePaths: Schema.Array(Schema.Never), activeStepsPath: EmptyRecord,
  suspendedPaths: EmptyRecord, resumeLabels: EmptyRecord, waitingPaths: EmptyRecord,
})

export const makeNormalizationBoundary = (runStep?: RunNormalizationStep) => {
  const permits = new WeakMap<object, Permit>()
  const step = <I extends Checkpoint, O extends Checkpoint>(id: string, stage: typeof Stage.Type, input: Schema.Codec<I, unknown>, output: Schema.Codec<O, unknown>) => createStep({
    id, inputSchema: standard(input), outputSchema: standard(output), retries: 0,
    execute: ({ inputData, requestContext, abortSignal }) => Effect.gen(function* () {
      const token = requestContext.getRaw(permitKey)
      const permit = Predicate.isObject(token) ? permits.get(token) : undefined
      if (permit === undefined || !permit.active || permit.signal.aborted || runStep === undefined || inputData.documentId !== permit.claim.document.id || inputData.runId !== permit.claim.run.id) {
        return yield* executionFailure("processing-unavailable", "A current document processing claim is required")
      }
      const result = yield* Effect.tryPromise({
        try: () => runStep(permit.claim, stage, inputData, AbortSignal.any([abortSignal, permit.signal])),
        catch: () => executionFailure("provider-unknown-completion", "The processing step stopped without an outcome"),
      })
      if (result._tag === "failure") {
        permit.failure = result.failure
        return yield* new WorkflowStageFailure({ failure: result.failure })
      }
      return yield* Schema.decodeUnknownEffect(output)(result.value)
    }).pipe((effect) => Effect.runPromise(effect, { signal: abortSignal })),
  })
  const workflow = createWorkflow({
    id: "normalize-document", description: "Extract, repair and assemble an owner-scoped document",
    inputSchema: standard(WorkInput), outputSchema: standard(Published),
    options: { autoRestartActiveRuns: false, shouldPersistSnapshot: () => true, validateInputs: true },
  }).then(step("extract-document", "extraction", WorkInput, Extracted))
    .then(step("check-pages", "page-check", Extracted, Corrected))
    .then(step("restore-headings", "headings", Corrected, Hierarchy))
    .then(step("describe-figures", "figures", Hierarchy, Described))
    .then(step("assemble-document", "assembly", Described, Assembled))
    .then(step("publish-document", "export", Assembled, Published)).commit()

  const starter = RunStarter.of({ startOrReconnect: Effect.fn("Normalization.startOrReconnect")(function* (claim: DispatchClaim) {
    if (claim.run.mastraRunId === null) return yield* executionFailure("conflict", "The accepted document has no workflow association")
    const runEffect = Effect.runPromiseWith(yield* Effect.context())
    const result = yield* Effect.callback<RunState, ReturnType<typeof executionFailure>>((resume) => {
        const controller = new AbortController()
        const signal = controller.signal
        const token = {}
        const permit: Permit = { claim, signal, failure: null, active: true }
        permits.set(token, permit)
        const context = new RequestContext()
        context.setRaw(permitKey, token)
        const completion = Effect.gen(function* () {
          const saved = yield* Effect.tryPromise({ try: () => workflow.getWorkflowRunById(claim.run.mastraRunId!), catch: () => executionFailure("provider-unknown-completion", "The saved workflow could not be read") })
          if (saved !== null && (saved.resourceId !== claim.run.ownerId || saved.workflowName !== "normalize-document" || saved.runId !== claim.run.mastraRunId || claim.recovered !== true)) return yield* executionFailure("conflict", "The saved workflow does not match the recovery claim")
          if (saved !== null && !["running", "pending"].includes(saved.status)) return yield* executionFailure("provider-unknown-completion", "The saved workflow is terminal and requires an explicit retry")
          let unstarted = false
          if (saved?.status === "pending") {
            const snapshot = yield* Effect.tryPromise({ try: () => workflow.mastra?.getStorage()?.getStore("workflows").then((store) => store?.loadWorkflowSnapshot({ workflowName: "normalize-document", runId: claim.run.mastraRunId! })) ?? Promise.resolve(undefined), catch: () => executionFailure("provider-unknown-completion", "The initial workflow snapshot could not be read") })
            const parsed = Schema.decodeUnknownResult(UnstartedSnapshot)(snapshot, { onExcessProperty: "error" })
            unstarted = Result.isSuccess(parsed) && parsed.success.runId === claim.run.mastraRunId && JSON.stringify(parsed.success.serializedStepGraph) === JSON.stringify(workflow.serializedStepGraph)
            if (!unstarted) return yield* executionFailure("provider-unknown-completion", "The pending workflow contains prior execution and cannot be started again")
          }
          const run = yield* Effect.tryPromise({ try: () => workflow.createRun({ runId: claim.run.mastraRunId!, resourceId: claim.run.ownerId, disableScorers: true }), catch: () => executionFailure("provider-unknown-completion", "The workflow could not be opened") })
          const tracingOptions = { hideInput: true, hideOutput: true, metadata: { documentId: claim.document.id, documentRunId: claim.run.id, resourceId: claim.run.ownerId } }
          const outcome = yield* Effect.tryPromise({ try: () => saved === null || unstarted ? run.start({ inputData: { documentId: claim.document.id, runId: claim.run.id }, requestContext: context, tracingOptions }) : run.restart({ requestContext: context, tracingOptions }), catch: () => executionFailure("provider-unknown-completion", "The workflow stopped before returning its outcome") })
          if (outcome.status === "success") return yield* Schema.decodeUnknownEffect(Published)(outcome.result).pipe(Effect.map((value) => value.state), Effect.mapError(() => executionFailure("invalid-provider-response", "The workflow returned an invalid result")))
          const failure = permit.failure ?? { code: "provider-unknown-completion" as const, message: "Processing stopped. Saved work is retained.", retryable: true, stage: null, pageId: null, figureId: null }
          const now = yield* DateTime.now
          return RunState.make({ _tag: failure.code === "provider-unknown-completion" ? "interrupted" : "failed", finishedAt: DateTime.formatIso(now), failure })
        }).pipe(Effect.ensuring(Effect.sync(() => { permit.active = false; permits.delete(token) })), Effect.result, (effect) => runEffect(effect))
        completion.then((value) => resume(Effect.fromResult(value)), () => resume(Effect.fail(executionFailure("provider-unknown-completion", "The workflow stopped before returning its outcome"))))
        return Effect.sync(() => controller.abort()).pipe(Effect.andThen(Effect.promise(() => completion.then(() => undefined, () => undefined))))
    })
    return result
  }) })
  return { workflow, starter }
}
