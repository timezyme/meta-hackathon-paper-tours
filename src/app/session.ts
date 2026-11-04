import type { UserSession } from "./client/auth.ts"

export type SessionState =
  | { readonly kind: "checking" }
  | { readonly kind: "guest" }
  | { readonly kind: "authenticated"; readonly session: UserSession }
  | { readonly kind: "unavailable"; readonly message: string }

export type SessionModel = { readonly state: SessionState; readonly version: number; readonly retry: boolean }

export type SessionEvent =
  | { readonly _tag: "revalidate" }
  | { readonly _tag: "invalidate" }
  | { readonly _tag: "signed"; readonly session: UserSession | null }
  | { readonly _tag: "answered"; readonly version: number; readonly session: UserSession | null }
  | { readonly _tag: "check-failed"; readonly version: number; readonly message: string }

export const sessionRetryDelay = "30 seconds"
export const initialSession: SessionModel = { state: { kind: "checking" }, version: 0, retry: false }

const signedState = (session: UserSession | null): SessionState =>
  session === null ? { kind: "guest" } : { kind: "authenticated", session }
const settled = (state: SessionState): boolean => state.kind === "guest" || state.kind === "authenticated"

export const sessionReducer = (model: SessionModel, event: SessionEvent): SessionModel => {
  switch (event._tag) {
    case "revalidate": return { ...model, version: model.version + 1, retry: false }
    case "invalidate": return { state: { kind: "checking" }, version: model.version + 1, retry: false }
    case "signed": return { state: signedState(event.session), version: model.version + 1, retry: false }
    case "answered":
      return event.version === model.version ? { ...model, state: signedState(event.session), retry: false } : model
    case "check-failed":
      if (event.version !== model.version) return model
      return settled(model.state) ? { ...model, retry: true }
        : { ...model, state: { kind: "unavailable", message: event.message }, retry: false }
  }
}
