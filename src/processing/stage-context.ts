import { Crypto, Effect, FileSystem, Path, Result, Schema } from "effect"
import { ArtifactHash, validateExtraction, type Stage } from "../domain/index.ts"
import { HttpClient } from "effect/http"
import { boundRequest, type StageRequestLimits } from "../paper/correction/index.ts"
import { pageExtractionPromptVersion } from "../paper/extraction/page.ts"
import { applyHeadingDecisions } from "../paper/headings/index.ts"
import { measureMetaInput } from "../paper/providers/meta/transport.ts"
import { AssembledDocument } from "../paper/reading/index.ts"
import { PdfRenderer } from "../paper/pdf/index.ts"
import { decodeMetaOutput, makeMetaAgentBoundary, type MetaRequest, type MetaValidators } from "../paper/providers/meta/index.ts"
import { ArtifactStore, DocumentStore, PrivateArtifact, OutputStore, StorageDatabase, type DispatchClaim } from "../storage/index.ts"
import { Assembled, Corrected, Described, Extracted, Hierarchy, type Checkpoint } from "./checkpoints.ts"
import { remainingHeadroomMicrousd } from "./policy.ts"
import { ProviderAdapter, ProviderGuard, executionFailure, type AttemptInput, type ExecutionFailure } from "./contracts.ts"
import {
  ExtractedData,
  CorrectedData,
  HeadingData,
  DescribedData,
  privateRef,
  unsupported,
  imageTokenUpperBound,
  figureChainLimit,
  receiptsCoverPagesInOrder,
  type MetaCall,
  type Checked,
  type MetaPreflight,
  type PipelineOptions,
} from "./pipeline-shared.ts"

export const makeStageContext = Effect.fnUntraced(function* (meta: ReturnType<typeof makeMetaAgentBoundary>, options: PipelineOptions) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const documents = yield* DocumentStore
  const artifacts = yield* ArtifactStore
  const guard = yield* ProviderGuard
  const outputs = yield* OutputStore
  const database = yield* StorageDatabase
  const renderer = yield* PdfRenderer
  const http = yield* HttpClient.HttpClient
  const crypto = yield* Crypto.Crypto
  yield* fs.makeDirectory(options.temporaryDirectory, { recursive: true, mode: 0o700 })
  const figureConcurrency = Math.min(figureChainLimit, options.policy.maxConcurrentCalls)
  const settleInOrder = Effect.fnUntraced(function* <A, B, E, R>(items: ReadonlyArray<A>, work: (item: A) => Effect.Effect<B, E, R>) {
    let stopped = false
    const settled = yield* Effect.forEach(
      items,
      (item) =>
        Effect.suspend(() =>
          stopped
            ? Effect.succeed(null)
            : work(item).pipe(
                Effect.result,
                Effect.tap((result) =>
                  Effect.sync(() => {
                    stopped ||= Result.isFailure(result)
                  }),
                ),
              ),
        ),
      { concurrency: figureConcurrency },
    )
    const values: Array<B> = []
    for (const result of settled) {
      if (result === null) return yield* Effect.die("A skipped figure chain must follow a failed one")
      if (Result.isFailure(result)) return yield* Effect.fail(result.failure)
      values.push(result.success)
    }
    return values
  })
  const save = (claim: DispatchClaim, value: unknown) =>
    artifacts.put(claim.document.ownerId, claim.document.id, new TextEncoder().encode(JSON.stringify(value)))
  const read = <A>(claim: DispatchClaim, artifact: PrivateArtifact, schema: Schema.Codec<A, unknown>) =>
    artifacts
      .read(claim.document.ownerId, claim.document.id, artifact)
      .pipe(Effect.flatMap((bytes) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(new TextDecoder().decode(bytes))))
  const readPrivate = (claim: DispatchClaim, artifact: PrivateArtifact) =>
    artifacts.read(claim.document.ownerId, claim.document.id, privateRef(artifact))
  const progress = (claim: DispatchClaim, stage: typeof Stage.Type, completedUnits: number, totalUnits: number) =>
    claim.run.state._tag !== "running"
      ? Effect.fail(executionFailure("conflict", "The document claim is not running"))
      : documents.updateRun(claim, { ...claim.run.state, progress: { stage, completedUnits, totalUnits } }).pipe(Effect.asVoid)
  const limits = (claim: DispatchClaim, stage: "pageCheck" | "headings" | "figures"): StageRequestLimits => ({
    maxOutputTokens: claim.run.configuration[stage].maxOutputTokens,
    maxRequestBytes: options.policy.maxRequestBytes,
    imageTokenUpperBound,
  })
  const measure = (request: MetaRequest) =>
    measureMetaInput(request, options.metaCredential).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(Crypto.Crypto, crypto),
    )

  const headroom = (claim: DispatchClaim, extractionPages = 0, checkPages = 0, headings = false) =>
    remainingHeadroomMicrousd([
      extractionPages * options.policy.maximumCostMicrousd.extraction,
      checkPages * options.policy.maximumCostMicrousd["page-check"],
      headings ? options.policy.maximumCostMicrousd.headings : 0,
      claim.run.configuration.guide === undefined ? 0 : (options.policy.maximumCostMicrousd.guide ?? 0),
    ])
  const prepareMetaCall = Effect.fnUntraced(function* (
    claim: DispatchClaim,
    call: MetaCall,
    preflight: MetaPreflight,
    retry: AttemptInput["retry"] = { _tag: "none" },
  ) {
    const inputTokenBound = preflight.inputTokens + preflight.framingReserveTokens
    yield* Effect.fromResult(boundRequest(call.request, { ...call.limits, imageTokenUpperBound: inputTokenBound }))
    yield* save(claim, preflight)
    const savedInput = call.savedInput === undefined ? [] : [(yield* save(claim, call.savedInput)).hash]
    const validators: MetaValidators = {
      extraction: unsupported,
      "page-check": unsupported,
      headings: unsupported,
      figures: unsupported,
      guide: unsupported,
      [call.stage]: (value: Schema.Json) => Effect.fromResult(call.validate(value)).pipe(Effect.asVoid),
    }
    const adapter = yield* meta
      .makeAdapter({ credential: options.metaCredential, validators })
      .pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.provideService(Crypto.Crypto, crypto))
    const inputHashes = [ArtifactHash.make(claim.document.sourceHash), ...call.inputHashes, ...savedInput] as const
    const { stage, pageIds, figureId, request, task, headroomMicrousd } = call
    const attempt: AttemptInput = {
      stage,
      pageIds,
      figureId,
      inputHashes,
      request,
      supportsIdempotency: false,
      retry,
      inputTokenBound,
      ...(task === undefined ? {} : { task }),
      ...(headroomMicrousd === undefined ? {} : { headroomMicrousd: Math.max(0, headroomMicrousd) }),
    }
    return { attempt, adapter }
  })
  const dispatch = (claim: DispatchClaim, prepared: Effect.Success<ReturnType<typeof prepareMetaCall>>) =>
    guard.execute(claim, prepared.attempt).pipe(Effect.provideService(ProviderAdapter, prepared.adapter))
  const guardedMetaCall = (claim: DispatchClaim, call: MetaCall) =>
    measure(call.request).pipe(
      Effect.flatMap((preflight) => prepareMetaCall(claim, call, preflight)),
      Effect.flatMap((prepared) => dispatch(claim, prepared)),
    )
  const attemptCall = (claim: DispatchClaim, call: MetaCall, retry: AttemptInput["retry"]) =>
    measure(call.request).pipe(
      Effect.flatMap((preflight) => prepareMetaCall(claim, call, preflight, retry)),
      Effect.flatMap((prepared) =>
        dispatch(claim, prepared).pipe(
          Effect.result,
          Effect.map((result) => ({ attempt: prepared.attempt, result })),
        ),
      ),
    )

  const judgedAttempt = Effect.fnUntraced(function* <A>(
    claim: DispatchClaim,
    prepared: Effect.Success<ReturnType<typeof attemptCall>>,
    check: (value: Schema.Json) => Checked<A>,
    acceptRejected: boolean,
  ) {
    const { attempt, result } = prepared
    if (Result.isSuccess(result)) {
      const answer = yield* decodeMetaOutput(result.success.response)
      return { response: result.success, answer, verdict: check(answer) }
    }
    const failure = result.failure
    if (failure._tag !== "ExecutionFailure" || failure.code !== "invalid-provider-response") return yield* failure
    const saved = yield* guard.rejected(claim, attempt)
    if (saved === null) return yield* failure
    const decoded = yield* decodeMetaOutput(saved.response).pipe(Effect.option)
    const answer = decoded._tag === "Some" ? decoded.value : null
    const checked = answer === null ? null : check(answer)
    const verdict = checked !== null && (acceptRejected || Result.isFailure(checked)) ? checked : Result.fail([failure.message])
    return { response: saved, answer, verdict }
  })
  const reviewAttempt = Effect.fnUntraced(function* <A>(
    claim: DispatchClaim,
    work: ReturnType<typeof attemptCall>,
    check: (value: Schema.Json) => Checked<A>,
    acceptRejected: boolean,
    unavailable: (failure: ExecutionFailure, phase: "preflight" | "dispatched") => boolean,
  ) {
    const prepared = yield* work.pipe(Effect.result)
    if (Result.isFailure(prepared)) {
      const failure = prepared.failure
      if (failure._tag === "ExecutionFailure" && unavailable(failure, "preflight")) return { _tag: "unavailable" as const, failure }
      return yield* failure
    }
    const result = prepared.success.result
    if (Result.isFailure(result)) {
      const failure = result.failure
      if (failure._tag !== "ExecutionFailure" || failure.code !== "invalid-provider-response") {
        if (failure._tag === "ExecutionFailure" && unavailable(failure, "dispatched")) return { _tag: "unavailable" as const, failure }
        return yield* failure
      }
    }
    return { _tag: "judged" as const, ...(yield* judgedAttempt(claim, prepared.success, check, acceptRejected)) }
  })
  const loadExtracted = Effect.fnUntraced(function* (claim: DispatchClaim, input: Checkpoint) {
    const extracted = yield* Schema.decodeUnknownEffect(Extracted)(input)
    const data = yield* read(claim, extracted.extraction, ExtractedData)
    const extraction = data.conversion.extraction
    if (claim.run.configuration.extractionModel?.promptVersion === pageExtractionPromptVersion) {
      const valid =
        receiptsCoverPagesInOrder(claim, extraction, data.receipts) &&
        extraction.scope.runId === claim.run.id &&
        validateExtraction(claim.document, extraction).length === 0
      if (!valid) return yield* executionFailure("invalid-provider-response", "Saved extraction receipts must cover every page in order")
    }
    return { extracted, data, extraction }
  })
  const loadCorrected = Effect.fnUntraced(function* (claim: DispatchClaim, input: Checkpoint) {
    const previous = yield* loadExtracted(claim, input)
    const corrected = yield* Schema.decodeUnknownEffect(Corrected)(input)
    return { ...previous, corrected, correction: yield* read(claim, corrected.correction, CorrectedData) }
  })
  const loadHierarchy = Effect.fnUntraced(function* (claim: DispatchClaim, input: Checkpoint) {
    const previous = yield* loadCorrected(claim, input)
    const hierarchy = yield* Schema.decodeUnknownEffect(Hierarchy)(input)
    const headings = yield* read(claim, hierarchy.hierarchy, HeadingData)
    yield* Effect.fromResult(applyHeadingDecisions(previous.extraction, previous.correction.corrected, headings.response))
    return { ...previous, hierarchy, headings }
  })
  const loadDescribed = Effect.fnUntraced(function* (claim: DispatchClaim, input: Checkpoint) {
    const previous = yield* loadHierarchy(claim, input)
    const described = yield* Schema.decodeUnknownEffect(Described)(input)
    return { ...previous, described, descriptions: yield* read(claim, described.descriptions, DescribedData) }
  })
  const loadAssembled = Effect.fnUntraced(function* (claim: DispatchClaim, input: Checkpoint) {
    const previous = yield* loadDescribed(claim, input)
    const assembled = yield* Schema.decodeUnknownEffect(Assembled)(input)
    return { ...previous, assembled, publication: yield* read(claim, assembled.publication, AssembledDocument) }
  })
  return {
    options,
    fs,
    path,
    documents,
    artifacts,
    guard,
    outputs,
    database,
    renderer,
    http,
    crypto,
    save,
    read,
    readPrivate,
    progress,
    limits,
    measure,
    headroom,
    prepareMetaCall,
    dispatch,
    guardedMetaCall,
    attemptCall,
    reviewAttempt,
    figureConcurrency,
    settleInOrder,
    loadExtracted,
    loadCorrected,
    loadHierarchy,
    loadDescribed,
    loadAssembled,
  }
})
export type StageContext = Effect.Success<ReturnType<typeof makeStageContext>>
