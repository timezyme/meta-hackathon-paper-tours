import { afterEach, describe, expect, it, vi } from "vitest"
import { focusSourceQuote, makeRoutePresenter, navigate, openProcessingReport, subscribeGuideKeys } from "../../../src/app/client/browser.ts"

class BrowserElement {
  isConnected = true
  focus = vi.fn()
  scrollIntoView = vi.fn()
  querySelector = vi.fn(() => null)
}
class BrowserDetails extends BrowserElement { open = false }
const setup = (pathname: string) => {
  const events = new EventTarget()
  const location = { pathname, search: "" }
  const change = (_state: unknown, _unused: string, path: string) => {
    const url = new URL(path, "https://app.example.test")
    location.pathname = url.pathname
    location.search = url.search
  }
  vi.stubGlobal("window", {
    location, history: { pushState: change, replaceState: change },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  })
  vi.stubGlobal("document", { title: "Previous route" })
  vi.stubGlobal("PopStateEvent", Event)
  vi.stubGlobal("HTMLElement", BrowserElement)
  vi.stubGlobal("HTMLDetailsElement", BrowserDetails)
  return { location, back: (path: string) => { change(null, "", path); events.dispatchEvent(new Event("popstate")) } }
}
afterEach(() => vi.unstubAllGlobals())

describe("ready route presentation", () => {
  it("keeps keyboard focus on the cited block while centering the exact quote, including return from original", () => {
    setup("/documents/source")
    const block = new HTMLElement()
    const quote = new HTMLElement()
    const blockFocus = vi.spyOn(block, "focus")
    const blockScroll = vi.spyOn(block, "scrollIntoView")
    const quoteFocus = vi.spyOn(quote, "focus")
    const quoteScroll = vi.spyOn(quote, "scrollIntoView")
    const lookup = vi.spyOn(block, "querySelector").mockReturnValue(quote)
    focusSourceQuote(block)
    focusSourceQuote(block)
    expect(blockFocus).toHaveBeenCalledTimes(2)
    expect(blockFocus).toHaveBeenLastCalledWith({ preventScroll: true })
    expect(lookup).toHaveBeenLastCalledWith("mark")
    expect(quoteScroll).toHaveBeenCalledTimes(2)
    expect(blockScroll).not.toHaveBeenCalled()
    expect(quoteFocus).not.toHaveBeenCalled()
    lookup.mockReturnValue(null)
    focusSourceQuote(block)
    expect(blockFocus).toHaveBeenCalledTimes(3)
    expect(quoteScroll).toHaveBeenCalledTimes(2)
    expect(blockScroll).not.toHaveBeenCalled()
  })
  it("turns guide pages only for unmodified arrows outside controls and dialogs, and removes its listener", () => {
    const events = new EventTarget()
    let dialogOpen = false
    class KeyTarget extends EventTarget {
      interactive = false
      closest = () => this.interactive ? this : null
    }
    const target = new KeyTarget()
    vi.stubGlobal("Element", KeyTarget)
    vi.stubGlobal("document", {
      querySelector: () => dialogOpen ? {} : null,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    })
    const turn = vi.fn()
    const stop = subscribeGuideKeys(turn)
    const key = (value: string, modified = false) => {
      const event = new Event("keydown", { cancelable: true })
      Object.defineProperties(event, { key: { value }, target: { value: target }, ctrlKey: { value: modified } })
      events.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(key("ArrowRight")).toBe(true)
    expect(turn).toHaveBeenLastCalledWith(1)
    expect(key("ArrowLeft")).toBe(true)
    expect(turn).toHaveBeenLastCalledWith(-1)
    expect(key("ArrowRight", true)).toBe(false)
    target.interactive = true
    expect(key("ArrowRight")).toBe(false)
    target.interactive = false
    dialogOpen = true
    expect(key("ArrowRight")).toBe(false)
    dialogOpen = false
    stop()
    expect(key("ArrowRight")).toBe(false)
    expect(turn).toHaveBeenCalledTimes(2)
  })
  it("sets title and focuses the ready owner once, without moving scroll on query, polls or title updates", () => {
    setup("/documents/first")
    const { present: presentRoute, subscribe } = makeRoutePresenter()
    const unsubscribe = subscribe(vi.fn())
    const main = new HTMLElement()
    const focus = vi.spyOn(main, "focus")
    const scroll = vi.spyOn(main, "scrollIntoView")
    presentRoute(main, "/documents/first", "First · AmuseMe")
    expect(document.title).toBe("First · AmuseMe")
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true })
    navigate("/documents/first?p=2")
    presentRoute(main, "/documents/first", "Updated filename · AmuseMe")
    presentRoute(main, "/documents/first", "Updated filename · AmuseMe")
    expect(document.title).toBe("Updated filename · AmuseMe")
    expect(focus).toHaveBeenCalledTimes(1)
    expect(scroll).not.toHaveBeenCalled()
    unsubscribe()
  })
  it("retains a focus request across loading routes and focuses again on history back", () => {
    const browser = setup("/documents/start")
    const listener = vi.fn()
    const { present: presentRoute, subscribe } = makeRoutePresenter()
    const unsubscribe = subscribe(listener)
    const first = new HTMLElement()
    const firstFocus = vi.spyOn(first, "focus")
    presentRoute(first, "/documents/start", "Start")
    navigate("/documents/loading")
    const stale = new HTMLElement()
    const staleFocus = vi.spyOn(stale, "focus")
    presentRoute(stale, "/documents/start", "Stale response")
    expect(staleFocus).not.toHaveBeenCalled()
    expect(document.title).toBe("Start")
    browser.back("/documents/start")
    presentRoute(first, "/documents/start", "Start again")
    expect(firstFocus).toHaveBeenCalledTimes(2)
    navigate("/documents/destination")
    const destination = new HTMLElement()
    const destinationFocus = vi.spyOn(destination, "focus")
    Object.defineProperty(destination, "isConnected", { value: false, configurable: true })
    presentRoute(destination, "/documents/destination", "Detached")
    expect(document.title).toBe("Start again")
    Object.defineProperty(destination, "isConnected", { value: true })
    presentRoute(destination, "/documents/destination", "Destination")
    expect(destinationFocus).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(3)
    unsubscribe()
  })
  it("opens, focuses and reveals the requested report on every review", () => {
    setup("/documents/report")
    const drawer = new HTMLDetailsElement()
    const summary = new HTMLElement()
    const focus = vi.spyOn(summary, "focus")
    const scroll = vi.spyOn(summary, "scrollIntoView")
    openProcessingReport(drawer, summary)
    drawer.open = false
    openProcessingReport(drawer, summary)
    expect(drawer.open).toBe(true)
    expect(focus).toHaveBeenCalledTimes(2)
    expect(scroll).toHaveBeenCalledTimes(2)
  })
})
