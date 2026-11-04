import { Effect, FileSystem, Path, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export const runCommand = Effect.fnUntraced(function* (command: string, args: readonly string[], cwd?: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(ChildProcess.make(command, args, cwd === undefined ? {} : { cwd }))
  const output = yield* handle.all.pipe(Stream.decodeText(), Stream.runFold(() => "", (all, part) => all + part))
  const code = yield* handle.exitCode
  return { code, output }
}, Effect.scoped)

export const fixtureTree = Effect.fnUntraced(function* (files: Readonly<Record<string, string>>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-guard-" })
  const root = yield* fs.realPath(temporary)
  yield* fs.symlink(path.resolve("node_modules"), path.join(root, "node_modules"))
  yield* fs.writeFileString(path.join(root, "package.json"), '{"type":"module"}')
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, name)
    yield* fs.makeDirectory(path.dirname(file), { recursive: true })
    yield* fs.writeFileString(file, source)
  }
  return root
})
