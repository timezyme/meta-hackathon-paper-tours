import { Effect, FileSystem, Path, Schema } from "effect"

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

export const inspectRepository = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest))(yield* fs.readFileString(path.join(directory, "package.json")))
  return packageProblems(manifest, yield* fs.readFileString(path.join(directory, ".node-version")))
})
