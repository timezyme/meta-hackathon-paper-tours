import { Context, Effect, Schema } from "effect"
import { ArtifactHash, Failure, FigureId, NonBlank, PageId, PositiveInt, ProviderAttemptId, ProviderStage, ProviderTask, StageReceipt, Usage } from "../domain/index.ts"
import type { DispatchClaim, StorageFailure } from "../storage/index.ts"

export class WorkflowStageFailure extends Schema.TaggedError<WorkflowStageFailure>()("WorkflowStageFailure", { failure: Failure }) {}

export class ExecutionFailure extends Schema.TaggedError<ExecutionFailure>()("ExecutionFailure", {
  code: Schema.Literals(["processing-unavailable", "conflict", "limit-exceeded", "provider-failed", "provider-unknown-completion", "invalid-provider-response"]),
  message: NonBlank,
}) {}

export class ProviderFailure extends Schema.TaggedError<ProviderFailure>()("ProviderFailure", {
  certainty: Schema.Literals(["not-submitted", "unknown"]),
  message: NonBlank,
}) {}

export const MicroUsd = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const GuardPolicy = Schema.Struct({
  mode: Schema.Literals(["live", "fixture"]),
  enabled: Schema.Boolean,
  metaCredentialConfigured: Schema.Boolean,
  mineruCredentialConfigured: Schema.Boolean,
  mineruEndpoint: Schema.NullOr(Schema.String),
  budgetId: NonBlank,
  authorizedBudgetMicrousd: Schema.NullOr(MicroUsd),
  maximumCostMicrousd: Schema.Struct({ extraction: MicroUsd, "page-check": MicroUsd, headings: MicroUsd, figures: MicroUsd, guide: Schema.optionalKey(MicroUsd), "figure-crop": Schema.optionalKey(MicroUsd) }),
  metaRates: Schema.optionalKey(Schema.Struct({ inputMicrousdPerMillionTokens: MicroUsd, outputMicrousdPerMillionTokens: MicroUsd })),
  maxConcurrentCalls: PositiveInt,
  maxOutputTokens: PositiveInt,
  maxRequestBytes: PositiveInt,
  maxResponseBytes: PositiveInt,
  callDeadlineMilliseconds: PositiveInt,
})
export type GuardPolicy = typeof GuardPolicy.Type

export const AttemptInput = Schema.Struct({
  stage: ProviderStage,
  pageIds: Schema.Array(PageId),
  figureId: Schema.NullOr(FigureId),
  task: Schema.optionalKey(ProviderTask),
  inputHashes: Schema.NonEmptyArray(ArtifactHash),
  request: Schema.Json,
  supportsIdempotency: Schema.Boolean,
  headroomMicrousd: Schema.optionalKey(MicroUsd),
  inputTokenBound: Schema.optionalKey(PositiveInt),
  retry: Schema.TaggedUnion({
    none: {},
    authorized: { previousAttemptId: ProviderAttemptId, authorizationId: NonBlank, acknowledgesUnknownCompletion: Schema.Boolean },
    review: { previousAttemptId: ProviderAttemptId, round: Schema.Literals([1, 2]), headroomMicrousd: MicroUsd },
  }),
})
export type AttemptInput = typeof AttemptInput.Type

export const AttemptIntent = Schema.Struct({
  request: Schema.Json,
  clientIdempotencyKey: Schema.NullOr(NonBlank),
  maximumCostMicrousd: MicroUsd,
  maxOutputTokens: Schema.NullOr(PositiveInt),
  maxResponseBytes: PositiveInt,
  deadlineAt: Schema.Number,
  retry: AttemptInput.fields.retry,
})
export type AttemptIntent = typeof AttemptIntent.Type

export const ProviderResponse = Schema.Struct({ response: Schema.Json, usage: Usage, actualCostMicrousd: Schema.NullOr(MicroUsd) })
export type ProviderResponse = typeof ProviderResponse.Type

export interface AttemptTicket {
  readonly claim: DispatchClaim
  readonly receipt: StageReceipt
  readonly intent: AttemptIntent
}

export interface GuardedResponse {
  readonly delivery: "performed" | "reused"
  readonly receipt: StageReceipt
  readonly response: Schema.Json
}

export type PreparedAttempt = { readonly _tag: "prepared"; readonly ticket: AttemptTicket } | { readonly _tag: "retrieve"; readonly ticket: AttemptTicket } | { readonly _tag: "reused" | "validation"; readonly result: GuardedResponse }
export type GuardError = ExecutionFailure | StorageFailure

export interface ProviderCall {
  readonly attemptId: ProviderAttemptId
  readonly receipt: StageReceipt
  readonly intent: AttemptIntent
  readonly submitted: (providerRequestId: string) => Effect.Effect<void, GuardError>
}

export class ProviderAdapter extends Context.Service<ProviderAdapter, {
  readonly invoke: (call: ProviderCall) => Effect.Effect<ProviderResponse, ProviderFailure | GuardError>
  readonly validate: (response: Schema.Json, receipt: StageReceipt) => Effect.Effect<void, ExecutionFailure>
  readonly retrieve?: (receipt: StageReceipt) => Effect.Effect<ProviderResponse, ProviderFailure | GuardError>
}>()("amuseme/processing/ProviderAdapter") {}

export class ProviderGuard extends Context.Service<ProviderGuard, {
  readonly retryInput: (claim: DispatchClaim, input: AttemptInput) => Effect.Effect<AttemptInput, GuardError>
  readonly prepare: (claim: DispatchClaim, input: AttemptInput) => Effect.Effect<PreparedAttempt, GuardError>
  readonly dispatch: (ticket: AttemptTicket, beforeValidation?: Effect.Effect<void, ExecutionFailure>) => Effect.Effect<GuardedResponse, GuardError, ProviderAdapter>
  readonly execute: (claim: DispatchClaim, input: AttemptInput) => Effect.Effect<GuardedResponse, GuardError, ProviderAdapter>
  readonly rejected: (claim: DispatchClaim, input: AttemptInput) => Effect.Effect<GuardedResponse | null, GuardError>
  readonly reconcile: () => Effect.Effect<number, GuardError>
}>()("amuseme/processing/ProviderGuard") {}

export const executionFailure = (code: ExecutionFailure["code"], message: string) => new ExecutionFailure({ code, message })
