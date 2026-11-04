import { describe, expect, it } from "@effect/vitest"
import { Mastra } from "@mastra/core/mastra"
import { ConfigProvider, Effect, Fiber, FileSystem, PlatformError, Ref, Result } from "effect"
import { TestClock } from "effect/testing"
import { makeAmuseMe, serverPort } from "../../src/mastra/amuseme.ts"
import { readAppFile } from "../../src/mastra/app-shell.ts"

describe("application foundation", () => {
  it.effect("registers the shell and unmodified Studio on loopback", () => Effect.gen(function* () {
    const mastra = new Mastra(makeAmuseMe(4180))
    expect(mastra.getServer()).toMatchObject({ host: "127.0.0.1", port: 4180, studioBase: "/admin" })
    expect(mastra.getServer()?.apiRoutes?.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /", "GET /sign-in", "GET /documents/:documentId", "GET /app/assets/:filename",
      "POST /api/documents", "GET /api/documents", "GET /api/documents/:documentId",
      "GET /api/documents/:documentId/status", "GET /api/documents/:documentId/original", "GET /api/documents/:documentId/preview", "POST /api/documents/:documentId/retry", "DELETE /api/documents/:documentId",
      "GET /api/documents/:documentId/outputs/:revisionId/document", "GET /api/documents/:documentId/outputs/:revisionId/text", "GET /api/documents/:documentId/outputs/:revisionId/zip",
      "GET /api/documents/:documentId/outputs/:revisionId/images/:figureId", "GET /api/documents/:documentId/outputs/:revisionId/report",
      "GET /api/documents/:documentId/outputs/:revisionId/rating", "PUT /api/documents/:documentId/outputs/:revisionId/rating", "DELETE /api/documents/:documentId/outputs/:revisionId/rating",
    ])
    expect(Object.keys(mastra.listAgents()).toSorted()).toEqual(["extraction", "extraction-review", "figures", "figures-crop-review", "figures-review", "guide", "guide-review", "headings", "headings-review", "page-check", "page-check-review"])
    expect(Object.keys(mastra.listWorkflows())).toEqual(["normalize-document"])
    yield* Effect.promise(() => mastra.shutdown())
  }))

  it.effect("defaults the port and rejects invalid configuration", () => Effect.gen(function* () {
    expect(yield* serverPort.parse(ConfigProvider.fromUnknown({}))).toBe(4180)
    expect(yield* serverPort.parse(ConfigProvider.fromUnknown({ AMUSEME_PORT: "4182" }))).toBe(4182)
    for (const value of ["80", "65536", "4180.5", "not-a-port"]) {
      const result = yield* Effect.result(serverPort.parse(ConfigProvider.fromUnknown({ AMUSEME_PORT: value })))
      expect(Result.isFailure(result)).toBe(true)
    }
  }))

  it.effect("serves the built index with its content type", () => Effect.gen(function* () {
    const response = yield* readAppFile("test-app", undefined).pipe(Effect.provide(FileSystem.layerNoop({
      readFile: (path) => {
        expect(path).toBe("test-app/index.html")
        return Effect.succeed(new TextEncoder().encode("<title>AmuseMe</title>"))
      },
    })))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(yield* Effect.promise(() => response.text())).toBe("<title>AmuseMe</title>")
  }))

  it.effect("serves validated assets and rejects traversal before reading", () => Effect.gen(function* () {
    const readPaths: string[] = []
    const files = FileSystem.layerNoop({
      readFile: (path) => {
        readPaths.push(path)
        return Effect.succeed(new TextEncoder().encode("body{}"))
      },
    })
    const css = yield* readAppFile("test-app", "index-abc123.css").pipe(Effect.provide(files))
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8")
    const javascript = yield* readAppFile("test-app", "index-abc123.js").pipe(Effect.provide(files))
    expect(javascript.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    for (const filename of ["../private.js", "%2e%2e%2fprivate.js", "secret.env", "/absolute.js", "nested/file.js"]) {
      const response = yield* readAppFile("test-app", filename).pipe(Effect.provide(files))
      expect(response.status).toBe(404)
    }
    expect(readPaths).toEqual(["test-app/assets/index-abc123.css", "test-app/assets/index-abc123.js"])
  }))

  it.effect("distinguishes missing assets from a missing build and read failures", () => Effect.gen(function* () {
    const missingFiles = FileSystem.layerNoop({
      readFile: () => Effect.fail(new PlatformError.PlatformError(new PlatformError.SystemError({
        _tag: "NotFound", module: "FileSystem", method: "readFile",
      }))),
    })
    expect((yield* readAppFile("test-app", undefined).pipe(Effect.provide(missingFiles))).status).toBe(503)
    expect((yield* readAppFile("test-app", "missing.js").pipe(Effect.provide(missingFiles))).status).toBe(404)
    const inaccessibleFiles = FileSystem.layerNoop({
      readFile: () => Effect.fail(new PlatformError.PlatformError(new PlatformError.SystemError({
        _tag: "PermissionDenied", module: "FileSystem", method: "readFile",
      }))),
    })
    expect((yield* readAppFile("test-app", undefined).pipe(Effect.provide(inaccessibleFiles))).status).toBe(500)
  }))

  it.effect("interrupts a stalled read at its deadline", () => Effect.gen(function* () {
    const interrupted = yield* Ref.make(false)
    const fiber = yield* readAppFile("test-app", undefined).pipe(
      Effect.provide(FileSystem.layerNoop({
        readFile: () => Effect.never.pipe(Effect.ensuring(Ref.set(interrupted, true))),
      })),
      Effect.forkChild,
    )
    yield* TestClock.adjust("5 seconds")
    expect((yield* Fiber.join(fiber)).status).toBe(503)
    expect(yield* Ref.get(interrupted)).toBe(true)
  }))
})
