import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Session } from "../../src/domain/index.ts"
import { initialSession, sessionReducer, type SessionEvent, type SessionModel } from "../../src/app/session.ts"

const user = (id: string) =>
  Schema.decodeUnknownSync(Session)({ user: { id, email: `${id}@example.test`, role: "user" } })
const reader = user("reader")
const run = (events: ReadonlyArray<SessionEvent>, from: SessionModel = initialSession) =>
  events.reduce(sessionReducer, from)
const signedIn = run([{ _tag: "answered", version: 0, session: reader }])

describe("browser session state", () => {
  it("shows the session check only until the first answer", () => {
    expect(initialSession.state).toEqual({ kind: "checking" })
    expect(signedIn.state).toEqual({ kind: "authenticated", session: reader })
    expect(run([{ _tag: "check-failed", version: 0, message: "Offline" }]))
      .toEqual({ state: { kind: "unavailable", message: "Offline" }, version: 0, retry: false })
  })

  it("keeps the signed-in screen while a returning tab rechecks the session", () => {
    const rechecking = run([{ _tag: "revalidate" }], signedIn)
    expect(rechecking.state).toBe(signedIn.state)
    expect(rechecking.version).toBe(1)
    expect(run([{ _tag: "answered", version: 1, session: reader }], rechecking).state).toEqual(signedIn.state)
  })

  it("goes to sign-in when the recheck finds no session", () => {
    const signedOut = run([{ _tag: "revalidate" }, { _tag: "answered", version: 1, session: null }], signedIn)
    expect(signedOut.state).toEqual({ kind: "guest" })
  })

  it("keeps the screen after a transient recheck failure and retries later", () => {
    const failed = run([{ _tag: "revalidate" }, { _tag: "check-failed", version: 1, message: "Offline" }], signedIn)
    expect(failed).toEqual({ state: signedIn.state, version: 1, retry: true })
    const retried = run([{ _tag: "revalidate" }], failed)
    expect(retried).toEqual({ state: signedIn.state, version: 2, retry: false })
    expect(run([{ _tag: "answered", version: 2, session: null }], retried).state).toEqual({ kind: "guest" })
  })

  it("switches to the identity a recheck returns", () => {
    const other = user("other-reader")
    expect(run([{ _tag: "revalidate" }, { _tag: "answered", version: 1, session: other }], signedIn).state)
      .toEqual({ kind: "authenticated", session: other })
  })

  it("rechecks in the foreground after a rejected document request and ignores answers to older checks", () => {
    const invalidated = run([{ _tag: "invalidate" }], signedIn)
    expect(invalidated.state).toEqual({ kind: "checking" })
    expect(run([{ _tag: "answered", version: 0, session: reader }], invalidated)).toBe(invalidated)
    expect(run([{ _tag: "check-failed", version: 0, message: "Late" }], invalidated)).toBe(invalidated)
    expect(run([{ _tag: "signed", session: null }], signedIn))
      .toEqual({ state: { kind: "guest" }, version: 1, retry: false })
  })
})
