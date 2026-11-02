import type { AnchorHTMLAttributes, MouseEvent } from "react"
import { navigate } from "./client/browser.ts"

export const isPlainLeftClick = (event: MouseEvent<HTMLAnchorElement>): boolean =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

export const followInternalLink = (event: MouseEvent<HTMLAnchorElement>, path: string): void => {
  if (!isPlainLeftClick(event)) return
  event.preventDefault()
  navigate(path)
}

type InternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick"> & { readonly href: string }

export function InternalLink({ href, ...props }: InternalLinkProps) {
  return <a {...props} href={href} onClick={(event) => followInternalLink(event, href)} />
}
