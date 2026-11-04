import { Effect, Schema } from "effect"

export type Theme = "dark" | "light"
const themeKey = "amuseme.theme"

class PreferenceUnavailable extends Schema.TaggedError<PreferenceUnavailable>()("PreferenceUnavailable", {}) {}

export const readTheme = (): Theme => Effect.runSync(Effect.try({
  try: () => localStorage.getItem(themeKey) === "light" ? "light" as const : "dark" as const,
  catch: () => new PreferenceUnavailable({}),
}).pipe(Effect.catchTag("PreferenceUnavailable", () => Effect.succeed("dark" as const))))

export const applyTheme = (theme: Theme): boolean => Effect.runSync(Effect.gen(function* () {
  yield* Effect.sync(() => { document.documentElement.dataset.theme = theme })
  return yield* Effect.try({
    try: () => { localStorage.setItem(themeKey, theme); return true },
    catch: () => new PreferenceUnavailable({}),
  }).pipe(Effect.catchTag("PreferenceUnavailable", () => Effect.succeed(false)))
}))

export const readLocation = (): string => Effect.runSync(Effect.sync(() => window.location.pathname + window.location.search))

export const navigate = (path: string, replace = false): void => Effect.runSync(Effect.sync(() => {
  if (replace) window.history.replaceState(null, "", path)
  else window.history.pushState(null, "", path)
  window.dispatchEvent(new PopStateEvent("popstate"))
}))

export const focusReadingPage = (element: HTMLElement): void => Effect.runSync(Effect.sync(() => {
  element.focus({ preventScroll: true })
  element.scrollIntoView({ block: "start", behavior: "instant" })
}))

export const subscribeLocation = (listener: () => void): (() => void) => Effect.runSync(Effect.sync(() => {
  window.addEventListener("popstate", listener)
  return () => Effect.runSync(Effect.sync(() => { window.removeEventListener("popstate", listener) }))
}))

export const subscribeSessionRefresh = (listener: () => void): (() => void) => {
  const refresh = () => { if (document.visibilityState === "visible") listener() }
  return Effect.runSync(Effect.sync(() => {
    document.addEventListener("visibilitychange", refresh)
    window.addEventListener("pageshow", refresh)
    return () => Effect.runSync(Effect.sync(() => {
      document.removeEventListener("visibilitychange", refresh)
      window.removeEventListener("pageshow", refresh)
    }))
  }))
}
