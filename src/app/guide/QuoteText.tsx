import { DocumentMarkup } from "../reader/ReaderBlock.tsx"
import { displayQuote } from "./presentation.ts"

import { escapeCurrency } from "../reader/math.ts"

const hasMath = (text: string): boolean => /\$[^$\s][^$]*\$|\\\(|\\\[/u.test(text)
const padding = /^(\s*)([\s\S]*?)(\s*)$/u

export function MathText({ text }: { readonly text: string }) {
  const escaped = escapeCurrency(text)
  if (!hasMath(escaped.replace(/\\\$/gu, ""))) return text
  const [, before = "", body = escaped, after = ""] = padding.exec(escaped) ?? []
  return <>{before}<DocumentMarkup content={body} inline />{after}</>
}

export function QuoteText({ quote }: { readonly quote: string }) {
  return <MathText text={displayQuote(quote)} />
}
