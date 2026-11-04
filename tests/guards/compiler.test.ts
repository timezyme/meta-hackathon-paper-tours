import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Path } from "effect"
import { fixtureTree, runCommand } from "./support.ts"

const prohibited = [
  { name: "asyncFunction", diagnostic: "377081", source: "export const bad = async () => 1" },
  { name: "globalFetch", diagnostic: "377061", source: 'export const bad = () => fetch("https://example.test")' },
  { name: "globalFetchInEffect", diagnostic: "377063", source: 'import { Effect } from "effect"; export const bad = Effect.gen(function* () { return fetch("https://example.test") })' },
  { name: "floatingEffect", diagnostic: "377001|377058", source: 'import { Effect } from "effect"; export const bad = Effect.gen(function* () { Effect.succeed(1); return 2 })' },
  { name: "missingEffectContext", diagnostic: "377004", source: 'import { Context, Effect } from "effect"; class Port extends Context.Service<Port, { value: number }>()("Port") {}\nexport const bad: Effect.Effect<number> = Effect.gen(function* () { const port = yield* Port; return port.value })' },
  { name: "newPromise", diagnostic: "377080", source: 'export const bad = () => new Promise<number>((resolve) => resolve(1))' },
  { name: "floatingEffectInVitest", diagnostic: "377105", source: 'import { it } from "vitest"; import { Effect } from "effect"; it("bad", () => Effect.succeed(1))' },
] as const

const valid = `import { Context, Effect, Schema } from "effect"
import { it, assert } from "@effect/vitest"
class Port extends Context.Service<Port, { value: number }>()("Port") {}
class AdapterError extends Schema.TaggedError<AdapterError>()("AdapterError", { cause: Schema.Defect() }) {}
declare const sdk: (signal: AbortSignal) => Promise<string>
export const adapter = Effect.tryPromise({ try: (signal) => sdk(signal), catch: (cause) => new AdapterError({ cause }) })
export const boundary = (request: Request) => Effect.runPromise(adapter, { signal: request.signal })
export const provided = Effect.gen(function* () { const port = yield* Port; return port.value }).pipe(Effect.provideService(Port, { value: 1 }))
it.effect("effect-aware", () => Effect.gen(function* () { assert.strictEqual(yield* provided, 1) }))
export const pure = (value: number) => value * 2
`

const compile = Effect.fnUntraced(function* (project: "server" | "browser", source: string) {
  const path = yield* Path.Path
  const filename = project === "browser" ? "src/app/case.test.tsx" : "src/case.test.ts"
  const root = yield* fixtureTree({
    [filename]: source,
    "tsconfig.json": JSON.stringify({ extends: path.resolve(project === "server" ? "tsconfig.json" : "src/app/tsconfig.json"), include: [`./${filename}`], exclude: [] }),
  })
  return yield* runCommand(process.execPath, [path.resolve("node_modules/typescript/bin/tsc"), "-p", path.join(root, "tsconfig.json"), "--pretty", "false"], root)
})

describe.each(["server", "browser"] as const)("%s compiler guard", (project) => {
  it.effect.each(prohibited)("rejects $name with its Effect diagnostic", ({ source, diagnostic }) => Effect.gen(function* () {
    const result = yield* compile(project, source)
    assert.notStrictEqual(result.code, 0, result.output)
    assert.match(result.output, new RegExp(`error TS(?:${diagnostic}):`, "u"))
    assert.notMatch(result.output, /Cannot find module|Cannot read|not found|Unknown compiler option/u)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 30_000)

  it.effect("accepts SDK adapter, cancellation boundary, provided service, and Effect-aware tests", () => Effect.gen(function* () {
    const source = project === "browser" ? `${valid}\nexport const View = () => <main>Ready</main>\n` : valid
    const result = yield* compile(project, source)
    assert.strictEqual(result.code, 0, result.output)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 30_000)
})
