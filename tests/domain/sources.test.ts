import { NodeServices } from "@effect/platform-node"
import { it } from "@effect/vitest"
import { Crypto, Effect, FileSystem } from "effect"
import { expect } from "vitest"
import sources from "../fixtures/sources.json" with { type: "json" }

it.effect("keeps synthetic source bytes tied to their recorded source hashes", () => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const crypto = yield* Crypto.Crypto
  for (const [name, metadata] of Object.entries(sources)) {
    const bytes = yield* fs.readFile(new URL(`../fixtures/${name}.pdf`, import.meta.url).pathname)
    expect(bytes.byteLength).toBe(metadata.byteCount)
    const hash = yield* crypto.digest("SHA-256", bytes)
    expect(Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(metadata.sha256)
    expect(new TextDecoder().decode(bytes.subarray(0, 8))).toBe("%PDF-1.4")
  }
}).pipe(Effect.provide(NodeServices.layer)))
