import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, FileSystem, Layer, Schema } from "effect"
import { AuthService } from "../../src/auth/index.ts"
import { AcceptedRun, Session } from "../../src/domain/index.ts"
import { PdfInspector } from "../../src/paper/pdf/index.ts"
import { RunRecovery, makeRunRecovery } from "../../src/processing/index.ts"
import { disabledGuardPolicy } from "../../src/processing/config.ts"
import { DocumentHandler } from "../../src/server/documents.ts"
import { Admission, DocumentStore, makeDocumentStoreLayer } from "../../src/storage/index.ts"
import { contractFixture } from "../fixtures/contracts.ts"
import { directory, owner, other } from "../fixtures/published-output.ts"

const origin = "http://127.0.0.1:4184"
const session = (id: string) => Schema.decodeUnknownSync(Session)({ user: { id, email: "fixture@example.test", role: "user" } })

describe("explicit document retry HTTP", () => {
  it.effect("authorizes the owner, bounds input, rejects stale intent, and persists one idempotent retry", () => Effect.gen(function* () {
    const options = yield* directory
    yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const store = yield* DocumentStore
      const configuration = contractFixture().run.configuration
      const request = yield* Schema.decodeUnknownEffect(Admission)({ ownerId: owner, idempotencyKey: "retry-source", originalFilename: "normal.pdf", bytes: yield* fs.readFile(new URL("../fixtures/normal.pdf", import.meta.url).pathname), pageCount: 1, pipelineVersion: "1", configuration })
      const accepted = yield* store.admit(request)
      const claim = yield* store.claimNext({ workerId: "retry-test", leaseMilliseconds: 60000 })
      if (claim === null) return yield* Effect.die("Missing test claim")
      yield* store.updateRun(claim, { _tag: "failed", finishedAt: DateTime.formatIso(yield* DateTime.now), failure: { code: "storage-failed", message: "Temporary fixture storage failure", retryable: true, stage: "extraction", pageId: null, figureId: null } })
      const recovery = yield* makeRunRecovery({ ...disabledGuardPolicy, mode: "fixture", budgetId: "retry-http", authorizedBudgetMicrousd: 100 }, 5)
      const auth = AuthService.of({ getSession: (headers) => Effect.succeed(headers.get("cookie") === "owner" ? session(owner) : headers.get("cookie") === "other" ? session(other) : null), handle: () => Effect.succeed(new Response(null)) })
      const handler = yield* DocumentHandler.pipe(Effect.provide(DocumentHandler.layer({ origin, temporaryDirectory: options.dataDirectory + "/uploads", admissionConfiguration: { _tag: "live", pipelineVersion: "1", configuration } }).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(AuthService, auth), Layer.succeed(RunRecovery, recovery), Layer.succeed(PdfInspector, { inspect: () => Effect.die("Retry must not re-inspect") }))))))
      const body = { previousRunId: claim.run.id, acknowledgePossibleRepeatedWork: false }
      const send = (value: unknown = body, headers: Record<string, string> = {}) => handler.handle("retry", new Request(`${origin}/api/documents/${accepted.documentId}/retry`, { method: "POST", headers: { origin, cookie: "owner", "content-type": "application/json", "idempotency-key": "retry-once", ...headers }, body: JSON.stringify(value) }), accepted.documentId)
      expect((yield* send(body, { cookie: "none" })).status).toBe(401)
      expect((yield* send(body, { cookie: "other" })).status).toBe(404)
      expect((yield* send(body, { origin: "https://foreign.test" })).status).toBe(403)
      expect((yield* send({ ...body, ownerId: other })).status).toBe(400)
      expect((yield* send({ ...body, padding: "x".repeat(1024) })).status).toBe(400)
      expect((yield* send({ ...body, previousRunId: "wrong-run" })).status).toBe(409)
      const result = yield* send()
      expect(result.status).toBe(202)
      const retry = yield* Effect.promise(() => result.json()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(AcceptedRun)))
      expect(retry.runId).not.toBe(claim.run.id)
      expect(retry.documentId).toBe(accepted.documentId)
      const repeated = yield* send()
      expect(repeated.status).toBe(202)
      expect(yield* Effect.promise(() => repeated.json())).toEqual(retry)
      expect((yield* send(body, { "idempotency-key": "another-click" })).status).toBe(409)
      expect((yield* store.status(owner, accepted.documentId)).id).toBe(retry.runId)
    }).pipe(Effect.provide(makeDocumentStoreLayer(options)))
  }).pipe(Effect.provide(NodeServices.layer)))
})
