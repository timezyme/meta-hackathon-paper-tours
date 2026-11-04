import { Schema } from "effect"
import { DocumentId } from "../domain/index.ts"

const ReturnPath = Schema.String.check(Schema.isPattern(/^(?:\/|\/documents\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?:\?p=[1-9][0-9]{0,8})?)$/))

export const safeReturnPath = (value: string | null): string => Schema.is(ReturnPath)(value) ? value : "/"

export type AppRoute =
  | { readonly kind: "dashboard" }
  | { readonly kind: "sign-in"; readonly returnTo: string }
  | { readonly kind: "document"; readonly documentId: DocumentId }
  | { readonly kind: "admin-denied" }
  | { readonly kind: "not-found" }

export const routeFromLocation = (location: string): AppRoute => {
  const [pathname, search = ""] = location.split("?")
  if (pathname === "/") return { kind: "dashboard" }
  if (pathname === "/sign-in") return { kind: "sign-in", returnTo: safeReturnPath(new URLSearchParams(search).get("returnTo")) }
  if (pathname === "/admin" || pathname?.startsWith("/admin/")) return { kind: "admin-denied" }
  const documentId = pathname?.startsWith("/documents/") ? pathname.slice("/documents/".length) : undefined
  if (Schema.is(DocumentId)(documentId)) return { kind: "document", documentId }
  return { kind: "not-found" }
}

export const signInPath = (path: string): string => {
  const returnTo = safeReturnPath(path)
  return returnTo === "/" ? "/sign-in" : `/sign-in?returnTo=${encodeURIComponent(returnTo)}`
}
