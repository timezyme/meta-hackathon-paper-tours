import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Mastra } from "@mastra/core/mastra"
import { ConfigProvider, Context, Effect, Fiber, FileSystem, Layer, Path, Redacted, Schema, Stream } from "effect"
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { provisionUser } from "../../src/auth/index.ts"
import { AcceptedRun, DocumentDetail, DocumentList, Run } from "../../src/domain/index.ts"
import { makeAmuseMe } from "../../src/mastra/amuseme.ts"
import { PdfLimits } from "../../src/paper/pdf/index.ts"
import { serverConfig, type ServerConfig } from "../../src/server/config.ts"
import { DocumentHandler, type AdmissionConfiguration } from "../../src/server/documents.ts"
import { createGuardedApp } from "../../src/server/http.ts"
import { makeServerRuntime, openListener, startServer } from "../../src/server/lifecycle.ts"
import { StorageDatabase } from "../../src/storage/index.ts"
import { contractFixture } from "../fixtures/contracts.ts"

const origin = "http://127.0.0.1:4185"
const password = "fixture-only-document-password-2026"
const admission: AdmissionConfiguration = { _tag: "fixture", pipelineVersion: "http-fixture-1", configuration: contractFixture().run.configuration }
const testServices = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)
const sendRequest = (path: string, init?: RequestInit) => HttpClient.execute(HttpClientRequest.fromWeb(new Request(`${origin}${path}`, init)))

const command = Effect.fnUntraced(function* (executable: string, args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(ChildProcess.make(executable, args, { forceKillAfter: "100 millis" }))
  const output = yield* handle.all.pipe(Stream.decodeText(), Stream.mkString)
  return { output, code: yield* handle.exitCode }
}, Effect.scoped)

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-http-documents-" })
  const config = yield* serverConfig.pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({
    AMUSEME_PORT: "4185", AMUSEME_ORIGIN: origin, AMUSEME_DATA_DIR: path.join(root, "private"), AMUSEME_APP_DIR: path.join(root, "app"),
    BETTER_AUTH_SECRET: "fixture-only-http-document-secret-32-characters",
  })))
  const authOptions = { origin, secret: config.secret, databasePath: path.join(config.dataDirectory, "auth.sqlite") }
  const users = []
  for (const number of [1, 2]) users.push(yield* provisionUser(authOptions, {
    email: `reader${number}@example.test`, name: `Reader ${number}`, password: Redacted.make(password), role: "user",
  }))
  const pdfDirectory = path.join(root, "pdfs")
  yield* fs.makeDirectory(pdfDirectory)
  const generated = yield* command(config.pythonBin, ["-I", path.resolve("tests/paper/pdf/generate-fixtures.py"), pdfDirectory])
  expect(generated).toEqual({ code: 0, output: "" })
  return { fs, path, root, users, pdfDirectory, config: { ...config, admissionConfiguration: admission } }
})

const serve = Effect.fnUntraced(function* (config: ServerConfig) {
  const runtime = yield* makeServerRuntime(config)
  const context = yield* runtime.contextEffect
  const mastra = yield* Effect.acquireRelease(Effect.sync(() => new Mastra(makeAmuseMe(config.port, {
    ...config,
    runDocumentRequest: (operation, request, id) => runtime.runPromise(
      Effect.flatMap(DocumentHandler, (handler) => handler.handle(operation, request, id)), { signal: request.signal },
    ),
  }))), (instance) => Effect.promise(() => instance.shutdown()))
  const state = { phase: "starting" as "starting" | "ready" | "draining" }
  const app = yield* createGuardedApp(mastra, runtime, config.origin, state)
  yield* openListener(app, config.port, state)
  const signIn = Effect.fnUntraced(function* (number = 1) {
    const response = yield* sendRequest("/auth/sign-in/email", {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: `reader${number}@example.test`, password }),
    })
    expect(response.status).toBe(200)
    yield* response.json
    return Cookies.toCookieHeader(response.cookies)
  })
  const database = Context.get(context, StorageDatabase)
  const counts = database.query("http-test-counts", () => database.db.selectFrom("accepted_jobs").selectAll().execute()).pipe(Effect.map((rows) => rows.length))
  return { request: sendRequest, signIn, counts, database, handler: Context.get(context, DocumentHandler) }
})

const uploadRequest = (cookie: string, bytes: Uint8Array, key = "http-upload-one", filename = "paper.pdf", extras?: Record<string, string>): RequestInit => {
  const form = new FormData()
  form.append("file", new File([new Uint8Array(bytes)], filename, { type: "application/octet-stream" }))
  for (const [name, value] of Object.entries(extras ?? {})) form.append(name, value)
  return { method: "POST", headers: { cookie, origin, "idempotency-key": key }, body: form }
}

const checkEmptyTemporary = Effect.fnUntraced(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem
  const root = `${directory}/uploads`
  if (yield* fs.exists(root)) expect(yield* fs.readDirectory(root)).toEqual([])
})

describe("real document HTTP admission", () => {
  it.live("persists upload, exact original bytes, idempotency, and ownership across a runtime restart", () => Effect.gen(function* () {
    const f = yield* fixture
    const bytes = yield* f.fs.readFile(f.path.join(f.pdfDirectory, "normal.pdf"))
    const accepted = yield* Effect.gen(function* () {
      const server = yield* serve(f.config)
      const cookie = yield* server.signIn()
      const otherCookie = yield* server.signIn(2)
      const list = yield* server.request("/api/documents", { headers: { cookie } })
      expect(list.status).toBe(200)
      expect(yield* Schema.decodeUnknownEffect(DocumentList)(yield* list.json)).toEqual({ documents: [], upload: {
        maxBytes: PdfLimits.maxBytes, maxPages: 50, mediaType: "application/pdf", mode: "fixture", availability: { _tag: "enabled" },
      } })
      const response = yield* server.request("/api/documents", uploadRequest(cookie, bytes, "http-upload-one", '研究 "paper".pdf'))
      expect(response.status).toBe(202)
      const record = yield* Schema.decodeUnknownEffect(AcceptedRun)(yield* response.json)
      const repeated = yield* server.request("/api/documents", uploadRequest(cookie, bytes, "http-upload-one", '研究 "paper".pdf'))
      expect(repeated.status).toBe(202)
      expect(yield* repeated.json).toEqual(record)
      const conflict = yield* server.request("/api/documents", uploadRequest(cookie, bytes, "http-upload-two"))
      expect(conflict.status).toBe(409)
      yield* conflict.json
      const reusedForDifferentFile = yield* server.request("/api/documents", uploadRequest(cookie, bytes, "http-upload-one", "different.pdf"))
      expect(reusedForDifferentFile.status).toBe(409)
      yield* reusedForDifferentFile.json
      expect(yield* server.counts).toBe(1)
      for (const suffix of ["", "/status", "/original"]) {
        const denied = yield* server.request(`/api/documents/${record.documentId}${suffix}`, { headers: { cookie: otherCookie, "x-owner-id": f.users[0]?.user.id ?? "", "x-user-role": "admin" } })
        expect(denied.status).toBe(404)
        yield* denied.json
      }
      const detail = yield* server.request(`/api/documents/${record.documentId}`, { headers: { cookie } })
      expect((yield* Schema.decodeUnknownEffect(DocumentDetail)(yield* detail.json)).document.byteCount).toBe(bytes.length)
      const original = yield* server.request(`/api/documents/${record.documentId}/original`, { headers: { cookie } })
      expect(original.status).toBe(200)
      expect(original.headers["content-type"]).toBe("application/pdf")
      expect(original.headers["cache-control"]).toBe("no-store")
      expect(original.headers["content-disposition"]).toMatch(/^attachment; filename="document.pdf"; filename\*=UTF-8''/u)
      expect(original.headers["content-disposition"]).not.toContain("\n")
      expect(new Uint8Array(yield* original.arrayBuffer)).toEqual(new Uint8Array(bytes))
      const otherList = yield* server.request("/api/documents", { headers: { cookie: otherCookie } })
      expect((yield* Schema.decodeUnknownEffect(DocumentList)(yield* otherList.json)).documents).toEqual([])
      const scan = yield* f.fs.readFile(f.path.join(f.pdfDirectory, "scan.pdf"))
      const scanResponse = yield* server.request("/api/documents", uploadRequest(otherCookie, scan, "http-scan"))
      expect(scanResponse.status).toBe(202)
      yield* scanResponse.json
      expect(yield* server.counts).toBe(2)
      yield* checkEmptyTemporary(f.config.dataDirectory)
      return record
    }).pipe(Effect.scoped)
    const temporary = f.path.join(f.config.dataDirectory, "uploads")
    const orphan = yield* f.fs.makeTempDirectory({ directory: temporary, prefix: "upload-" })
    yield* f.fs.writeFile(f.path.join(orphan, "source.pdf"), bytes, { mode: 0o600 })
    const sentinel = f.path.join(temporary, "unrelated-note.txt")
    yield* f.fs.writeFileString(sentinel, "keep unrelated data")
    yield* f.fs.symlink(f.path.join(f.config.dataDirectory, "documents", accepted.documentId), f.path.join(temporary, "upload-LINK01"))
    yield* Effect.gen(function* () {
      const server = yield* serve(f.config)
      expect(yield* f.fs.exists(orphan)).toBe(false)
      expect(yield* f.fs.readDirectory(temporary)).toEqual(["unrelated-note.txt"])
      expect(yield* f.fs.readFileString(sentinel)).toBe("keep unrelated data")
      const cookie = yield* server.signIn()
      const response = yield* server.request(`/api/documents/${accepted.documentId}/status`, { headers: { cookie } })
      expect(response.status).toBe(200)
      const run = yield* Schema.decodeUnknownEffect(Run)(yield* response.json)
      expect(run.id).toBe(accepted.runId)
      expect(run.state._tag).toBe("queued")
      expect(run.pipelineVersion).toBe("http-fixture-1")
      expect(run.configuration).toEqual(contractFixture().run.configuration)
      expect(yield* server.counts).toBe(2)
      const original = yield* server.request(`/api/documents/${accepted.documentId}/original`, { headers: { cookie } })
      expect(original.status).toBe(200)
      expect(new Uint8Array(yield* original.arrayBuffer)).toEqual(new Uint8Array(bytes))
    }).pipe(Effect.scoped)
  }).pipe(Effect.scoped, Effect.provide(testServices)), { timeout: 20000 })

  it.live("rejects malformed, encrypted, blank, oversized and forged uploads without durable jobs", () => Effect.gen(function* () {
    const f = yield* fixture
    const server = yield* serve(f.config)
    const cookie = yield* server.signIn()
    for (const [name, status, code] of [
      ["malformed", 415, "unsupported-pdf"], ["blank", 422, "empty-document"], ["encrypted", 422, "encrypted-pdf"],
      ["empty-password", 422, "encrypted-pdf"], ["fifty-one", 413, "limit-exceeded"],
    ] as const) {
      const response = yield* server.request("/api/documents", uploadRequest(cookie, yield* f.fs.readFile(f.path.join(f.pdfDirectory, `${name}.pdf`)), `reject-${name}`))
      expect(response.status, name).toBe(status)
      expect(yield* response.json).toMatchObject({ code })
    }
    const normal = yield* f.fs.readFile(f.path.join(f.pdfDirectory, "normal.pdf"))
    for (const name of ["ownerId", "role", "pageCount"]) {
      const response = yield* server.request("/api/documents", uploadRequest(cookie, normal, "forged-fields", "paper.pdf", { [name]: "forged" }))
      expect(response.status).toBe(400)
      yield* response.json
    }
    const multiple = new FormData()
    multiple.append("file", new File([new Uint8Array(normal)], "first.pdf"))
    multiple.append("file", new File([new Uint8Array(normal)], "second.pdf"))
    const multipleResponse = yield* server.request("/api/documents", { method: "POST", headers: { cookie, origin, "idempotency-key": "multiple-files" }, body: multiple })
    expect(multipleResponse.status).toBe(400)
    yield* multipleResponse.json
    const oversized = new Uint8Array(PdfLimits.maxBytes + 1)
    const oversizedResponse = yield* server.request("/api/documents", uploadRequest(cookie, oversized, "over-byte-limit"))
    expect(oversizedResponse.status).toBe(413)
    yield* oversizedResponse.json
    expect(yield* server.counts).toBe(0)
    yield* checkEmptyTemporary(f.config.dataDirectory)
  }).pipe(Effect.scoped, Effect.provide(testServices)), { timeout: 20000 })

  it.live("rejects decoded filename paths and stores accepted sources only under opaque IDs", () => Effect.gen(function* () {
    const f = yield* fixture
    const server = yield* serve(f.config)
    const cookie = yield* server.signIn()
    const bytes = yield* f.fs.readFile(f.path.join(f.pdfDirectory, "normal.pdf"))
    for (const filename of ["../paper.pdf", "C:\\private\\paper.pdf", "folder/paper.pdf"]) {
      const response = yield* server.request("/api/documents", uploadRequest(cookie, bytes, "normalized-filename", filename))
      expect(response.status, filename).toBe(400)
      yield* response.json
    }
    expect(yield* server.counts).toBe(0)
    const response = yield* server.request("/api/documents", uploadRequest(cookie, bytes))
    expect(response.status).toBe(202)
    const accepted = yield* Schema.decodeUnknownEffect(AcceptedRun)(yield* response.json)
    expect(yield* f.fs.readDirectory(f.path.join(f.config.dataDirectory, "documents"))).toEqual([accepted.documentId])
    expect(yield* f.fs.readDirectory(f.path.join(f.config.dataDirectory, "documents", accepted.documentId))).toEqual(["source.pdf"])
    expect(yield* server.counts).toBe(1)
    yield* checkEmptyTemporary(f.config.dataDirectory)
  }).pipe(Effect.scoped, Effect.provide(testServices)), { timeout: 10000 })

  it.live("keeps production admission disabled and all unregistered methods and encodings protected", () => Effect.gen(function* () {
    const f = yield* fixture
    const server = yield* serve({ ...f.config, admissionConfiguration: { _tag: "disabled", reason: "The real pipeline and provider budget are not configured." } })
    const cookie = yield* server.signIn()
    const listed = yield* server.request("/api/documents", { headers: { cookie } })
    expect(listed.status).toBe(200)
    expect(yield* listed.json).toMatchObject({ documents: [], upload: { mode: "live", availability: { _tag: "disabled" } } })
    const denied = yield* server.request("/api/documents", { method: "POST", headers: { cookie, origin }, body: "not multipart" })
    expect(denied.status).toBe(503)
    expect(yield* denied.json).toMatchObject({ code: "processing-unavailable" })
    for (const path of ["/api/documents", "/api/documents/document-one/status", "/api/documents/document-one/original"]) {
      expect((yield* server.request(path)).status).toBe(401)
      for (const method of ["HEAD", "OPTIONS", "PUT", "DELETE"]) expect((yield* server.request(path, { method, headers: { cookie, origin } })).status).toBe(403)
    }
    for (const path of ["/api/%64ocuments", "/api/documents/document%2fone", "/api/documents/document-one/retry", "/api/documents/document-one/outputs/revision/unknown", "/admin/api/agents", "/api/agents"]) {
      expect((yield* server.request(path, { headers: { cookie } })).status, path).toBe(403)
    }
    for (const headers of [{ cookie }, { cookie, origin: "https://evil.example" }, { cookie, origin, "sec-fetch-site": "cross-site" }]) {
      expect((yield* server.request("/api/documents", { method: "POST", headers })).status).toBe(403)
    }
    expect((yield* server.handler.handle("list", new Request(`${origin}/api/documents`, { headers: { "x-owner-id": f.users[0]?.user.id ?? "", "x-user-role": "admin" } }))).status).toBe(401)
    expect(yield* server.counts).toBe(0)
  }).pipe(Effect.scoped, Effect.provide(testServices)), { timeout: 20000 })

  it.live("returns storage failure without publishing a job and cleans temporary data", () => Effect.gen(function* () {
    const f = yield* fixture
    const server = yield* serve(f.config)
    const cookie = yield* server.signIn()
    const directory = f.path.join(f.config.dataDirectory, "documents")
    yield* f.fs.remove(directory, { recursive: true })
    yield* f.fs.writeFileString(directory, "block source directory creation")
    const bytes = yield* f.fs.readFile(f.path.join(f.pdfDirectory, "normal.pdf"))
    const response = yield* server.request("/api/documents", uploadRequest(cookie, bytes))
    expect(response.status).toBe(503)
    expect(yield* response.json).toMatchObject({ code: "storage-failed" })
    expect(yield* server.counts).toBe(0)
    yield* checkEmptyTemporary(f.config.dataDirectory)
  }).pipe(Effect.scoped, Effect.provide(testServices)), { timeout: 10000 })

  it.live("cancels staged inspection on client disconnect and releases the intake slot", () => Effect.gen(function* () {
    const f = yield* fixture
    const wrapper = f.path.join(f.root, "blocked-python")
    const marker = f.path.join(f.root, "inspection-pid")
    yield* f.fs.writeFileString(wrapper, `#!/bin/sh\necho $$ > '${marker}'\nexec /bin/sleep 60\n`, { mode: 0o700 })
    const server = yield* serve({ ...f.config, pythonBin: wrapper })
    const cookie = yield* server.signIn()
    const bytes = yield* f.fs.readFile(f.path.join(f.pdfDirectory, "normal.pdf"))
    const fiber = yield* server.request("/api/documents", uploadRequest(cookie, bytes)).pipe(Effect.forkScoped)
    for (let attempt = 0; attempt < 100 && !(yield* f.fs.exists(marker)); attempt++) yield* Effect.sleep("10 millis")
    expect(yield* f.fs.exists(marker)).toBe(true)
    const temporary = f.path.join(f.config.dataDirectory, "uploads")
    const entries = yield* f.fs.readDirectory(temporary)
    expect(entries.length).toBe(1)
    const directory = f.path.join(temporary, entries[0] ?? "missing")
    expect((yield* f.fs.stat(directory)).mode & 0o777).toBe(0o700)
    expect((yield* f.fs.stat(f.path.join(directory, "source.pdf"))).mode & 0o777).toBe(0o600)
    const busy = yield* server.request("/api/documents", uploadRequest(cookie, bytes, "busy-upload"))
    expect(busy.status).toBe(429)
    yield* busy.json
    const pid = (yield* f.fs.readFileString(marker)).trim()
    yield* Fiber.interrupt(fiber)
    for (let attempt = 0; attempt < 100 && (yield* f.fs.readDirectory(temporary)).length !== 0; attempt++) yield* Effect.sleep("10 millis")
    expect((yield* command("/bin/ps", ["-o", "pid=", "-p", pid])).output.trim()).toBe("")
    yield* checkEmptyTemporary(f.config.dataDirectory)
    expect(yield* server.counts).toBe(0)
    const retry = yield* server.request("/api/documents", { method: "POST", headers: { cookie, origin, "idempotency-key": "after-cancel" }, body: "invalid" })
    expect(retry.status).toBe(400)
    yield* retry.json
  }).pipe(Effect.scoped, Effect.provide(testServices)), { timeout: 10000 })

  it.live("returns a queue-full error before publishing a second user's document", () => Effect.gen(function* () {
    const f = yield* fixture
    const server = yield* serve({ ...f.config, queueLimit: 1 })
    const first = yield* server.signIn()
    const second = yield* server.signIn(2)
    const bytes = yield* f.fs.readFile(f.path.join(f.pdfDirectory, "normal.pdf"))
    const accepted = yield* server.request("/api/documents", uploadRequest(first, bytes))
    expect(accepted.status).toBe(202)
    yield* accepted.json
    const full = yield* server.request("/api/documents", uploadRequest(second, bytes))
    expect(full.status).toBe(429)
    expect(yield* full.json).toMatchObject({ code: "queue-full" })
    expect(yield* server.counts).toBe(1)
    yield* checkEmptyTemporary(f.config.dataDirectory)
  }).pipe(Effect.scoped, Effect.provide(testServices)), { timeout: 10000 })

  it.live("hides expired documents from list, detail, status, and original reads", () => Effect.gen(function* () {
    const f = yield* fixture
    const server = yield* serve(f.config)
    const cookie = yield* server.signIn()
    const bytes = yield* f.fs.readFile(f.path.join(f.pdfDirectory, "normal.pdf"))
    const response = yield* server.request("/api/documents", uploadRequest(cookie, bytes))
    const accepted = yield* Schema.decodeUnknownEffect(AcceptedRun)(yield* response.json)
    const detailResponse = yield* server.request(`/api/documents/${accepted.documentId}`, { headers: { cookie } })
    const detail = yield* Schema.decodeUnknownEffect(DocumentDetail)(yield* detailResponse.json)
    yield* server.database.query("expire-http-fixture", () => server.database.db.updateTable("documents").set({
      expires_at: 1577836800000, document_json: JSON.stringify({ ...detail.document, expiresAt: "2020-01-01T00:00:00.000Z" }),
    }).where("id", "=", accepted.documentId).execute())
    for (const suffix of ["", "/status", "/original"]) {
      const expired = yield* server.request(`/api/documents/${accepted.documentId}${suffix}`, { headers: { cookie } })
      expect(expired.status).toBe(404)
      yield* expired.json
    }
    const listed = yield* server.request("/api/documents", { headers: { cookie } })
    expect((yield* Schema.decodeUnknownEffect(DocumentList)(yield* listed.json)).documents).toEqual([])
  }).pipe(Effect.scoped, Effect.provide(testServices)), { timeout: 10000 })

  it.live("releases a partially received upload when its HTTP client disconnects", () => Effect.gen(function* () {
    const f = yield* fixture
    const server = yield* serve(f.config)
    const cookie = yield* server.signIn()
    const body = Stream.concat(Stream.make(new TextEncoder().encode('--incomplete\r\nContent-Disposition: form-data; name="file"; filename="paper.pdf"\r\n\r\n%PDF-')), Stream.never)
    const fiber = yield* HttpClient.execute(HttpClientRequest.post(`${origin}/api/documents`).pipe(
      HttpClientRequest.setHeaders({ cookie, origin, "idempotency-key": "interrupted-body" }),
      HttpClientRequest.bodyStream(body, { contentType: "multipart/form-data; boundary=incomplete" }),
    )).pipe(Effect.forkScoped)
    yield* Effect.sleep("100 millis")
    const busy = yield* server.request("/api/documents", { method: "POST", headers: { cookie, origin, "idempotency-key": "competing-body" } })
    expect(busy.status).toBe(429)
    yield* busy.json
    yield* Fiber.interrupt(fiber)
    yield* Effect.sleep("100 millis")
    const subsequent = yield* server.request("/api/documents", { method: "POST", headers: { cookie, origin, "idempotency-key": "after-body-cancel" }, body: "invalid" })
    expect(subsequent.status).toBe(400)
    yield* subsequent.json
    expect(yield* server.counts).toBe(0)
    yield* checkEmptyTemporary(f.config.dataDirectory)
  }).pipe(Effect.scoped, Effect.provide(testServices)), { timeout: 10000 })

  it.live("starts the production composition with real storage and disabled live uploads", () => Effect.gen(function* () {
    const f = yield* fixture
    const config = { ...f.config, admissionConfiguration: { _tag: "disabled", reason: "The real pipeline is not configured." } } satisfies ServerConfig
    const mastra = yield* Effect.sync(() => new Mastra(makeAmuseMe(config.port)))
    yield* startServer(mastra, config)
    const signIn = yield* sendRequest("/auth/sign-in/email", {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email: "reader1@example.test", password }),
    })
    expect(signIn.status).toBe(200)
    yield* signIn.json
    const cookie = Cookies.toCookieHeader(signIn.cookies)
    const listed = yield* sendRequest("/api/documents", { headers: { cookie } })
    expect(listed.status).toBe(200)
    expect(yield* listed.json).toMatchObject({ documents: [], upload: { mode: "live", availability: { _tag: "disabled" } } })
    const upload = yield* sendRequest("/api/documents", { method: "POST", headers: { cookie, origin }, body: "invalid" })
    expect(upload.status).toBe(503)
    yield* upload.json
    expect(yield* f.fs.exists(f.path.join(config.dataDirectory, "application.sqlite"))).toBe(true)
    expect(yield* f.fs.exists(f.path.join(config.dataDirectory, "mastra.sqlite"))).toBe(true)
  }).pipe(Effect.scoped, Effect.provide(testServices)), { timeout: 10000 })
})
