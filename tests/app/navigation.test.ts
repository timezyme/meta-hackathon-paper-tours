import { describe, expect, it } from "vitest"
import { routeFromLocation, safeReturnPath, signInPath } from "../../src/app/navigation.ts"

describe("safe return paths", () => {
  it("retains only internal dashboard and document paths", () => {
    expect(safeReturnPath("/")).toBe("/")
    expect(safeReturnPath("/documents/doc_123-A")).toBe("/documents/doc_123-A")
    expect(signInPath("/documents/doc_123-A")).toBe("/sign-in?returnTo=%2Fdocuments%2Fdoc_123-A")
    expect(safeReturnPath("/documents/doc_123-A?p=2")).toBe("/documents/doc_123-A?p=2")
    expect(signInPath("/documents/doc_123-A?p=2")).toBe("/sign-in?returnTo=%2Fdocuments%2Fdoc_123-A%3Fp%3D2")
  })

  it.each(["0", "-1", "Infinity", "1e3", "1.2", "1000000000", "1&p=2", "1&next=https://evil.example", "1#fragment", "%31", "javascript:alert(1)"])("rejects unsupported page query %s", (value) => {
    expect(safeReturnPath(`/documents/doc?p=${value}`)).toBe("/")
  })

  it.each([null, "", "https://example.com/", "//example.com", "/\\example.com", "/%2f%2fexample.com", "/documents/../admin", "/documents/%2e%2e", "/documents/doc?next=https://example.com", "/documents/doc#fragment", "/admin/", "/sign-in", "/documents/", `/documents/${"a".repeat(129)}`])("rejects unsafe or unsupported target %s", (value) => {
    expect(safeReturnPath(value)).toBe("/")
  })

  it("decodes a sign-in return parameter once, then validates it", () => {
    expect(routeFromLocation("/sign-in?returnTo=%2Fdocuments%2Fdoc_123-A")).toEqual({ kind: "sign-in", returnTo: "/documents/doc_123-A" })
    expect(routeFromLocation("/sign-in?returnTo=%2Fdocuments%2Fdoc_123-A%3Fp%3D2")).toEqual({ kind: "sign-in", returnTo: "/documents/doc_123-A?p=2" })
    expect(routeFromLocation("/sign-in?returnTo=%2F%2Fevil.example")).toEqual({ kind: "sign-in", returnTo: "/" })
    expect(routeFromLocation("/sign-in?returnTo=%252Fdocuments%252Fdoc")).toEqual({ kind: "sign-in", returnTo: "/" })
  })
})

describe("application route parsing", () => {
  it("recognizes denied Studio page paths without treating similar names as Studio", () => {
    for (const path of ["/admin", "/admin/", "/admin/agents", "/admin/workflows/example?view=runs"]) {
      expect(routeFromLocation(path)).toEqual({ kind: "admin-denied" })
    }
    expect(routeFromLocation("/administrator")).toEqual({ kind: "not-found" })
    expect(safeReturnPath("/admin/agents")).toBe("/")
  })

  it("distinguishes the dashboard, document shell and unknown routes", () => {
    expect(routeFromLocation("/")).toEqual({ kind: "dashboard" })
    expect(routeFromLocation("/documents/doc_123-A")).toEqual({ kind: "document", documentId: "doc_123-A" })
    expect(routeFromLocation("/documents/invalid/id")).toEqual({ kind: "not-found" })
    expect(routeFromLocation("/unknown")).toEqual({ kind: "not-found" })
  })
})
