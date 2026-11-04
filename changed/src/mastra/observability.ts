import type { AnyExportedSpan, ObservabilityExporter } from "@mastra/core/observability"
import type { Mastra } from "@mastra/core/mastra"
import { MastraStorageExporter, Observability } from "@mastra/observability"
import { Effect, Schema } from "effect"

const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u))
const components = new Set(["normalize-document", "extract-document", "check-pages", "restore-headings", "describe-figures", "assemble-document", "write-reading-guide", "publish-document", "page-check", "headings", "figures", "guide"])
const correlationKeys = ["documentId", "documentRunId", "providerAttemptId", "runId", "resourceId"] as const

export const redactTraceSpan = (span: AnyExportedSpan): AnyExportedSpan => {
  const entityId = span.entityId !== undefined && components.has(span.entityId) ? span.entityId : undefined
  const metadata = Object.fromEntries(correlationKeys.flatMap((key) => {
    const value: unknown = span.metadata?.[key]
    return Schema.is(Identifier)(value) ? [[key, value]] : []
  }))
  return {
    id: span.id, traceId: span.traceId, type: span.type, name: entityId === undefined ? span.type : `${span.type}: ${entityId}`,
    isEvent: span.isEvent, isRootSpan: span.isRootSpan, startTime: span.startTime,
    ...(span.endTime === undefined ? {} : { endTime: span.endTime }),
    ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
    ...(span.entityType === undefined ? {} : { entityType: span.entityType }),
    ...(entityId === undefined ? {} : { entityId, entityName: entityId }),
    metadata,
    ...(span.errorInfo === undefined ? {} : { errorInfo: { name: "ProcessingFailure", message: "Processing did not complete. See the document status and saved report." } }),
  }
}

const localObservability = () => {
  const storage = new MastraStorageExporter({ customSpanFormatter: redactTraceSpan, maxRetries: 0, maxBatchSize: 100, maxBufferSize: 1000, maxBatchWaitMs: 1000 })
  const traces: ObservabilityExporter = {
    name: "amuseme-local-traces",
    init: (options) => storage.init(options),
    exportTracingEvent: (event) => storage.exportTracingEvent(event),
    flush: () => storage.flush(),
    shutdown: () => storage.shutdown(),
  }
  const observability = new Observability({ configs: { local: {
    serviceName: "amuseme", exporters: [traces], logging: { enabled: false }, requestContextKeys: [], includeInternalSpans: false,
  } } })
  return { observability, exporter: traces }
}

export const makeLocalObservability = (): Observability => localObservability().observability

export const registerLocalObservability = Effect.fn("registerLocalObservability")(function* (mastra: Mastra) {
  if (mastra.getStorage() === undefined || mastra.observability.listInstances().size !== 0) return yield* Effect.die("Local observability must be registered once after Mastra storage initialization")
  const { observability, exporter } = localObservability()
  const instance = observability.getDefaultInstance()
  if (instance === undefined) return yield* Effect.die("Expected the configured local observability instance")
  yield* Effect.sync(() => { mastra.registerExporter(exporter, instance, observability); observability.unregisterInstance("local") })
})
