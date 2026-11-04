import { useEffect, useEffectEvent, useRef } from "react"

export const useFocusOnChange = <Key,>(key: Key, focus: () => void, {
  enabled = true, onMount = false,
}: { readonly enabled?: boolean; readonly onMount?: boolean } = {}) => {
  const previous = useRef(key)
  const pending = useRef(onMount)
  const applyFocus = useEffectEvent(focus)
  useEffect(() => {
    if (!enabled || (!pending.current && Object.is(previous.current, key))) return
    previous.current = key
    pending.current = false
    applyFocus()
    return () => { pending.current = onMount }
  }, [key, enabled, onMount])
}
