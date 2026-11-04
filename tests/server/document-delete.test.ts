import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path, Schema } from "effect"
import { sql } from "kysely"
import { AuthService } from "../../src/auth/index.ts"
import { Session } from "../../src/domain/index.ts"
import { documentRouteDefinitions } from "../../src/mastra/document-routes.ts"
import { PdfInspector } from "../../src/paper/pdf/index.ts"
import { isDocumentRequest } from "../../src/server/access.ts"
import { DocumentHandler, type DocumentOperation } from "../../src/server/documents.ts"
import { DocumentStore, makeDocumentStoreLayer } from "../../src/storage/index.ts"
import { directory, owner, other, setup } from "../fixtures/published-output.ts"

const origin = "http://127.0.0.1:4183"
const fixture = Effect.fnUntraced(function* (dataDirectory: string, publish = true) {
  const state = yield* setup(dataDirectory)
  if (publish) yield* state.outputs.publish(state.claim, state.publication)
  const ownSession = yield* Schema.decodeUnknownEffect(Session)({ user: { id: owner, role: "user", email: "owner@example.test" } })
  const otherSession = yield* Schema.decodeUnknownEffect(Session)({ user: { id: other, role: "user", email: "other@example.test" } })
  const auth = AuthService.of({
    getSession: (headers) => Effect.succeed(headers.get("cookie") === "owner" ? ownSession : headers.get("cookie") === "other" ? otherSession : null),
    handle: () => Effect.succeed(new Response(null, { status: 404 })),
  })
  const handler = yield* DocumentHandler.pipe(Effect.provide(DocumentHandler.layer({
    origin, temporaryDirectory: dataDirectory + "/uploads", admissionConfiguration: { _tag: "live", pipelineVersion: "live-1", configuration: state.claim.run.configuration },
  }).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(AuthService, auth), Layer.succeed(DocumentStore, state.documents), Layer.succeed(PdfInspector, { inspect: () => Effect.die("Deletion must not inspect a PDF") }))))))
  const request = (operation: DocumentOperation = "delete", options: RequestInit = {}, id: string = state.claim.document.id, host = origin) => handler.handle(operation,
    new Request(`${host}/api/documents/${id}`, { method: operation === "delete" ? "DELETE" : "GET", ...options, headers: { cookie: "owner", origin, ...options.headers } }), id)
  return { ...state, request }
})

describe("terminal document DELETE", () => {
  it.effect("registers the frozen route and removes owner sources, outputs and feedback with an empty204", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const f = yield* fixture(options.dataDirectory)
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      expect(documentRouteDefinitions).toContainEqual({ operation: "delete", method: "DELETE", path: "/api/documents/:documentId" })
      expect(isDocumentRequest("DELETE", `/api/documents/${f.claim.document.id}`)).toBe(true)
      expect(isDocumentRequest("DELETE", `/api/documents/${f.claim.document.id}/original`)).toBe(false)
      yield* f.outputs.rate(owner, f.claim.document.id, f.publication.manifest.scope.revisionId, "up")
      const response = yield* f.request()
      expect(response.status).toBe(204)
      expect(response.body).toBeNull()
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(yield* fs.exists(path.join(options.dataDirectory, "documents", f.claim.document.id))).toBe(false)
      for (const operation of ["delete", "detail", "status", "original"] as const) expect((yield* f.request(operation)).status).toBe(404)
      expect((yield* f.outputs.read(owner, f.claim.document.id, f.publication.manifest.scope.revisionId, "normalized.txt").pipe(Effect.result))._tag).toBe("Failure")
      expect(yield* f.database.query("ratings", () => f.database.db.selectFrom("ratings").selectAll().execute())).toEqual([])
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects missing/foreign sessions, wrong methods, invalid IDs and cross-origin requests without deletion", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const f = yield* fixture(options.dataDirectory)
      for (const [requestOptions, status] of [
        [{ headers: { cookie: "none" } }, 401], [{ headers: { cookie: "other", "x-owner-id": owner } }, 404],
        [{ headers: { origin: "" } }, 403], [{ headers: { origin: "https://other.test" } }, 403],
        [{ headers: { "sec-fetch-site": "cross-site" } }, 403], [{ method: "POST" }, 404], [{ method: "GET" }, 404],
      ] as const) expect((yield* f.request("delete", requestOptions)).status).toBe(status)
      expect((yield* f.request("delete", {}, f.claim.document.id, "https://forged.test")).status).toBe(403)
      expect((yield* f.request("delete", {}, "bad/id")).status).toBe(400)
      expect((yield* f.request("detail")).status).toBe(200)
      const list = yield* f.request("list")
      expect(yield* Effect.promise(() => list.json())).toMatchObject({ upload: { mode: "live", availability: { _tag: "enabled" } } })
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("keeps active runs intact and surfaces transaction failure without false success", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const f = yield* fixture(options.dataDirectory, false)
      expect((yield* f.request()).status).toBe(409)
      expect((yield* f.request("status")).status).toBe(200)
      yield* f.outputs.publish(f.claim, f.publication)
      yield* f.database.query("inject", () => sql.raw("CREATE TRIGGER deny_delete BEFORE UPDATE OF lifecycle ON documents WHEN NEW.lifecycle='deleted' BEGIN SELECT RAISE(FAIL,'fixture denied'); END").execute(f.database.db))
      const result = yield* f.request()
      expect(result.status).toBe(503)
      expect(yield* Effect.promise(() => result.json())).toMatchObject({ code: "storage-failed" })
      expect((yield* f.request("original")).status).toBe(200)
      expect(yield* f.outputs.manifest(owner, f.claim.document.id, f.publication.manifest.scope.revisionId)).toEqual(f.publication.manifest)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))
})
