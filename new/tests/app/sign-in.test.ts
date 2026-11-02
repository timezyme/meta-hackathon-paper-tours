import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { SignInCard } from "../../src/app/App.tsx"

const ignore = () => {}
const render = (method: "email" | "password", passwordChosen: boolean) => renderToStaticMarkup(createElement(SignInCard, {
  options: { method, accessCode: false }, passwordChosen, onChoosePassword: ignore, submission: { kind: "idle" }, onSubmit: ignore,
}))

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

  it("shows only the password form when email sign-in is off", () => {
    const html = render("password", false)
    expect(html).toContain('name="password"')
    expect(html).not.toContain("Sign in with a password")
    expect(html).not.toContain("Back to email sign-in")
  })
})
