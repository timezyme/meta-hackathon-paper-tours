import { useEffect, useRef, useState } from "react"
import type { RatingValue } from "../../domain/index.ts"
import { runDocument } from "../client/documents.ts"
import { copyNormalizedText, saveRating, type OutputIdentity } from "../client/outputs.ts"

export type CopyState = "idle" | "pending" | "done"
export type Rating = typeof RatingValue.Type

export const useReaderActions = (identity: OutputIdentity, onUnauthenticated: () => void) => {
  const [copyState, setCopyState] = useState<CopyState>("idle")
  const [rating, setRating] = useState<Rating | null>(null)
  const [ratingPending, setRatingPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const lock = useRef({ copy: false, rating: false })
  const cancelCopy = useRef<(() => void) | undefined>(undefined)
  const cancelRating = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => { cancelCopy.current?.(); cancelRating.current?.() }, [])
  const onFailure = (error: { readonly kind: string; readonly message: string }) => {
    setMessage(error.message)
    if (error.kind === "unauthenticated") onUnauthenticated()
  }
  const copy = () => {
    if (lock.current.copy) return
    lock.current.copy = true
    setCopyState("pending")
    setMessage(null)
    cancelCopy.current = runDocument(copyNormalizedText(identity), () => {
      lock.current.copy = false
      setCopyState("done")
      setMessage("The entire normalized text was copied.")
    }, (error) => { lock.current.copy = false; setCopyState("idle"); onFailure(error) })
  }
  const rate = (value: Rating) => {
    if (lock.current.rating) return
    lock.current.rating = true
    setRatingPending(true)
    setMessage(null)
    cancelRating.current = runDocument(saveRating(identity, rating === value ? null : value), (saved) => {
      lock.current.rating = false
      setRatingPending(false)
      setRating(saved)
      setMessage(saved === null ? "Your rating was removed." : "Your rating was saved.")
    }, (error) => { lock.current.rating = false; setRatingPending(false); onFailure(error) })
  }
  return { copyState, rating, ratingPending, message, copy, rate, setRating }
}
