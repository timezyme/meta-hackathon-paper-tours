import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react"
import { readLocation, subscribeLocation } from "./client/browser.ts"
import { parseLocation } from "./navigation.ts"

const LocationContext = createContext(parseLocation("/"))

export function LocationProvider({ children }: { readonly children: ReactNode }) {
  const location = useSyncExternalStore(subscribeLocation, readLocation)
  const parsed = useMemo(() => parseLocation(location), [location])
  return <LocationContext value={parsed}>{children}</LocationContext>
}

export const useLocation = () => useContext(LocationContext)
