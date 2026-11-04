import { NodeServices } from "@effect/platform-node"
import { expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { makeSourceFiles } from "../../src/storage/files.ts"

it.effect("preserves an existing source when an exclusive directory write collides", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-source-collision-" })
  const files = yield* makeSourceFiles(directory, 1024)
  const original = new Uint8Array([10, 20, 30])
  yield* files.write("existing-document", original)
  expect((yield* files.write("existing-document", new Uint8Array([40, 50, 60])).pipe(Effect.flip)).code).toBe("storage-failed")
  expect(Array.from(yield* fs.readFile(path.join(directory, "documents", "existing-document", "source.pdf")))).toEqual(Array.from(original))
}).pipe(Effect.provide(NodeServices.layer)))
