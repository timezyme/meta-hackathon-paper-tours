import { LocationProvider, useLocation } from "./Location.tsx"
import { Fragment, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"
import type { RefObject } from "react"
import type { FormEvent } from "react"
import { readSession, readSignInOptions, runAuth, signIn, signInWithEmail, signOut } from "./client/auth.ts"
import type { SignInOptions } from "../domain/index.ts"
import type { UserSession } from "./client/auth.ts"
import {
  afterDelay, applyTheme, navigate, readLocation, subscribeSessionRefresh,
} from "./client/browser.ts"
import type { Theme } from "./client/browser.ts"
import { useRoutePresentation } from "./useRoutePresentation.ts"
import { signInPath } from "./navigation.ts"
import { initialSession, sessionReducer, sessionRetryDelay } from "./session.ts"
import { Dashboard, DocumentPage } from "./DocumentWorkspace.tsx"
import type { UploadAttempt } from "./documents.ts"
import { InternalLink } from "./links.tsx"
import frontispiece from "./assets/paper-frontispiece.svg"
import logoLight from "./assets/amuseme-logo.svg"
import logoDark from "./assets/amuseme-logo-reversed.svg"

const SunIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" />
  <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></svg>
const MoonIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 15a8 8 0 0 1-11-11 8.5 8.5 0 1 0 11 11Z" /></svg>

type Submission = { readonly kind: "idle" } | { readonly kind: "pending" } | { readonly kind: "failed"; readonly message: string }

function OptionsUnavailable({ message, onRetry }: { readonly message: string; readonly onRetry: () => void }) {
  return <section className="message error" role="alert"><p>{message}</p>
    <div className="document-actions">
      <button className="button" type="button" onClick={onRetry}>Try again</button>
    </div>
  </section>
}

export function SignInCard(props: {
  readonly options: SignInOptions | null
  readonly optionsError: string | null
  readonly onRetryOptions: () => void
  readonly passwordChosen: boolean
  readonly onChoosePassword: (chosen: boolean) => void
  readonly submission: Submission
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
  const { options, optionsError, onRetryOptions, passwordChosen, onChoosePassword, submission, onSubmit } = props
  const pending = submission.kind === "pending"
  const emailOnly = options?.method === "email" && !passwordChosen
  const describedBy = submission.kind === "failed" ? "signin-error" : undefined
  return <section className="signin-card" aria-labelledby="signin-title">
    <div className="intro">
      <h1 id="signin-title">{emailOnly ? "Try AmuseMe" : "Open your library"}</h1>
      <p>{emailOnly ? "Enter your email to try AmuseMe. No password needed." : "Sign in to read your documents and their guides."}</p>
    </div>
    {optionsError !== null ? <OptionsUnavailable message={optionsError} onRetry={onRetryOptions} />
      : options === null ? <p className="signin-note" role="status">Loading…</p>
      : <form onSubmit={onSubmit} aria-busy={submission.kind === "pending"}>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete={emailOnly ? "email" : "username"} autoCapitalize="none" spellCheck={false} required maxLength={254}
          aria-describedby={describedBy} readOnly={pending} />
      </div>
      {!emailOnly && <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={128}
          aria-describedby={describedBy} readOnly={pending} />
      </div>}
      {emailOnly && options.accessCode && <div className="field">
        <label htmlFor="access-code">Access code</label>
        <input id="access-code" name="access-code" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={256}
          aria-describedby={describedBy} readOnly={pending} />
      </div>}
      {submission.kind === "failed" && <p id="signin-error" className="message error" role="alert">{submission.message}</p>}
      <button className="button primary signin-submit" type="submit" disabled={pending}>{pending ? "Signing in…" : emailOnly ? "Continue" : "Sign in"}</button>
      <span className="visually-hidden" role="status">{submission.kind === "pending" ? "Signing in. Please wait." : ""}</span>
    </form>}
    <p className="signin-note">{emailOnly ? "You can read the example documents and try your own PDFs." : "Access is by invitation."}</p>
    {options?.method === "email" && <p className="signin-note">
      <button className="text-button" type="button" disabled={pending} onClick={() => onChoosePassword(!passwordChosen)}>
        {passwordChosen ? "Back to email sign-in" : "Sign in with a password"}
      </button>
    </p>}
  </section>
}

type OptionsLoad = { readonly version: number; readonly options: SignInOptions | null; readonly error: string | null }

function SignIn({ onSignedIn }: { readonly onSignedIn: (session: UserSession) => void }) {
  const main = useRoutePresentation(true, "Sign in · AmuseMe")
  const [submission, setSubmission] = useState<Submission>({ kind: "idle" })
  const [optionsVersion, setOptionsVersion] = useState(0)
  const [optionsLoad, setOptionsLoad] = useState<OptionsLoad>({ version: 0, options: null, error: null })
  const options = optionsLoad.options
  const optionsError = optionsLoad.version === optionsVersion ? optionsLoad.error : null
  const [passwordChosen, setPasswordChosen] = useState(false)
  const inFlight = useRef(false)
  const cancel = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => cancel.current?.(), [])
  useEffect(() => runAuth(readSignInOptions,
    (loaded) => setOptionsLoad({ version: optionsVersion, options: loaded, error: null }),
    (error) => setOptionsLoad({ version: optionsVersion, options: null, error: error.message })), [optionsVersion])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (inFlight.current || options === null) return
    const fields = new FormData(event.currentTarget)
    const email = fields.get("email")
    const password = fields.get("password")
    const accessCode = fields.get("access-code")
    if (typeof email !== "string") return
    const program = options.method === "email" && !passwordChosen
      ? signInWithEmail(email.trim(), typeof accessCode === "string" ? accessCode.trim() : null)
      : typeof password === "string" ? signIn(email.trim(), password) : null
    if (program === null) return
    inFlight.current = true
    setSubmission({ kind: "pending" })
    cancel.current = runAuth(program, (session) => {
      inFlight.current = false
      onSignedIn(session)
    }, (error) => {
      inFlight.current = false
      setSubmission({ kind: "failed", message: error.message })
    })
  }

  const retryOptions = () => setOptionsVersion((value) => value + 1)
  const choosePassword = (chosen: boolean) => {
    if (inFlight.current) return
    setPasswordChosen(chosen)
    setSubmission({ kind: "idle" })
  }

  return <main className="signin-page" id="main-content" ref={main} tabIndex={-1}>
    <SignInCard options={options} optionsError={optionsError} onRetryOptions={retryOptions}
      passwordChosen={passwordChosen} onChoosePassword={choosePassword} submission={submission} onSubmit={submit} />
    <div className="signin-print" aria-hidden="true">
      <img src={frontispiece} width="360" height="390" alt="" />
    </div>
  </main>
}

function NotFoundPage({ main, adminDenied }: { readonly main: RefObject<HTMLElement | null>; readonly adminDenied: boolean }) {
  return <main className="status-page" id="main-content" ref={main} tabIndex={-1}>
    <InternalLink className="back-link" href="/">Your library</InternalLink>
    <h1>{adminDenied ? "Administrator access required" : "Page not found."}</h1>
  </main>
}

type WorkspaceUnavailableProps = { readonly main: RefObject<HTMLElement | null>; readonly message: string; readonly onRetry: () => void }

function WorkspaceUnavailable({ main, message, onRetry }: WorkspaceUnavailableProps) {
  return <main className="status-page" id="main-content" ref={main} tabIndex={-1}>
    <h1>We couldn’t open your workspace.</h1>
    <p className="message error" role="alert">{message}</p>
    <button className="button" type="button" onClick={onRetry}>Try again</button>
  </main>
}

type AppProps = { readonly initialTheme: Theme; readonly initialThemeSaved: boolean }

export function App(props: AppProps) {
  return <LocationProvider><AppContent {...props} /></LocationProvider>
}

function AppContent({ initialTheme, initialThemeSaved }: AppProps) {
  const { location, pathname, route } = useLocation()
  const sessionLocation = route.kind === "sign-in" ? location : pathname
  const sessionReturnTo = route.kind === "sign-in" ? route.returnTo : null
  const sessionTarget = useMemo(() => ({ location: sessionLocation, returnTo: sessionReturnTo }), [sessionLocation, sessionReturnTo])
  const [session, dispatchSession] = useReducer(sessionReducer, initialSession)
  const sessionState = session.state
  const [theme, setTheme] = useState(initialTheme)
  const [themeSaved, setThemeSaved] = useState(initialThemeSaved)
  const [signingOut, setSigningOut] = useState<Submission>({ kind: "idle" })
  const [uploadAttempt, setUploadAttempt] = useState<UploadAttempt | null>(null)
  const onUnauthenticated = useCallback(() => dispatchSession({ _tag: "invalidate" }), [])
  const missingRoute = route.kind === "not-found" || route.kind === "admin-denied"
  const terminal = sessionState.kind === "unavailable" || (sessionState.kind === "authenticated" && missingRoute)
  const terminalTitle = sessionState.kind === "unavailable" ? "Workspace unavailable"
    : route.kind === "admin-denied" ? "Administrator access required" : "Page not found"
  const terminalMain = useRoutePresentation(terminal, `${terminalTitle} · AmuseMe`)
  const signOutLock = useRef(false)
  const cancelSignOut = useRef<(() => void) | undefined>(undefined)

  useEffect(() => subscribeSessionRefresh(() => dispatchSession({ _tag: "revalidate" })), [])
  useEffect(() => () => cancelSignOut.current?.(), [])
  const checkVersion = session.version
  useEffect(() => runAuth(readSession, (confirmed) => {
    dispatchSession({ _tag: "answered", version: checkVersion, session: confirmed })
    if (confirmed === null && sessionTarget.returnTo === null) navigate(signInPath(readLocation()), true)
    if (confirmed !== null && sessionTarget.returnTo !== null) navigate(sessionTarget.returnTo, true)
  }, (error) => dispatchSession({ _tag: "check-failed", version: checkVersion, message: error.message })),
  [sessionTarget, checkVersion])
  useEffect(() => {
    if (session.retry) return afterDelay(sessionRetryDelay, () => dispatchSession({ _tag: "revalidate" }))
  }, [session.retry])

  const logout = () => {
    if (signOutLock.current) return
    signOutLock.current = true
    setSigningOut({ kind: "pending" })
    cancelSignOut.current = runAuth(signOut, () => {
      signOutLock.current = false
      setSigningOut({ kind: "idle" })
      setUploadAttempt(null)
      dispatchSession({ _tag: "signed", session: null })
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
        <InternalLink className="brand" href="/" aria-label="AmuseMe home">
          <img className="brand-logo" src={theme === "dark" ? logoDark : logoLight} width="266" height="64" alt="AmuseMe" />
        </InternalLink>
        <nav className="account-actions" aria-label="Account and appearance">
          <button className="theme-button" type="button" onClick={() => {
            const next = theme === "dark" ? "light" : "dark"
            setThemeSaved(applyTheme(next))
            setTheme(next)
          }} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
          </button>
          {sessionState.kind === "authenticated" && <>
            {sessionState.session.user.role === "admin" && <a className="header-link" href="/admin/">Studio</a>}
            <button className="header-link" type="button" onClick={logout} disabled={signingOut.kind === "pending"}>
              {signingOut.kind === "pending" ? "Signing out…" : "Sign out"}</button>
          </>}
        </nav>
      </div>
    </header>
    {!themeSaved && <p className="preference-note" role="status">Theme changed for this visit. Your browser couldn’t save the preference.</p>}
    {signingOut.kind === "failed" && <p className="session-message message error" role="alert">{signingOut.message}</p>}
    {sessionState.kind === "checking" && <main className="status-page" id="main-content"><p role="status">Checking your session…</p></main>}
    {sessionState.kind === "unavailable"
      && <WorkspaceUnavailable main={terminalMain} message={sessionState.message}
        onRetry={() => dispatchSession({ _tag: "invalidate" })} />}
    {sessionState.kind === "guest" && <SignIn onSignedIn={(signedIn) => {
      dispatchSession({ _tag: "signed", session: signedIn })
      navigate(route.kind === "sign-in" ? route.returnTo : "/", true)
    }} />}
    {sessionState.kind === "authenticated" && <Fragment key={sessionState.session.user.id}>{route.kind === "document"
      ? <DocumentPage id={route.documentId} viewerId={sessionState.session.user.id} onUnauthenticated={onUnauthenticated} />
      : missingRoute
        ? <NotFoundPage main={terminalMain} adminDenied={route.kind === "admin-denied"} />
        : <Dashboard ownerId={sessionState.session.user.id} storedAttempt={uploadAttempt} setAttempt={setUploadAttempt}
          onUnauthenticated={onUnauthenticated} />}</Fragment>}
  </>
}
