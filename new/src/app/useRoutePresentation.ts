import { useEffect, useRef, useSyncExternalStore } from "react"
import { presentRoute, readLocation, subscribeLocation } from "./client/browser.ts"

export const useRoutePresentation = (ready: boolean, title: string) => {
  const main = useRef<HTMLElement>(null)
  const location = useSyncExternalStore(subscribeLocation, readLocation)
  const pathname = location.split("?")[0] ?? location
  useEffect(() => {
    if (ready && main.current !== null) presentRoute(main.current, pathname, title)
  }, [ready, title, pathname])
  return main
}
