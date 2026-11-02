import { describe, expect, it } from "vitest"
import { countLabel, headingText } from "../../src/app/text.ts"

describe("interface text helpers", () => {
  it("pluralizes counts", () => {
    expect(countLabel(1, "step")).toBe("1 step")
    expect(countLabel(0, "step")).toBe("0 steps")
    expect(countLabel(2, "more excerpt", "more excerpts")).toBe("2 more excerpts")
  })

  it("removes Markdown heading markers", () => {
    expect(headingText("## Results ")).toBe("Results")
    expect(headingText("#hashtag")).toBe("#hashtag")
  })
})
