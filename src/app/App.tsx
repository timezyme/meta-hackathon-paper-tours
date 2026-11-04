import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { FormEvent, MouseEvent } from "react"
import { readSession, runAuth, signIn, signOut } from "./client/auth.ts"
import type { UserSession } from "./client/auth.ts"
import { applyTheme, navigate, readLocation, subscribeLocation, subscribeSessionRefresh } from "./client/browser.ts"
import type { Theme } from "./client/browser.ts"
import { routeFromLocation, signInPath } from "./navigation.ts"
import { Dashboard, DocumentPage } from "./DocumentWorkspace.tsx"
import type { UploadAttempt } from "./documents.ts"
import logoLight from "./assets/amuseme-logo.svg"
import logoDark from "./assets/amuseme-logo-reversed.svg"

type SessionState =
  | { readonly kind: "checking" }
  | { readonly kind: "guest" }
  | { readonly kind: "authenticated"; readonly session: UserSession }
  | { readonly kind: "unavailable"; readonly message: string }

type Submission = { readonly kind: "idle" } | { readonly kind: "pending" } | { readonly kind: "failed"; readonly message: string }

const internalClick = (event: MouseEvent<HTMLAnchorElement>, path: string) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  navigate(path)
}

function SignIn({ onSignedIn }: { readonly onSignedIn: (session: UserSession) => void }) {
  const [submission, setSubmission] = useState<Submission>({ kind: "idle" })
  const inFlight = useRef(false)
  const cancel = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => cancel.current?.(), [])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (inFlight.current) return
    const fields = new FormData(event.currentTarget)
    const email = fields.get("email")
    const password = fields.get("password")
    if (typeof email !== "string" || typeof password !== "string") return
    inFlight.current = true
    setSubmission({ kind: "pending" })
    cancel.current = runAuth(signIn(email.trim(), password), (session) => {
      inFlight.current = false
      onSignedIn(session)
    }, (error) => {
      inFlight.current = false
      setSubmission({ kind: "failed", message: error.message })
    })
  }

  return <main className="signin-page" id="main-content">
    <section className="signin-card" aria-labelledby="signin-title">
      <div className="intro">
        <div className="sky-greeting"><i aria-hidden="true" />Hi, I’m Sky.</div>
        <h1 id="signin-title">Welcome back.</h1>
        <p>Sign in to AmuseMe.</p>
      </div>
      <form onSubmit={submit} aria-busy={submission.kind === "pending"}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={254} aria-describedby={submission.kind === "failed" ? "signin-error" : undefined} readOnly={submission.kind === "pending"} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={128} aria-describedby={submission.kind === "failed" ? "signin-error" : undefined} readOnly={submission.kind === "pending"} />
        </div>
        {submission.kind === "failed" && <p id="signin-error" className="message error" role="alert">{submission.message}</p>}
        <button className="button primary signin-submit" type="submit" disabled={submission.kind === "pending"}>{submission.kind === "pending" ? "Signing in…" : "Sign in"}</button>
        <span className="visually-hidden" role="status">{submission.kind === "pending" ? "Signing in. Please wait." : ""}</span>
      </form>
      <p className="signin-note">Access is by invitation.</p>
    </section>
  </main>
}

export function App({ initialTheme, initialThemeSaved }: { readonly initialTheme: Theme; readonly initialThemeSaved: boolean }) {
  const location = useSyncExternalStore(subscribeLocation, readLocation)
  const route = routeFromLocation(location)
  const sessionLocation = route.kind === "sign-in" ? location : location.split("?")[0] ?? location
  const [sessionVersion, setSessionVersion] = useState(0)
  const [sessionSnapshot, setSessionSnapshot] = useState<{ readonly location: string; readonly version: number; readonly state: SessionState }>({ location, version: 0, state: { kind: "checking" } })
  const sessionState: SessionState = sessionSnapshot.location === sessionLocation && sessionSnapshot.version === sessionVersion ? sessionSnapshot.state : { kind: "checking" }
  const [theme, setTheme] = useState(initialTheme)
  const [themeSaved, setThemeSaved] = useState(initialThemeSaved)
  const [signingOut, setSigningOut] = useState<Submission>({ kind: "idle" })
  const [uploadAttempt, setUploadAttempt] = useState<UploadAttempt | null>(null)
  const onUnauthenticated = useCallback(() => setSessionVersion((value) => value + 1), [])
  const signOutLock = useRef(false)
  const cancelSignOut = useRef<(() => void) | undefined>(undefined)

  useEffect(() => subscribeSessionRefresh(() => setSessionVersion((value) => value + 1)), [])
  useEffect(() => () => cancelSignOut.current?.(), [])
  useEffect(() => {
    return runAuth(readSession, (session) => {
      const currentLocation = readLocation()
      if (session === null) {
        setSessionSnapshot({ location: sessionLocation, version: sessionVersion, state: { kind: "guest" } })
        if (routeFromLocation(currentLocation).kind !== "sign-in") navigate(signInPath(currentLocation), true)
      } else {
        setSessionSnapshot({ location: sessionLocation, version: sessionVersion, state: { kind: "authenticated", session } })
        const currentRoute = routeFromLocation(currentLocation)
        if (currentRoute.kind === "sign-in") navigate(currentRoute.returnTo, true)
      }
    }, (error) => setSessionSnapshot({ location: sessionLocation, version: sessionVersion, state: { kind: "unavailable", message: error.message } }))
  }, [sessionLocation, sessionVersion])

  const logout = () => {
    if (signOutLock.current) return
    signOutLock.current = true
    setSigningOut({ kind: "pending" })
    cancelSignOut.current = runAuth(signOut, () => {
      signOutLock.current = false
      setSigningOut({ kind: "idle" })
      setUploadAttempt(null)
      setSessionSnapshot({ location: sessionLocation, version: sessionVersion, state: { kind: "guest" } })
      navigate("/sign-in", true)
    }, (error) => {
      signOutLock.current = false
      setSigningOut({ kind: "failed", message: error.message })
    })
  }

  return <>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <header className="app-header">
      <div className="header-inner">
        <a className="brand" href="/" aria-label="AmuseMe home" onClick={(event) => internalClick(event, "/")}>
          <img className="brand-logo" src={theme === "dark" ? logoDark : logoLight} width="266" height="64" alt="AmuseMe" />
        </a>
        <nav className="account-actions" aria-label="Account and appearance">
          <button className="theme-button" type="button" onClick={() => {
            const next = theme === "dark" ? "light" : "dark"
            setThemeSaved(applyTheme(next))
            setTheme(next)
          }} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
            {theme === "dark" ? <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15a8 8 0 0 1-11-11 8.5 8.5 0 1 0 11 11Z" /></svg>}
          </button>
          {sessionState.kind === "authenticated" && <>
            {sessionState.session.user.role === "admin" && <a className="header-link" href="/admin/">Studio</a>}
            <button className="header-link" type="button" onClick={logout} disabled={signingOut.kind === "pending"}>{signingOut.kind === "pending" ? "Signing out…" : "Sign out"}</button>
          </>}
        </nav>
      </div>
    </header>
    {!themeSaved && <p className="preference-note" role="status">Theme changed for this visit. Your browser couldn’t save the preference.</p>}
    {signingOut.kind === "failed" && <p className="session-message message error" role="alert">{signingOut.message}</p>}
    {sessionState.kind === "checking" && <main className="status-page" id="main-content"><p role="status">Checking your session…</p></main>}
    {sessionState.kind === "unavailable" && <main className="status-page" id="main-content"><h1>We couldn’t open your workspace.</h1><p className="message error" role="alert">{sessionState.message}</p><button className="button" type="button" onClick={() => setSessionVersion((value) => value + 1)}>Try again</button></main>}
    {sessionState.kind === "guest" && <SignIn onSignedIn={(session) => {
      setSessionSnapshot({ location: sessionLocation, version: sessionVersion, state: { kind: "authenticated", session } })
      navigate(route.kind === "sign-in" ? route.returnTo : "/", true)
    }} />}
    {sessionState.kind === "authenticated" && (route.kind === "document" ? <DocumentPage id={route.documentId} onUnauthenticated={onUnauthenticated} /> : route.kind === "not-found" || route.kind === "admin-denied" ? <main className="status-page" id="main-content"><a className="back-link" href="/" onClick={(event) => internalClick(event, "/")}>All documents</a><h1>{route.kind === "admin-denied" ? "Administrator access required" : "Page not found."}</h1></main> : <Dashboard ownerId={sessionState.session.user.id} storedAttempt={uploadAttempt} setAttempt={setUploadAttempt} onUnauthenticated={onUnauthenticated} />)}
  </>
}
