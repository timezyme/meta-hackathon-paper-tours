const inspectionPaths = [
  "/agents", "/agents/providers", "/agents/:agentId", "/agents/:agentId/tools/:toolId",
  "/workflows", "/workflows/run-counts", "/workflows/:workflowId", "/workflows/:workflowId/runs", "/workflows/:workflowId/runs/:runId",
  "/tools", "/tools/:toolId", "/processors", "/processors/:processorId",
  "/auth/capabilities", "/auth/me", "/memory/status", "/memory/config",
  "/observability/capabilities", "/observability/traces", "/observability/traces/light",
  "/observability/traces/:traceId", "/observability/traces/:traceId/light",
  "/observability/traces/:traceId/spans/:spanId", "/observability/traces/:traceId/trajectory",
  "/logs", "/logs/transports", "/logs/:runId", "/system/packages", "/system/api-schema",
] as const

export const studioInspectionRoutes = [
  ...inspectionPaths.map((path) => ({ method: "GET" as const, path: `/admin/api${path}`, access: "admin" as const })),
  { method: "POST", path: "/admin/__refresh", access: "admin" },
] as const

const patterns = studioInspectionRoutes.map((route) => ({ method: route.method, path: new RegExp(`^${route.path.replace(/:[A-Za-z]+/gu, "[A-Za-z0-9][A-Za-z0-9_-]{0,127}")}$`, "u") }))

export const isStudioInspectionRequest = (method: string, path: string): boolean => {
  if (path.includes("%")) return false
  if (patterns.some((route) => route.method === method && route.path.test(path))) return true
  return (method === "GET" || method === "HEAD") && (path === "/admin" || path.startsWith("/admin/"))
    && path !== "/admin/api" && !path.startsWith("/admin/api/")
}
