import type { Config as MastraConfig } from "@mastra/core/mastra"
import { stageSpecs } from "../paper/correction/index.ts"
import { makeMetaAgentBoundary } from "../paper/providers/meta/index.ts"
import { makeNormalizationBoundary } from "./normalize-workflow.ts"
import { appShellRoutes } from "./app-shell.ts"
import { documentRoutes } from "./document-routes.ts"
import { outputRoutes } from "./output-routes.ts"
import type { RunDocumentRequest } from "../server/documents.ts"
import type { RunOutputRequest } from "../server/outputs.ts"

export { serverPort } from "../server/config.ts"

export const makeAmuseMe = (port: number, options: { readonly origin?: string; readonly appDirectory?: string; readonly runDocumentRequest?: RunDocumentRequest; readonly runOutputRequest?: RunOutputRequest; readonly meta?: ReturnType<typeof makeMetaAgentBoundary>; readonly normalization?: ReturnType<typeof makeNormalizationBoundary> } = {}): MastraConfig => ({
  agents: (options.meta ?? makeMetaAgentBoundary(stageSpecs)).agents,
  workflows: { "normalize-document": (options.normalization ?? makeNormalizationBoundary()).workflow },
  server: {
    host: "127.0.0.1",
    port,
    studioBase: "/admin",
    apiPrefix: "/admin/api",
    ...(options.origin === undefined ? {} : {
      studioHost: new URL(options.origin).hostname,
      studioPort: Number(new URL(options.origin).port || (options.origin.startsWith("https:") ? "443" : "80")),
      studioProtocol: options.origin.startsWith("https:") ? "https" : "http",
    }),
    cors: false,
    handleShutdownSignals: false,
    build: { openAPIDocs: false, swaggerUI: false, apiReqLogs: false },
    apiRoutes: [...appShellRoutes(options.appDirectory ?? "app"), ...documentRoutes(options.runDocumentRequest), ...outputRoutes(options.runOutputRequest)],
  },
})
