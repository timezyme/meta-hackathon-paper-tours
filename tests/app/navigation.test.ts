import { describe, expect, it } from "vitest"
import { routeFromLocation, safeReturnPath, signInPath } from "../../src/app/navigation.ts"
import { guideLocation, guideRouteFromLocation } from "../../src/app/guide/navigation.ts"

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

  it("retains only bounded guide navigation through sign-in", () => {
    const path = "/documents/doc?mode=claims&n=3&source=2&view=original&p=8"
    expect(safeReturnPath(path)).toBe(path)
    expect(routeFromLocation(signInPath(path))).toEqual({ kind: "sign-in", returnTo: path })
    for (const query of ["mode=ask", "mode=walk&n=100", "mode=walk&n=-1", "mode=walk&source=0", "mode=walk&source=100", "mode=read&view=unsafe", "mode=walk&mode=claims", "mode=%77alk", "goal=ask", "mode=walk&&n=2", "mode=walk&n=2?next=bad", "source=1&quote=private", "mode=walk#bad"]) {
      expect(safeReturnPath(`/documents/doc?${query}`)).toBe("/")
    }
  })

  it("restores choices, reader pages, and source selection without storing document text", () => {
    expect(guideRouteFromLocation("/documents/doc").mode).toBe("choices")
    expect(guideRouteFromLocation("/documents/doc?p=2").mode).toBe("read")
    const path = guideLocation("doc", { mode: "walk", n: 3, source: 2, view: "original" }, 4)
    expect(safeReturnPath(path)).toBe(path)
    expect(guideRouteFromLocation(path)).toEqual({ mode: "walk", n: 3, source: 2, node: null, view: "original", goal: null })
    const pending = guideLocation("doc", { mode: "choices", goal: "claims" })
    expect(guideRouteFromLocation(pending)).toEqual({ mode: "choices", goal: "claims", n: 1, source: null, node: null, view: "text" })
  })

  it("retains a bounded paper-map node and source through sign-in", () => {
    const path = guideLocation("doc", { mode: "map", goal: "map", node: 12, source: 1 }, 3)
    expect(path).toBe("/documents/doc?mode=map&goal=map&node=12&source=1&p=3")
    expect(safeReturnPath(path)).toBe(path)
    expect(routeFromLocation(signInPath(path))).toEqual({ kind: "sign-in", returnTo: path })
    expect(guideRouteFromLocation(path)).toEqual({ mode: "map", goal: "map", n: 1, source: 1, node: 12, view: "text" })
    expect(guideLocation("doc", { mode: "walk", node: 4 })).toBe("/documents/doc?mode=walk&n=1")
    expect(guideLocation("doc", { mode: "map", node: 5000 })).toBe("/documents/doc?mode=map&node=999")
    for (const query of ["mode=map&node=0", "mode=map&node=1000", "mode=map&node=01", "mode=map&node=-1", "mode=map&node=1&node=2", "mode=map&node=%31", "goal=graph"]) {
      expect(safeReturnPath(`/documents/doc?${query}`)).toBe("/")
    }
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
