import { DocumentMarkup } from "../reader/ReaderBlock.tsx"
import { displayQuote } from "./presentation.ts"

const hasMath = (text: string): boolean => /\$[^$\s][^$]*\$|\\\(|\\\[/u.test(text)
const padding = /^(\s*)([\s\S]*?)(\s*)$/u

export function MathText({ text }: { readonly text: string }) {
  if (!hasMath(text)) return text
  const [, before = "", body = text, after = ""] = padding.exec(text) ?? []
  return <>{before}<DocumentMarkup content={body} inline />{after}</>
}

export function QuoteText({ quote }: { readonly quote: string }) {
  return <MathText text={displayQuote(quote)} />
}
