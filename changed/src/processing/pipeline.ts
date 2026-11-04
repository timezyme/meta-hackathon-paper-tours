import { Context, Effect, Layer } from "effect"
import { type Stage } from "../domain/index.ts"
import { makeMetaAgentBoundary } from "../paper/providers/meta/index.ts"
import { type DispatchClaim } from "../storage/index.ts"
import { type Checkpoint } from "./checkpoints.ts"
import { metaRuntimeConfiguration } from "./policy.ts"
import { WorkflowStageFailure, executionFailure } from "./contracts.ts"
import { type StageHandler, stageFailure, type PipelineOptions } from "./pipeline-shared.ts"
import { makeStageContext } from "./stage-context.ts"
import { makeMuseReview } from "./muse-review.ts"
import { makeFigureCrops } from "./figure-crops.ts"
import { makeExtract } from "./stages/extraction.ts"
import { makeCheckPages } from "./stages/page-check.ts"
import { makeClassifyHeadings } from "./stages/headings.ts"
import { makeDescribeFigures } from "./stages/figures.ts"
import { makeAssemble } from "./stages/assembly.ts"
import { makeWriteGuide } from "./stages/guide.ts"
import { makeExportAndPublish } from "./stages/export.ts"

export { ExtractedData } from "./pipeline-shared.ts"
export type { PipelineOptions } from "./pipeline-shared.ts"

export class NormalizationStages extends Context.Service<
  NormalizationStages,
  {
    readonly execute: (claim: DispatchClaim, stage: typeof Stage.Type, input: Checkpoint) => Effect.Effect<Checkpoint, WorkflowStageFailure>
  }
>()("amuseme/processing/NormalizationStages") {
  static readonly layer = (meta: ReturnType<typeof makeMetaAgentBoundary>, options?: PipelineOptions) =>
    Layer.effect(
      NormalizationStages,
      Effect.gen(function* () {
        if (options === undefined) {
          const message = "Document processing is not configured"
          const failure = { code: "processing-unavailable", message, retryable: false, stage: null, pageId: null, figureId: null } as const
          return NormalizationStages.of({ execute: () => Effect.fail(new WorkflowStageFailure({ failure })) })
        }
        const context = yield* makeStageContext(meta, options)
        const { documents } = context
        const review = makeMuseReview(context)
        const crops = makeFigureCrops(context)
        const extract = makeExtract(context, review, crops)
        const checkPages = makeCheckPages(context, review)
        const classifyHeadings = makeClassifyHeadings(context, review)
        const describeFigures = makeDescribeFigures(context, review)
        const assemble = makeAssemble(context)
        const writeGuide = makeWriteGuide(context, review)
        const exportAndPublish = makeExportAndPublish(context)
        const stageHandlers = {
          extraction: extract,
          "page-check": checkPages,
          headings: classifyHeadings,
          figures: describeFigures,
          assembly: assemble,
          guide: writeGuide,
          export: exportAndPublish,
        } satisfies Record<typeof Stage.Type, StageHandler>

        const execute = Effect.fn("NormalizationStages.execute")(
          function* (claim: DispatchClaim, stage: typeof Stage.Type, input: Checkpoint) {
            if (!metaRuntimeConfiguration(claim.run.configuration)) {
              return yield* executionFailure(
                "processing-unavailable",
                "This runtime permits only Meta model processing; historical non-Meta outputs remain readable",
              )
            }
            if (input.documentId !== claim.document.id || input.runId !== claim.run.id) {
              return yield* executionFailure("conflict", "The workflow checkpoint belongs to another run")
            }
            const savedDocument = yield* documents.detail(claim.document.ownerId, claim.document.id)
            if (savedDocument.latestRun.id !== claim.run.id || !metaRuntimeConfiguration(savedDocument.latestRun.configuration)) {
              return yield* executionFailure("processing-unavailable", "The saved run is not eligible for this Meta-only runtime")
            }
            return yield* stageHandlers[stage](claim, input)
          },
          (effect, _claim, stage) =>
            effect.pipe(Effect.mapError((error) => new WorkflowStageFailure({ failure: stageFailure(error, stage) }))),
        )
        return NormalizationStages.of({ execute })
      }),
    )
}
