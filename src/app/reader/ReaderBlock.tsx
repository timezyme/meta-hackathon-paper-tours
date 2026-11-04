import { createElement, useState } from "react"
import Markdown from "react-markdown"
import type { Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"
import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"
import rehypeKatex from "rehype-katex"
import type { Block, CanonicalDocument, Figure } from "../../domain/index.ts"
import { imageUrl, type OutputIdentity } from "../client/outputs.ts"
import { normalizeMathDelimiters, tableMath } from "./math.ts"
import { safeDocumentHref } from "./presentation.ts"
import { boldSpans } from "../text.ts"
import "katex/dist/katex.min.css"

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: defaultSchema.tagNames?.filter((tag) => !["img", "input", "style", "script", "iframe", "video", "audio", "source"].includes(tag)),
  attributes: { ...defaultSchema.attributes, code: [["className", /^language-/u, "math-inline", "math-display"]], td: [...(defaultSchema.attributes?.td ?? []), "colSpan", "rowSpan"], th: [...(defaultSchema.attributes?.th ?? []), "colSpan", "rowSpan"] },
}
const SafeLink: NonNullable<Components["a"]> = ({ href, children }) => href === undefined || href === "" ? <span>{children}</span> : <a href={href} rel="noreferrer">{children}</a>
const InlineParagraph: NonNullable<Components["p"]> = ({ children }) => <>{children}</>
const ScrollTable: NonNullable<Components["table"]> = ({ children }) => <div className="reader-table" tabIndex={0} role="region" aria-label="Document table"><table>{children}</table></div>
const components: Components = { a: SafeLink, table: ScrollTable }
const inlineComponents: Components = { ...components, p: InlineParagraph }

export function DocumentMarkup({ content, inline = false }: { readonly content: string; readonly inline?: boolean }) {
  return <Markdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeRaw, tableMath, [rehypeSanitize, sanitizeSchema], [rehypeKatex, { trust: false, strict: "ignore", maxExpand: 1000, maxSize: 50 }]]} urlTransform={(url) => safeDocumentHref(url) ?? ""} components={inline ? inlineComponents : components}>{normalizeMathDelimiters(content)}</Markdown>
}

function DocumentFigure({ figure, identity }: { readonly figure: Figure; readonly identity: OutputIdentity }) {
  const [failed, setFailed] = useState(false)
  return <figure className="reader-figure" id={`figure-${figure.id}`}>{figure.asset._tag === "available" && !failed ? <img src={imageUrl(identity, figure.id)} alt={figure.originalCaption || `Document figure ${figure.id}`} loading="lazy" onError={() => setFailed(true)} /> : <div className="reader-missing-figure" role="status">Image unavailable. {figure.asset._tag === "unavailable" ? figure.asset.reason : "The saved image could not be loaded."}</div>}<figcaption>{figure.originalCaption !== "" && <DocumentMarkup content={figure.originalCaption} />}{figure.description._tag === "generated" ? <><span className="reader-figure-label">AI-WRITTEN DESCRIPTION</span><p>{figure.description.text}</p></> : <p className="reader-small">Description unavailable.{figure.description._tag === "unavailable" ? ` ${figure.description.reason}` : " No saved description is available."}</p>}</figcaption></figure>
}

function PlainText({ text }: { readonly text: string }) {
  return <>{boldSpans(text).map((span, index) => span.bold ? <strong key={index}>{span.text}</strong> : span.text)}</>
}

export function ReaderBlock({ block, canonical, identity }: { readonly block: Block; readonly canonical: CanonicalDocument; readonly identity: OutputIdentity }) {
  const figures = canonical.figures.filter((figure) => figure.sourceBlockIds.some((id) => block.sourceBlockIds.includes(id)) && canonical.blocks.find((candidate) => figure.sourceBlockIds.some((id) => candidate.sourceBlockIds.includes(id)))?.id === block.id)
  const repeatedCaption = block.kind === "caption" && canonical.figures.some((figure) => figure.originalCaption === block.content && figure.locations[0].pageId === block.locations[0].pageId && figure.captionBlockIds.some((id) => block.sourceBlockIds.includes(id)))
  const content = repeatedCaption ? "" : block.kind === "heading" ? block.content.replace(/^#{1,6}\s+/u, "") : block.kind === "equation" && block.format !== "text" && !/^\s*(?:\$\$|\\\[)/u.test(block.content) ? `$$\n${block.content}\n$$` : block.content
  return <section className={`reader-block reader-kind-${block.kind}${block.kind === "equation" ? " reader-equation" : ""}`} id={`block-${block.id}`}>
    {content !== "" && (block.kind === "heading" ? createElement(`h${block.headingLevel ?? 2}`, { className: block.format === "text" ? "reader-plain-text" : undefined }, block.format === "text" ? <PlainText text={content} /> : <DocumentMarkup content={content} inline />) : block.format === "text" ? <p className="reader-plain-text"><PlainText text={content} /></p> : <DocumentMarkup content={content} />)}
    {figures.map((figure) => <DocumentFigure key={figure.id} figure={figure} identity={identity} />)}
  </section>
}
