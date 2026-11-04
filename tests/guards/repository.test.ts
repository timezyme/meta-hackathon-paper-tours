import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Agent } from "@mastra/core/agent"
import { createScorer } from "@mastra/core/evals"
import { registerApiRoute } from "@mastra/core/server"
import { createTool } from "@mastra/core/tools"
import { createStep, createWorkflow } from "@mastra/core/workflows"
import { Effect, FileSystem, Path, Schema } from "effect"
import { z } from "zod"
import { inspectRepository, missingRules, PackageManifest, registrationIds } from "../../scripts/guards/repository.ts"
import { publicExport } from "../../scripts/guards/oxlint-plugin.ts"
import { makeAmuseMe } from "../../src/mastra/amuseme.ts"
import { fixtureTree, runCommand } from "./support.ts"

const registrationFixture = () => {
  const shape = z.object({ value: z.string() })
  const tool = createTool({ id: "guard-tool", description: "Guard fixture", inputSchema: shape, outputSchema: shape, execute: (input) => Effect.runPromise(Effect.succeed(input)) })
  const agentTool = createTool({ id: "guard-agent-tool", description: "Guard fixture", inputSchema: shape, outputSchema: shape, execute: (input) => Effect.runPromise(Effect.succeed(input)) })
  const agent = new Agent({ id: "guard-agent", name: "Guard fixture", instructions: "Never invoked", model: "meta/muse-spark-1.3", tools: { agentTool } })
  const step = createStep({ id: "guard-step", inputSchema: shape, outputSchema: shape, execute: ({ inputData }) => Effect.runPromise(Effect.succeed(inputData)) })
  const workflow = createWorkflow({ id: "guard-workflow", inputSchema: shape, outputSchema: shape }).then(step).commit()
  const scorer = createScorer({ id: "guard-scorer", description: "Guard fixture" }).generateScore(() => 1)
  return { ...makeAmuseMe(4180), agents: { agent }, workflows: { workflow }, tools: { tool }, scorers: { scorer } }
}

describe("repository guards", () => {
  it.effect("checks the real pins and actual makeAmuseMe rule coverage", () => Effect.gen(function* () {
    assert.deepStrictEqual(yield* inspectRepository("."), [])
    assert.include(yield* registrationIds(makeAmuseMe(4180)), "route:GET:/")
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("finds a newly registered route without a rule", () => Effect.gen(function* () {
    const configuration = makeAmuseMe(4180)
    const ids = yield* registrationIds({ ...configuration, server: { ...configuration.server, apiRoutes: [
      ...(configuration.server?.apiRoutes ?? []),
      registerApiRoute("/guard-fixture", { method: "GET", handler: () => new Response("fixture") }),
    ] } })
    assert.include(missingRules(ids, ["Covers: route:GET:/, route:GET:/app/assets/:filename"]), "workflow-rules: missing rules for route:GET:/guard-fixture")
    assert.deepStrictEqual(missingRules(ids, [`Covers: ${ids.join(", ")}`]), [])
  }))

  it.effect("requires rules for the actual outer gateway as well as Mastra routes", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const ids = yield* registrationIds(makeAmuseMe(4180))
    const directory = yield* fixtureTree({
      "package.json": yield* fs.readFileString("package.json"),
      ".node-version": yield* fs.readFileString(".node-version"),
      "docs/step-rules/app.md": `Covers: ${ids.join(", ")}`,
    })
    const problems = yield* inspectRepository(directory)
    assert.include(problems, "workflow-rules: missing rules for route:GET:/api/session")
    assert.include(problems, "workflow-rules: missing rules for route:POST:/auth/sign-in/email")
    yield* fs.writeFileString(`${directory}/docs/step-rules/http.md`, yield* fs.readFileString("docs/step-rules/http-access.md"))
    assert.include(yield* inspectRepository(directory), "workflow-rules: missing rules for route:GET:/admin/api/agents")
    yield* fs.writeFileString(`${directory}/docs/step-rules/studio.md`, yield* fs.readFileString("docs/step-rules/studio-inspection.md"))
    assert.deepStrictEqual(yield* inspectRepository(directory), [])
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("discovers registered agents, agent tools, tools, scorers, workflows, and their real steps", () => Effect.gen(function* () {
    const ids = yield* registrationIds(registrationFixture())
    for (const id of ["agent:guard-agent", "tool:guard-tool", "tool:guard-agent-tool", "workflow:guard-workflow", "step:guard-step", "scorer:guard-scorer"]) {
      assert.include(ids, id)
      assert.include(missingRules(ids, []), `workflow-rules: missing rules for ${id}`)
    }
    assert.deepStrictEqual(missingRules(ids, [`Covers: ${ids.join(", ")}`]), [])
  }))

  it.effect.each([
    { field: "dependency", expected: "exact-version" },
    { field: "manager", expected: "package-manager-pin" },
    { field: "runtime", expected: "node-runtime-pin" },
  ])("rejects loose $field pins through the real CLI", ({ field, expected }) => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest))(yield* fs.readFileString("package.json"))
    const changed = {
      ...manifest,
      ...(field === "dependency" ? { dependencies: { ...manifest.dependencies, effect: "^4.0.3" } } : {}),
      ...(field === "manager" ? { packageManager: "pnpm@latest" } : {}),
      ...(field === "runtime" ? { devEngines: { runtime: { name: "node", version: ">=24" } } } : {}),
    }
    const root = yield* fixtureTree({ "package.json": JSON.stringify(changed), ".node-version": manifest.devEngines.runtime.version })
    const result = yield* runCommand(process.execPath, [path.resolve("scripts/guards/check.ts"), root, "--package-only"])
    assert.notStrictEqual(result.code, 0, result.output)
    assert.include(result.output, expected)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 30_000)

  it("honors blocked exports including more-specific null wildcards", () => {
    assert.isTrue(publicExport({ ".": { import: "./index.js" }, "./*": "./dist/*.js" }, "./agent", false))
    assert.isFalse(publicExport({ "./*": "./dist/*.js", "./private": null }, "./private", false))
    assert.isFalse(publicExport({ "./*": "./dist/*.js", "./internal/*": null }, "./internal/secret", false))
    assert.isFalse(publicExport(undefined, "./private.js", true))
  })
})
