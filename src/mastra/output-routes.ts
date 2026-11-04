import { registerApiRoute } from "@mastra/core/server"
import { productRoutes } from "../domain/index.ts"
import type { OutputOperation, RunOutputRequest } from "../server/outputs.ts"

export const outputOperations = ["canonical", "text", "zip", "image", "report", "readRating", "rate", "clearRating"] as const satisfies ReadonlyArray<OutputOperation>
export const outputRouteDefinitions = outputOperations.map((operation) => productRoutes[operation])
export const outputRoutes = (runOutputRequest?: RunOutputRequest) => outputOperations.map((operation) => registerApiRoute(productRoutes[operation].path, {
  method: productRoutes[operation].method,
  handler: (context) => runOutputRequest === undefined
    ? Response.json({ code: "processing-unavailable", message: "Output service unavailable" }, { status: 503 })
    : runOutputRequest(operation, context.req.raw, context.req.param("documentId"), context.req.param("revisionId"), context.req.param("figureId")),
}))
