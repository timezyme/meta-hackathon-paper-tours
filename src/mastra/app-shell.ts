import { NodeFileSystem } from "@effect/platform-node"
import { registerApiRoute } from "@mastra/core/server"
import { Effect, FileSystem, Schema } from "effect"

const AssetFilename = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+\.(?:css|js|svg|woff2|png|ico)$/u))

const contentTypes: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  woff2: "font/woff2",
  png: "image/png",
  ico: "image/x-icon",
}

export const readAppFile = Effect.fnUntraced(function* (directory: string, filename?: string) {
  const asset = filename === undefined
    ? undefined
    : yield* Schema.decodeUnknownEffect(AssetFilename)(filename)
  const fs = yield* FileSystem.FileSystem
  const file = asset === undefined ? `${directory}/index.html` : `${directory}/assets/${asset}`
  const bytes = yield* fs.readFile(file)
  const contentType = asset === undefined
    ? "text/html; charset=utf-8"
    : contentTypes[asset.split(".").at(-1) ?? ""] ?? "application/octet-stream"
  return new Response(bytes, {
    headers: {
      "content-type": contentType,
      "x-content-type-options": "nosniff",
      "cache-control": asset === undefined ? "no-store" : "public, max-age=31536000, immutable",
    },
  })
},
Effect.timeout("5 seconds"),
(effect, _directory, filename) => effect.pipe(
  Effect.catchTag("SchemaError", () => Effect.succeed(new Response("Not found", { status: 404 }))),
  Effect.catchTag("PlatformError", (error) => {
    if (error.reason._tag === "NotFound") {
      return Effect.succeed(new Response(
        filename === undefined ? "Application unavailable. Rebuild the application." : "Not found",
        { status: filename === undefined ? 503 : 404 },
      ))
    }
    return Effect.logError("Application asset read failed", error).pipe(
      Effect.as(new Response("Application unavailable", { status: 500 })),
    )
  }),
  Effect.catchTag("TimeoutError", () => Effect.succeed(new Response("Application unavailable", { status: 503 }))),
))

export const appShellRoutes = (directory: string) => [
  ...["/", "/sign-in", "/documents/:documentId"].map((route) => registerApiRoute(route, {
    method: "GET",
    handler: (context) => Effect.runPromise(
      readAppFile(directory, undefined).pipe(Effect.provide(NodeFileSystem.layer)),
      { signal: context.req.raw.signal },
    ),
  })),
  registerApiRoute("/app/assets/:filename", {
    method: "GET",
    handler: (context) => Effect.runPromise(
      readAppFile(directory, context.req.param("filename")).pipe(Effect.provide(NodeFileSystem.layer)),
      { signal: context.req.raw.signal },
    ),
  }),
]
