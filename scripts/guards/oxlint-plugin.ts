// @effect-diagnostics-next-line nodeBuiltinImport:off -- Oxlint rule callbacks synchronously inspect installed package export maps.
import { existsSync, readFileSync } from "node:fs"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Resolve import boundaries inside Oxlint's synchronous rule callback.
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { Predicate, Schema } from "effect"

interface Location { readonly start: { readonly line: number; readonly column: number }; readonly end: { readonly line: number; readonly column: number } }
interface Comment { readonly type: string; readonly value: string; readonly loc: Location }
interface SyntaxNode {
  readonly type: string
  readonly value?: unknown
  readonly name?: string
  readonly source?: SyntaxNode | null
  readonly specifiers?: readonly SyntaxNode[]
  readonly imported?: SyntaxNode
  readonly local?: SyntaxNode
  readonly callee?: SyntaxNode
  readonly object?: SyntaxNode
  readonly property?: SyntaxNode
  readonly arguments?: readonly SyntaxNode[]
  readonly quasis?: readonly { readonly value: { readonly cooked: string | null } }[]
  readonly loc: Location
}
interface RuleContext {
  readonly filename: string
  readonly cwd: string
  readonly sourceCode: { getAllComments(): readonly Comment[] }
  report(descriptor: { readonly message: string; readonly loc: Location }): void
}

const PackageMetadata = Schema.Struct({ exports: Schema.optional(Schema.Unknown), main: Schema.optional(Schema.String) })
const browserPackages = new Set(["react", "react-dom", "effect", "@tanstack/react-query", "@mastra/client-js", "lucide-react", "react-markdown", "remark-gfm", "remark-math", "rehype-raw", "rehype-sanitize", "rehype-katex", "katex"])
const browserTestPackages = new Set(["vitest", "@effect/vitest"])
const domainPackages = new Set(["effect", "zod"])
const providerAdapters = new Map([
  ["src/paper/providers/meta/transport.ts", new Set(["@ai-sdk/provider"])],
  ["src/paper/providers/mineru/transport.ts", new Set(["@mineru/client"])],
])
const providerPackage = /^(?:@ai-sdk\/|openai(?:\/|$)|@anthropic-ai\/|@mistralai\/|@azure\/openai|@meta-ai\/|@mineru\/|mineru(?:\/|$))/u
const providerDestination = /(?:api\.(?:meta\.ai|llama\.com|openai\.com|mistral\.ai)|https?:\/\/[a-z0-9.-]*mineru[a-z0-9.-]*(?=[:/]|$)|\/chat\/completions|\/openai\/(?:v1\/)?responses)/iu
const transportModule = /^(?:effect\/http\/(?:FetchHttpClient|HttpClient|HttpClientRequest)|@mastra\/client-js|axios|ky|undici)(?:\/|$)/u
const directive = /^(?:oxlint-(?:disable|enable)(?:-next-line|-line)?\s.+\s--\s\S|@effect-diagnostics(?:-next-line)?\s.+\s--\s\S|@ts-expect-error\s--\s\S)/u
const typeJsdoc = /^\*\s*@(?:type|typedef|template|param|returns|satisfies|import)\b/u

export const allowedComment = (comment: Comment): boolean => {
  const text = comment.value.replace(/^\*?\s*/u, "").trim()
  if (/(?:@license\b|SPDX-License-Identifier:|Copyright\s+\d{4})/u.test(text)) return true
  if (comment.type === "Block" && typeJsdoc.test(comment.value)) return true
  return comment.type === "Line" && (directive.test(text) || /^SAFETY:\s*\S/u.test(text))
}

const packageName = (specifier: string) => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0] ?? ""
const within = (file: string, directory: string) => file === directory || file.startsWith(`${directory}/`)
const targetStrings = (target: unknown): string[] => {
  if (typeof target === "string") return [target]
  if (Array.isArray(target)) return target.flatMap(targetStrings)
  return Predicate.isObject(target) ? Object.values(target).flatMap(targetStrings) : []
}

const exportTargets = (exports: unknown, subpath: string, main?: string): string[] => {
  if (exports === undefined) return subpath === "." && main ? [main] : []
  if (typeof exports === "string" || Array.isArray(exports)) return subpath === "." ? targetStrings(exports) : []
  if (!Predicate.isObject(exports)) return []
  const entries = Object.entries(exports)
  if (!entries.some(([key]) => key.startsWith("."))) return subpath === "." ? targetStrings(exports) : []
  const exact = entries.find(([key]) => key === subpath)
  if (exact) return targetStrings(exact[1])
  const patterns = entries.flatMap(([key, target]) => {
    const star = key.indexOf("*")
    if (star < 0) return []
    const prefix = key.slice(0, star)
    const suffix = key.slice(star + 1)
    const segment = subpath.slice(prefix.length, suffix ? -suffix.length : undefined)
    return subpath.startsWith(prefix) && subpath.endsWith(suffix) && segment.length > 0
      ? [{ prefix, suffix, segment, target }] : []
  }).toSorted((left, right) => right.prefix.length - left.prefix.length || right.suffix.length - left.suffix.length)
  const match = patterns[0]
  return match ? targetStrings(match.target).map((target) => target.replaceAll("*", match.segment)) : []
}

export const publicExport = (exports: unknown, subpath: string, hasMain: boolean): boolean =>
  exportTargets(exports, subpath, hasMain ? "./index.js" : undefined).length > 0

const importProblem = (file: string, specifier: string, cwd: string): string | undefined => {
  const browser = within(file, "src/app") || within(file, "tests/app")
  const domain = within(file, "src/domain")
  const adapter = within(file, "src/app/client") || within(file, "tests/app/client")
  if (specifier.startsWith(".")) {
    const target = relative(cwd, resolve(cwd, dirname(file), specifier)).replaceAll("\\", "/")
    if (browser && !within(target, "src/app") && !within(target, "src/domain") && !(within(file, "tests/app") && within(target, "tests/app"))) return "browser-import: browser code may import only app or domain files"
    if (domain && !within(target, "src/domain")) return "domain-import: domain contracts must not import adapters, server, or presentation code"
    if (!browser && !domain && within(target, "src/app")) return "server-import: server and tooling cannot import presentation code"
    return undefined
  }
  if (isAbsolute(specifier) || specifier.startsWith("#") || specifier.startsWith("src/") || specifier.startsWith("~/") || specifier.startsWith("@/")) return "unsupported-alias: use a relative import or installed public package export"
  if (specifier.split("/").some((part) => part === "." || part === "..")) return "public-import: package subpaths cannot traverse directories"
  const name = packageName(specifier)
  if (name === "@mastra/playground-ui" && /\/(?:domains|src|dist)\//u.test(specifier)) return "public-import: Studio implementation imports are not permitted"
  if (providerPackage.test(specifier) && !providerAdapters.get(file)?.has(name)) return "provider-boundary: provider SDKs belong only in the exact approved transport adapter"
  if (browser && !browserPackages.has(name) && !(within(file, "tests/app") && browserTestPackages.has(name))) return "browser-import: package is not an approved browser dependency"
  if (domain && !domainPackages.has(name)) return "domain-import: domain contracts may import only domain schema dependencies"
  if (browser && !adapter && (specifier === "effect/http" || transportModule.test(specifier))) return "presentation-transport: HTTP integration belongs in src/app/client/"
  if (specifier.startsWith("node:")) return undefined
  let metadata: typeof PackageMetadata.Type
  try {
    metadata = Schema.decodeUnknownSync(Schema.fromJsonString(PackageMetadata))(readFileSync(resolve(cwd, "node_modules", name, "package.json"), "utf8"))
  } catch {
    return "public-import: dependency has no readable installed package manifest"
  }
  const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`
  if (!exportTargets(metadata.exports, subpath, metadata.main).some((target) => existsSync(resolve(cwd, "node_modules", name, target)))) return "public-import: path is not a supported installed public package export"
  return undefined
}

export default {
  meta: { name: "amuseme" },
  rules: {
    boundaries: {
      create(context: RuleContext) {
        const file = relative(context.cwd, context.filename).replaceAll("\\", "/")
        const mastraConstructors = new Set(["Mastra"])
        const report = (node: SyntaxNode, message: string) => context.report({ loc: node.loc, message })
        const checkImport = (node: SyntaxNode) => {
          if (typeof node.value !== "string") { report(node, "computed-import: import and require paths must be string literals"); return }
          const problem = importProblem(file, node.value, context.cwd)
          if (problem) report(node, problem)
        }
        const checkSource = (node: SyntaxNode) => { if (node.source) checkImport(node.source) }
        const checkDestination = (node: SyntaxNode, value: string) => {
          if (providerDestination.test(value) && !providerAdapters.has(file) && file !== "tests/guards/lint.test.ts") report(node, "provider-boundary: direct Meta/MinerU/model endpoints belong only in approved transport adapters")
        }
        return {
          ImportDeclaration(node: SyntaxNode) {
            checkSource(node)
            if (node.source?.value === "@mastra/core/mastra") {
              for (const specifier of node.specifiers ?? []) {
                if (specifier.imported?.name === "Mastra" && specifier.local?.name) mastraConstructors.add(specifier.local.name)
              }
            }
          },
          ExportNamedDeclaration: checkSource,
          ExportAllDeclaration: checkSource,
          ImportExpression: checkSource,
          TSImportEqualsDeclaration(node: SyntaxNode) { report(node, "unsupported-import: use an ES module import with a public literal path") },
          CallExpression(node: SyntaxNode) {
            if (node.callee?.type === "Identifier" && node.callee.name === "require") {
              const argument = node.arguments?.[0]
              if (argument) checkImport(argument)
            }
            if ((within(file, "src/app") || within(file, "tests/app")) && !(within(file, "src/app/client") || within(file, "tests/app/client")) && node.callee?.type === "Identifier" && node.callee.name === "fetch") report(node, "presentation-transport: HTTP integration belongs in src/app/client/")
          },
          NewExpression(node: SyntaxNode) {
            if (within(file, "src") && file !== "src/mastra/index.ts" && (mastraConstructors.has(node.callee?.name ?? "") || node.callee?.property?.name === "Mastra")) report(node, "registration-composition: construct Mastra only in src/mastra/index.ts using makeAmuseMe")
            if ((within(file, "src/app") || within(file, "tests/app")) && !(within(file, "src/app/client") || within(file, "tests/app/client")) && ["XMLHttpRequest", "WebSocket", "EventSource"].includes(node.callee?.name ?? "")) report(node, "presentation-transport: network transports belong in src/app/client/")
          },
          Literal(node: SyntaxNode) { if (typeof node.value === "string") checkDestination(node, node.value) },
          TemplateLiteral(node: SyntaxNode) { for (const quasi of node.quasis ?? []) checkDestination(node, quasi.value.cooked ?? "") },
        }
      },
    },
    comments: {
      create(context: RuleContext) {
        return { Program() {
          for (const comment of context.sourceCode.getAllComments()) {
            if (!allowedComment(comment)) context.report({ loc: comment.loc, message: "comment-policy: use names/types/tests; only licenses, reasoned directives, SAFETY statements, and type JSDoc are allowed" })
          }
        } }
      },
    },
  },
}
