import type { Config } from "@mastra/core/mastra"
import type { StepWithComponent } from "@mastra/core/workflows"
import { Effect, FileSystem, Path, Schema } from "effect"
import { makeAmuseMe } from "../../src/mastra/amuseme.ts"
import { gatewayRouteIds } from "../../src/server/access.ts"

const Versions = Schema.Record(Schema.String, Schema.String)
export const PackageManifest = Schema.Struct({
  dependencies: Schema.optional(Versions),
  devDependencies: Schema.optional(Versions),
  optionalDependencies: Schema.optional(Versions),
  peerDependencies: Schema.optional(Versions),
  packageManager: Schema.String,
  devEngines: Schema.Struct({ runtime: Schema.Struct({ name: Schema.Literal("node"), version: Schema.String }) }),
})
const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u
const managerPin = /^pnpm@\d+\.\d+\.\d+(?:\+sha512\.[a-f0-9]+)?$/u

export const packageProblems = (manifest: typeof PackageManifest.Type, nodeVersion: string): string[] => {
  const problems: string[] = []
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (!exactVersion.test(version)) problems.push(`exact-version: ${section}.${name} must use an exact version, received ${version}`)
    }
  }
  if (!managerPin.test(manifest.packageManager)) problems.push("package-manager-pin: packageManager must pin pnpm exactly")
  if (!exactVersion.test(manifest.devEngines.runtime.version) || nodeVersion.trim() !== manifest.devEngines.runtime.version) problems.push("node-runtime-pin: devEngines.runtime.version and .node-version must be the same exact version")
  return problems
}

export class RegistrationInspectionError extends Schema.TaggedError<RegistrationInspectionError>()("RegistrationInspectionError", { cause: Schema.Defect() }) {}

const stepIds = (steps: Record<string, StepWithComponent>): string[] => Object.values(steps).flatMap((step) => [
  `step:${step.id}`,
  ...stepIds(step.steps ?? {}),
])

export const registrationIds = Effect.fnUntraced(function* (configuration: Config) {
  const ids = new Set<string>()
  for (const agent of Object.values(configuration.agents ?? {})) {
    ids.add(`agent:${agent.id}`)
    if (!("listTools" in agent)) return yield* new RegistrationInspectionError({ cause: `Cannot inspect tools for agent ${agent.id}` })
    const toolResponse = yield* Effect.tryPromise({
      try: () => agent.listTools({ resolveWebSearch: false }),
      catch: (cause) => new RegistrationInspectionError({ cause }),
    })
    const tools = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Struct({ id: Schema.String })))(toolResponse)
    for (const tool of Object.values(tools)) ids.add(`tool:${tool.id}`)
  }
  for (const workflow of Object.values(configuration.workflows ?? {})) {
    ids.add(`workflow:${workflow.id}`)
    for (const id of stepIds(workflow.steps)) ids.add(id)
  }
  for (const tool of Object.values(configuration.tools ?? {})) ids.add(`tool:${tool.id}`)
  for (const scorer of Object.values(configuration.scorers ?? {})) ids.add(`scorer:${scorer.id}`)
  for (const route of configuration.server?.apiRoutes ?? []) {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const method of methods) ids.add(`route:${method}:${route.path}`)
  }
  return [...ids].toSorted()
})

export const missingRules = (ids: readonly string[], documents: readonly string[]): string[] => {
  const covered = new Set(documents.flatMap((text) => [...text.matchAll(/^Covers:\s*(.+)$/gmu)].flatMap((match) => (match[1] ?? "").split(/,\s*/u))))
  return ids.filter((id) => !covered.has(id)).map((id) => `workflow-rules: missing rules for ${id}`)
}

export const inspectRepository = Effect.fnUntraced(function* (directory: string, packageOnly = false) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest))(yield* fs.readFileString(path.join(directory, "package.json")))
  const problems = packageProblems(manifest, yield* fs.readFileString(path.join(directory, ".node-version")))
  if (packageOnly) return problems
  const rulesDirectory = path.join(directory, "docs/step-rules")
  const documents = yield* Effect.forEach((yield* fs.readDirectory(rulesDirectory)).filter((file) => file.endsWith(".md")), (file) => fs.readFileString(path.join(rulesDirectory, file)))
  const ids = [...yield* registrationIds(makeAmuseMe(4180)), ...gatewayRouteIds]
  return [...problems, ...missingRules(ids, documents)]
})
