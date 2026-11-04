import { Schema } from "effect"

export const GuideMode = Schema.Literals(["choices", "overview", "walk", "claims", "read", "map", "done-walk", "done-claims"])
export type GuideMode = typeof GuideMode.Type
export const ReadingGoal = Schema.Literals(["walk", "claims", "map", "read"])
export type ReadingGoal = typeof ReadingGoal.Type
const View = Schema.Literals(["text", "original", "clean"])
const PositiveQuery = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,8}$/u))
const ShortQuery = Schema.String.check(Schema.isPattern(/^[1-9][0-9]?$/u))
const NodeQuery = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,2}$/u))

export type GuideRoute = {
  readonly mode: GuideMode
  readonly goal: ReadingGoal | null
  readonly n: number
  readonly source: number | null
  readonly node: number | null
  readonly view: typeof View.Type
}

const queryValidators: Readonly<Record<string, (value: string) => boolean>> = {
  mode: Schema.is(GuideMode),
  goal: Schema.is(ReadingGoal),
  view: Schema.is(View),
  p: Schema.is(PositiveQuery),
  n: Schema.is(ShortQuery),
  source: Schema.is(ShortQuery),
  node: Schema.is(NodeQuery),
}

export const validDocumentQuery = (query: string): boolean => {
  if (query.length === 0 || query.length > 160 || !/^[A-Za-z0-9=&-]+$/u.test(query)) return false
  const params = new URLSearchParams(query)
  const seen = new Set<string>()
  for (const [key, value] of params) {
    if (seen.has(key)) return false
    seen.add(key)
    const valid = Object.hasOwn(queryValidators, key) ? queryValidators[key] : undefined
    if (valid === undefined || !valid(value)) return false
  }
  return params.toString() === query
}

export const guideRouteFromParams = (params: URLSearchParams): GuideRoute => {
  const mode = params.get("mode")
  const goal = params.get("goal")
  const view = params.get("view")
  const n = params.get("n")
  const source = params.get("source")
  const node = params.get("node")
  return {
    mode: Schema.is(GuideMode)(mode) ? mode : params.has("p") ? "read" : "choices",
    goal: Schema.is(ReadingGoal)(goal) ? goal : null,
    n: Schema.is(ShortQuery)(n) ? Number(n) : 1,
    source: Schema.is(ShortQuery)(source) ? Number(source) : null,
    node: Schema.is(NodeQuery)(node) ? Number(node) : null,
    view: Schema.is(View)(view) ? view : "text",
  }
}

export const documentQuery = (params: URLSearchParams) => {
  const raw = params.get("p")
  return {
    guide: guideRouteFromParams(params),
    page: raw !== null && /^\d+$/u.test(raw) ? Number(raw) : 1,
  }
}

export const guideRouteFromLocation = (location: string): GuideRoute =>
  documentQuery(new URLSearchParams(location.split("?")[1] ?? "")).guide

export const selectedGoal = (route: Pick<GuideRoute, "mode" | "goal">): ReadingGoal | null => {
  if (route.goal !== null) return route.goal
  return route.mode === "walk" || route.mode === "claims" || route.mode === "map" ? route.mode : null
}

const clamp = (value: number, max: number): string => String(Math.max(1, Math.min(max, Math.trunc(value))))

export const guideLocation = (documentId: string, route: Partial<GuideRoute> & { readonly mode: GuideMode }, page?: number): string => {
  const params = new URLSearchParams({ mode: route.mode })
  if (route.goal !== null && route.goal !== undefined) params.set("goal", route.goal)
  if (route.mode === "walk" || route.mode === "claims") params.set("n", clamp(route.n ?? 1, 99))
  if (route.mode === "map" && route.node !== null && route.node !== undefined) params.set("node", clamp(route.node, 999))
  if (route.source !== null && route.source !== undefined) params.set("source", clamp(route.source, 99))
  if (route.view === "original" || route.view === "clean") params.set("view", route.view)
  if (page !== undefined) params.set("p", clamp(page, 999_999_999))
  return `/documents/${encodeURIComponent(documentId)}?${params}`
}
