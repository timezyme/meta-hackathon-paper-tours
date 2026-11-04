import { registerApiRoute } from "@mastra/core/server"
import { productRoutes } from "../domain/index.ts"
import type { RunDocumentRequest } from "../server/documents.ts"

export const documentRouteDefinitions = [
  { operation: "upload", method: productRoutes.upload.method, path: productRoutes.upload.path },
  { operation: "list", method: productRoutes.list.method, path: productRoutes.list.path },
  { operation: "detail", method: productRoutes.detail.method, path: productRoutes.detail.path },
  { operation: "status", method: productRoutes.status.method, path: productRoutes.status.path },
  { operation: "original", method: productRoutes.original.method, path: productRoutes.original.path },
  { operation: "retry", method: productRoutes.retry.method, path: productRoutes.retry.path },
  { operation: "delete", method: productRoutes.delete.method, path: productRoutes.delete.path },
] as const

export const documentRoutes = (runDocumentRequest?: RunDocumentRequest) => documentRouteDefinitions.map((route) => registerApiRoute(route.path, {
  method: route.method,
  handler: (context) => runDocumentRequest === undefined
    ? Response.json({ code: "processing-unavailable", message: "Document service unavailable" }, { status: 503 })
    : runDocumentRequest(route.operation, context.req.raw, context.req.param("documentId")),
}))
