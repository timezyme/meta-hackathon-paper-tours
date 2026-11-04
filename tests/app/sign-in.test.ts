import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { SignInCard } from "../../src/app/App.tsx"

const ignore = () => {}
const card = {
  optionsError: null, onRetryOptions: ignore, onChoosePassword: ignore, submission: { kind: "idle" }, onSubmit: ignore,
} as const
const render = (method: "email" | "password", passwordChosen: boolean) =>
  renderToStaticMarkup(createElement(SignInCard, { ...card, options: { method, accessCode: false }, passwordChosen }))

describe("sign-in card", () => {
  it("keeps the password form reachable when judge email sign-in is on", () => {
    const judge = render("email", false)
    expect(judge).toContain("Continue")
    expect(judge).not.toContain('name="password"')
    expect(judge).toContain(">Sign in with a password</button>")

    const password = render("email", true)
    expect(password).toContain('name="password"')
    expect(password).toContain(">Sign in</button>")
    expect(password).toContain(">Back to email sign-in</button>")
  })

  it("shows why sign-in cannot start and offers a retry instead of a password form", () => {
    const message = "We couldn’t load the sign-in page. Please try again."
    const html = renderToStaticMarkup(createElement(SignInCard, {
      ...card, options: null, optionsError: message, passwordChosen: false,
    }))
    expect(html).toContain(`role="alert"><p>${message}</p>`)
    expect(html).toContain(">Try again</button>")
    expect(html).not.toContain("<form")
    expect(html).not.toContain("Loading…")
  })

  it("shows only the password form when email sign-in is off", () => {
    const html = render("password", false)
    expect(html).toContain('name="password"')
    expect(html).not.toContain("Sign in with a password")
    expect(html).not.toContain("Back to email sign-in")
  })
})
