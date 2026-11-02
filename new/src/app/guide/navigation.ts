import { Schema } from "effect"

export const GuideMode = Schema.Literals(["choices", "overview", "walk", "claims", "read", "done-walk", "done-claims"])
export type GuideMode = typeof GuideMode.Type
export const ReadingGoal = Schema.Literals(["walk", "claims", "read"])
export type ReadingGoal = typeof ReadingGoal.Type
const View = Schema.Literals(["text", "original", "clean"])
const PositiveQuery = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,8}$/u))
const ShortQuery = Schema.String.check(Schema.isPattern(/^[1-9][0-9]?$/u))

export type GuideRoute = {
  readonly mode: GuideMode
  readonly goal: ReadingGoal | null
  readonly n: number
  readonly source: number | null
  readonly view: "text" | "original" | "clean"
}

export const validDocumentQuery = (query: string): boolean => {
  if (query.length === 0 || query.length > 160 || !/^[A-Za-z0-9=&-]+$/u.test(query)) return false
  const params = new URLSearchParams(query)
  const seen = new Set<string>()
  for (const [key, value] of params) {
    if (seen.has(key)) return false
    seen.add(key)
    const valid = key === "mode" ? Schema.is(GuideMode)(value) : key === "goal" ? Schema.is(ReadingGoal)(value) : key === "view" ? Schema.is(View)(value) : key === "p" ? Schema.is(PositiveQuery)(value) : key === "n" || key === "source" ? Schema.is(ShortQuery)(value) : false
    if (!valid) return false
  }
  return params.toString() === query
}

export const guideRouteFromLocation = (location: string): GuideRoute => {
  const params = new URLSearchParams(location.split("?")[1] ?? "")
  const mode = params.get("mode")
  const goal = params.get("goal")
  const view = params.get("view")
  const n = params.get("n")
  const source = params.get("source")
  return {
    mode: Schema.is(GuideMode)(mode) ? mode : params.has("p") ? "read" : "choices",
    goal: Schema.is(ReadingGoal)(goal) ? goal : null,
    n: Schema.is(ShortQuery)(n) ? Number(n) : 1,
    source: Schema.is(ShortQuery)(source) ? Number(source) : null,
    view: Schema.is(View)(view) ? view : "text",
  }
}

export const guideLocation = (documentId: string, route: Partial<GuideRoute> & { readonly mode: GuideMode }, page?: number): string => {
  const params = new URLSearchParams({ mode: route.mode })
  if (route.goal !== null && route.goal !== undefined) params.set("goal", route.goal)
  if (route.mode === "walk" || route.mode === "claims") params.set("n", String(Math.max(1, Math.min(99, Math.trunc(route.n ?? 1)))))
  if (route.source !== null && route.source !== undefined) params.set("source", String(Math.max(1, Math.min(99, Math.trunc(route.source)))))
  if (route.view === "original" || route.view === "clean") params.set("view", route.view)
  if (page !== undefined) params.set("p", String(Math.max(1, Math.min(999_999_999, Math.trunc(page)))))
  return `/documents/${encodeURIComponent(documentId)}?${params}`
}
