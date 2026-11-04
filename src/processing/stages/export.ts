import { Crypto, Effect } from "effect"
import { museFallback } from "../../domain/index.ts"
import { exportDocument } from "../../paper/reading/index.ts"
import { type DispatchClaim } from "../../storage/index.ts"
import { type Checkpoint } from ".././checkpoints.ts"
import { executionFailure } from ".././contracts.ts"
import { sameArtifact } from ".././pipeline-shared.ts"
import { type StageContext } from ".././stage-context.ts"

export const makeExportAndPublish = (context: StageContext) => {
  const { artifacts, outputs, crypto, readPrivate, progress, loadAssembled } = context
  const exportAndPublish = Effect.fnUntraced(function* (claim: DispatchClaim, input: Checkpoint) {
    const { publication } = yield* loadAssembled(claim, input)
    if (
      claim.run.configuration.guide !== undefined &&
      publication.canonical.guide === undefined &&
      !museFallback(publication.report.museReviews, "guide")
    ) {
      return yield* executionFailure("invalid-provider-response", "The required reading guide is missing")
    }
    const available = publication.canonical.figures.flatMap(({ asset }) =>
      asset._tag === "available" ? [[asset.artifact.path, asset.artifact] as const] : [],
    )
    const imageArtifacts = [...new Map(available).values()]
    const figureAssets = yield* Effect.forEach(imageArtifacts, (artifact) =>
      readPrivate(claim, artifact).pipe(Effect.map((bytes) => ({ artifact, bytes }))),
    )
    yield* progress(claim, "export", 0, 1)
    const exported = yield* exportDocument(publication, figureAssets).pipe(Effect.provideService(Crypto.Crypto, crypto))
    for (const file of exported.files) {
      const saved = yield* artifacts.put(claim.document.ownerId, claim.document.id, file.bytes)
      if (!sameArtifact(saved, file.entry))
        return yield* executionFailure("invalid-provider-response", "Export bytes do not match their manifest")
    }
    const published = yield* outputs.publish(claim, exported.publication)
    return { documentId: input.documentId, runId: input.runId, state: published.state }
  })
  return exportAndPublish
}
