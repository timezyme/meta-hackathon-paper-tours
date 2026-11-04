import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Path, Schema } from "effect"
import { inspectRepository, PackageManifest } from "../../scripts/guards/repository.ts"
import { publicExport } from "../../scripts/guards/oxlint-plugin.ts"
import { fixtureTree, runCommand } from "./support.ts"

describe("repository guards", () => {
  it.effect("checks the real pins", () => Effect.gen(function* () {
    assert.deepStrictEqual(yield* inspectRepository("."), [])
  }).pipe(Effect.provide(NodeServices.layer)))

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
    const result = yield* runCommand(process.execPath, [path.resolve("scripts/guards/check.ts"), root])
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
