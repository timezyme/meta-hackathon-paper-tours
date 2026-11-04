import { useLocation } from "./Location.tsx"
import { useEffect, useRef } from "react"
import { presentRoute } from "./client/browser.ts"

export const useRoutePresentation = (ready: boolean, title: string) => {
  const main = useRef<HTMLElement>(null)
  const { pathname } = useLocation()
  useEffect(() => {
    if (ready && main.current !== null) presentRoute(main.current, pathname, title)
  }, [ready, title, pathname])
  return main
}
