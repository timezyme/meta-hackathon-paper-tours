import { Clock, Effect, Schema, type Duration } from "effect"

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

export const focusSourceQuote = (element: HTMLElement): void => Effect.runSync(Effect.sync(() => {
  element.focus({ preventScroll: true })
  element.querySelector("mark")?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" })
}))

export const focusMapNode = (element: HTMLElement): void => Effect.runSync(Effect.sync(() => {
  element.focus({ preventScroll: true })
  element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" })
}))

export const observeWidth = (element: HTMLElement, onWidth: (width: number) => void): (() => void) => Effect.runSync(Effect.sync(() => {
  const observer = new ResizeObserver((entries) => { const entry = entries[0]; if (entry !== undefined) onWidth(entry.contentRect.width) })
  observer.observe(element)
  return () => Effect.runSync(Effect.sync(() => observer.disconnect()))
}))

const interactiveTargets = "a, button, input, textarea, select, summary, dialog, [contenteditable]"
const plainArrow = (event: KeyboardEvent): boolean =>
  !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")
const guideKeyHandler = (turn: (delta: number) => void) => (event: KeyboardEvent) => {
  if (!plainArrow(event)) return
  if (event.target instanceof Element && event.target.closest(interactiveTargets)) return
  if (document.querySelector("dialog[open]") !== null) return
  event.preventDefault()
  turn(event.key === "ArrowLeft" ? -1 : 1)
}

export const subscribeGuideKeys = (turn: (delta: number) => void): (() => void) => Effect.runSync(Effect.sync(() => {
  const onKey = guideKeyHandler(turn)
  document.addEventListener("keydown", onKey)
  return () => Effect.runSync(Effect.sync(() => document.removeEventListener("keydown", onKey)))
}))

export const makeRoutePresenter = () => {
  let observedPathname: string | undefined
  let focusPending = true
  const observePathname = (): void => {
    const pathname = window.location.pathname
    if (observedPathname === pathname) return
    observedPathname = pathname
    focusPending = true
  }
  const present = (element: HTMLElement, pathname: string, title: string): void => Effect.runSync(Effect.sync(() => {
    observePathname()
    if (!element.isConnected || window.location.pathname !== pathname) return
    document.title = title
    if (!focusPending) return
    focusPending = false
    element.focus({ preventScroll: true })
  }))
  const subscribe = (listener: () => void): (() => void) => Effect.runSync(Effect.sync(() => {
    observePathname()
    const changed = () => Effect.runSync(Effect.sync(() => { observePathname(); listener() }))
    window.addEventListener("popstate", changed)
    return () => Effect.runSync(Effect.sync(() => window.removeEventListener("popstate", changed)))
  }))
  return { present, subscribe }
}
const routePresenter = makeRoutePresenter()
export const presentRoute = routePresenter.present
export const subscribeLocation = routePresenter.subscribe

export const subscribeClock = (onTick: (now: number) => void): (() => void) => {
  const tick = Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Effect.sync(() => onTick(now))), Effect.andThen(Effect.sleep("1 second")))
  const interrupt = Effect.runCallback(Effect.forever(tick))
  return () => interrupt()
}

export const afterDelay = (delay: Duration.Input, run: () => void): (() => void) => {
  const interrupt = Effect.runCallback(Effect.sleep(delay).pipe(Effect.andThen(Effect.sync(run))))
  return () => interrupt()
}

export const openProcessingReport =(details: HTMLDetailsElement, summary: HTMLElement): void => Effect.runSync(Effect.sync(() => {
  details.open = true
  summary.focus({ preventScroll: true })
  summary.scrollIntoView({ block: "start", behavior: "instant" })
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
