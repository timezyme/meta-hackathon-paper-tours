import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { AuthService } from "../../src/auth/index.ts"
import { DocumentList, Session } from "../../src/domain/index.ts"
import { PdfInspector, type PdfInspection } from "../../src/paper/pdf/index.ts"
import { DocumentHandler, type DocumentOperation } from "../../src/server/documents.ts"
import { Admission, DocumentStore, makeDocumentStoreLayer } from "../../src/storage/index.ts"
import { contractFixture } from "../fixtures/contracts.ts"
import { directory, owner, other, setup } from "../fixtures/published-output.ts"

const origin = "http://127.0.0.1:4183"
const inspection = { pageCount: 1, pages: [], repaired: false } as unknown as PdfInspection
const fixture = Effect.fnUntraced(function* (dataDirectory: string, uploadsPerUser?: number) {
  const state = yield* setup(dataDirectory)
  yield* state.outputs.publish(state.claim, state.publication)
  const sessions = {
    owner: yield* Schema.decodeUnknownEffect(Session)({ user: { id: owner, role: "user", email: "owner@example.test" } }),
    other: yield* Schema.decodeUnknownEffect(Session)({ user: { id: other, role: "user", email: "judge@example.test" } }),
    admin: yield* Schema.decodeUnknownEffect(Session)({ user: { id: "admin-reader", role: "admin", email: "admin@example.test" } }),
  }
  const auth = AuthService.of({
    getSession: (headers) => Effect.succeed(sessions[headers.get("cookie") as keyof typeof sessions] ?? null),
    handle: () => Effect.succeed(new Response(null, { status: 404 })),
  })
  const handler = yield* DocumentHandler.pipe(Effect.provide(DocumentHandler.layer({
    origin, temporaryDirectory: dataDirectory + "/uploads", uploadsPerUser,
    admissionConfiguration: { _tag: "live", pipelineVersion: "live-1", configuration: state.claim.run.configuration },
  }).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(AuthService, auth), Layer.succeed(DocumentStore, state.documents), Layer.succeed(PdfInspector, { inspect: () => Effect.succeed(inspection) }))))))
  const request = (cookie: keyof typeof sessions, operation: DocumentOperation, method = "GET", suffix = "", init: RequestInit = {}) => handler.handle(operation,
    new Request(`${origin}/api/documents${operation === "list" || operation === "upload" ? "" : `/${state.claim.document.id}${suffix}`}`, { method, ...init, headers: { cookie, origin, ...init.headers } }), state.claim.document.id)
  const list = (cookie: keyof typeof sessions) => request(cookie, "list").pipe(
    Effect.flatMap((response) => Effect.promise(() => response.json())), Effect.flatMap(Schema.decodeUnknownEffect(DocumentList)))
  const upload = (cookie: keyof typeof sessions, key: string) => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const form = new FormData()
    form.append("file", new File([new Uint8Array(yield* fs.readFile(new URL("../fixtures/normal.pdf", import.meta.url).pathname))], `${key}.pdf`, { type: "application/pdf" }))
    return yield* request(cookie, "upload", "POST", "", { headers: { "idempotency-key": key }, body: form })
  })
  return { ...state, request, list, upload }
})

describe("shared examples and the upload allowance", () => {
  it.effect("shows the examples owner's documents read-only to every other signed-in reader", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const f = yield* fixture(options.dataDirectory)
      const judgeList = yield* f.list("other")
      expect(judgeList.documents).toEqual([])
      expect(judgeList.examples?.map((record) => record.document.id)).toEqual([f.claim.document.id])
      const ownerList = yield* f.list("owner")
      expect(ownerList.documents.map((record) => record.document.id)).toEqual([f.claim.document.id])
      expect(ownerList.examples).toBeUndefined()
      for (const [operation, suffix] of [["detail", ""], ["status", "/status"], ["original", "/original"]] as const) {
        expect((yield* f.request("other", operation, "GET", suffix)).status, operation).toBe(200)
      }
      expect((yield* f.request("other", "delete", "DELETE")).status).toBe(404)
      const retry = yield* f.request("other", "retry", "POST", "/retry", { headers: { "idempotency-key": "judge-retry" }, body: JSON.stringify({ previousRunId: f.claim.run.id, acknowledgePossibleRepeatedWork: true }) })
      expect(retry.status).toBe(404)
      expect((yield* f.request("owner", "detail")).status).toBe(200)
      expect((yield* f.request("owner", "delete", "DELETE")).status).toBe(204)
      expect((yield* f.request("other", "detail")).status).toBe(404)
      expect((yield* f.list("other")).examples).toEqual([])
    }).pipe(Effect.provide(makeDocumentStoreLayer({ ...options, examplesOwnerId: owner })))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("keeps other owners' documents private when no examples owner is configured", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const f = yield* fixture(options.dataDirectory)
      expect((yield* f.list("other")).examples).toBeUndefined()
      expect((yield* f.request("other", "detail")).status).toBe(404)
      expect((yield* f.list("other")).upload.allowance).toBeUndefined()
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("counts every upload ever made, including deleted ones, and exempts administrators", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const f = yield* fixture(options.dataDirectory, 2)
      expect((yield* f.list("owner")).upload.allowance).toEqual({ limit: 2, used: 1 })
      expect((yield* f.list("other")).upload.allowance).toEqual({ limit: 2, used: 0 })
      expect((yield* f.list("admin")).upload.allowance).toBeUndefined()
      expect((yield* f.request("owner", "delete", "DELETE")).status).toBe(204)
      expect((yield* f.list("owner")).upload.allowance).toEqual({ limit: 2, used: 1 })
      expect((yield* f.upload("owner", "second-upload")).status).toBe(202)
      expect((yield* f.list("owner")).upload.allowance).toEqual({ limit: 2, used: 2 })
      const refused = yield* f.upload("owner", "third-upload")
      expect(refused.status).toBe(403)
      expect(yield* Effect.promise(() => refused.json())).toEqual({ code: "forbidden", message: "You've used your 2 uploads. You can still read the examples and your documents." })
      const replay = yield* f.upload("owner", "second-upload")
      expect(replay.status).toBe(202)
      const fs = yield* FileSystem.FileSystem
      const bytes = yield* fs.readFile(new URL("../fixtures/normal.pdf", import.meta.url).pathname)
      const direct = yield* f.documents.admit(yield* Schema.decodeUnknownEffect(Admission)({
        ownerId: owner, idempotencyKey: "storage-direct", bytes, originalFilename: "direct.pdf", pageCount: 1, pipelineVersion: "1", configuration: contractFixture().run.configuration, uploadLimit: 2,
      })).pipe(Effect.flip)
      expect(direct).toMatchObject({ code: "forbidden" })
      expect(yield* f.documents.uploadCount(owner)).toBe(2)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))
})
