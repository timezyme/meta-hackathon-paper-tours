import type { ReactNode } from "react"

type GlyphTextProps = { readonly before?: string; readonly after?: string; readonly children: ReactNode }

export function GlyphText({ before, after, children }: GlyphTextProps) {
  return <span>
    {before !== undefined && <><span aria-hidden="true">{before}</span> </>}
    {children}
    {after !== undefined && <> <span aria-hidden="true">{after}</span></>}
  </span>
}
