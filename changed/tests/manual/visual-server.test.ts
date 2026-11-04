import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Result, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import type { HttpMethod } from "effect/http/HttpMethod"
import { CanonicalDocument, DocumentDetail, DocumentList, ProcessingReport, validGuideSources } from "../../src/domain/index.ts"
import { completeText } from "../fixtures/reader.ts"
import { runCommand } from "../guards/support.ts"
import { startVisualFixture } from "./visual-server.ts"

const fixtureLayer = Layer.merge(NodeServices.layer, FetchHttpClient.layer)
const setup = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "amuseme-visual-fixture-" })
  yield* fs.makeDirectory(`${directory}/assets`)
  yield* fs.writeFileString(`${directory}/index.html`, "fixture index\n")
  yield* fs.writeFileString(`${directory}/assets/app.js`, "console.log('fixture only')\n")
  yield* fs.writeFileString(`${directory}/assets/style.css`, "body { color: olive; }\n")
  const fixture = yield* startVisualFixture("4193", directory)
  const request = (method: HttpMethod, path: string, body = "", origin = fixture.origin, key = "visual-fixture-submission") => HttpClient.execute(HttpClientRequest.make(method)(`${fixture.origin}${path}`).pipe(
    HttpClientRequest.setHeaders({ origin, "idempotency-key": key }),
    HttpClientRequest.bodyText(body),
  ))
  const mode = (value: string, saved = false) => request("POST", "/qa/state", `mode=${value}${saved ? "&saved=yes" : ""}`)
  const detail = HttpClient.get(`${fixture.origin}${fixture.documentPath}`).pipe(Effect.flatMap((response) => response.json), Effect.flatMap(Schema.decodeUnknownEffect(DocumentDetail)))
  const list = HttpClient.get(`${fixture.origin}/api/documents`).pipe(Effect.flatMap((response) => response.json), Effect.flatMap(Schema.decodeUnknownEffect(DocumentList)))
  return { ...fixture, fs, directory, request, mode, detail, list }
})

describe("maintained manual visual fixture", () => {
  it.live("serves exact fingerprinted build bytes on loopback and enforces Host/Origin without passthrough", () => Effect.gen(function* () {
    const fixture = yield* setup()
    const bound = fixture.listener.address()
    expect(bound !== null && typeof bound !== "string" ? bound.address : null).toBe("127.0.0.1")
    expect(fixture.fingerprints).toEqual({
      index: "bfae44e79d570c1d217346466bb6a35af2b42b23016ed1082e211d22b4c6d2ca",
      assets: { "/app/assets/app.js": "d60cfb802c2645acc86b452d486c9a406d7d39b9fcae0379203e9daaf5163fc2", "/app/assets/style.css": "f85eff17c1863c9c43f6d1be1204f8bbdeee39a60bb71e84ebf81115a76086d3" },
    })
    for (const path of ["/", "/sign-in", fixture.readerPath]) expect(yield* (yield* HttpClient.get(`${fixture.origin}${path}`)).text).toBe("fixture index\n")
    const asset = yield* HttpClient.get(`${fixture.origin}/app/assets/app.js`)
    expect(asset.headers["content-type"]).toBe("text/javascript")
    expect(yield* asset.text).toBe("console.log('fixture only')\n")
    expect(yield* (yield* HttpClient.get(`${fixture.origin}/qa/health`)).json).toEqual({ fixture: true, origin: fixture.origin, fingerprints: fixture.fingerprints })
    const wrongHost = yield* runCommand("curl", ["--silent", "--show-error", "--max-time", "2", "--header", "Host: attacker.test", "--output", "/dev/null", "--write-out", "%{http_code}", `${fixture.origin}/qa/health`])
    expect(wrongHost).toEqual({ code: 0, output: "403" })
    expect((yield* fixture.request("POST", "/qa/state", "mode=deleted", "https://attacker.test")).status).toBe(403)
    expect((yield* fixture.request("POST", "/qa/state", "mode=unknown-state")).status).toBe(400)
    expect((yield* fixture.list).documents).toHaveLength(1)
    for (const path of ["/.env", "/data/application.sqlite", "/app/assets/missing.js", `${fixture.documentPath}/original`, `${fixture.outputPath}/zip`, "/admin/api/agents"]) expect((yield* HttpClient.get(`${fixture.origin}${path}`)).status).toBe(404)
    const occupied = yield* startVisualFixture("4193", fixture.directory).pipe(Effect.scoped, Effect.result)
    expect(Result.isFailure(occupied)).toBe(true)
    if (Result.isFailure(occupied)) expect(occupied.failure).toMatchObject({ _tag: "VisualFixtureError", operation: "listen" })
    expect((yield* HttpClient.get(`${fixture.origin}/qa/health`)).status).toBe(200)
    expect(yield* fixture.fs.readDirectory(fixture.directory)).toEqual(["assets", "index.html"])
  }).pipe(Effect.scoped, Effect.provide(fixtureLayer)), { timeout: 10000 })

  it.live("validates every scenario, keeps retries in memory, and requires acknowledgment for uncertain work", () => Effect.gen(function* () {
    const fixture = yield* setup()
    for (const [mode, expected] of [["success", "succeeded-with-issues"], ["failed-recoverable", "failed"], ["failed-permanent", "failed"], ["unknown", "interrupted"], ["queued", "queued"], ["running", "running"]] as const) {
      expect((yield* fixture.mode(mode)).status).toBe(303)
      expect((yield* fixture.detail).latestRun.state._tag).toBe(expected)
    }
    yield* fixture.mode("failed-permanent")
    expect((yield* fixture.request("POST", `${fixture.documentPath}/retry`, JSON.stringify({ previousRunId: (yield* fixture.detail).latestRun.id, acknowledgePossibleRepeatedWork: true }))).status).toBe(409)
    yield* fixture.mode("unknown", true)
    const previousRunId = (yield* fixture.detail).latestRun.id
    expect((yield* HttpClient.get(`${fixture.origin}${fixture.outputPath}/document`)).status).toBe(200)
    expect((yield* fixture.request("POST", `${fixture.documentPath}/retry`, "{")).status).toBe(400)
    expect((yield* fixture.request("POST", `${fixture.documentPath}/retry`, JSON.stringify({ previousRunId, acknowledgePossibleRepeatedWork: false }))).status).toBe(409)
    const body = JSON.stringify({ previousRunId, acknowledgePossibleRepeatedWork: true })
    const accepted = yield* fixture.request("POST", `${fixture.documentPath}/retry`, body)
    expect(accepted.status).toBe(202)
    const repeated = yield* fixture.request("POST", `${fixture.documentPath}/retry`, body)
    expect(repeated.status).toBe(202)
    expect(yield* repeated.json).toEqual(yield* accepted.json)
    expect((yield* fixture.detail).latestRun.state._tag).toBe("queued")
    expect((yield* fixture.request("DELETE", fixture.documentPath)).status).toBe(409)
    expect((yield* fixture.request("POST", `${fixture.documentPath}/retry`, JSON.stringify({ previousRunId, acknowledgePossibleRepeatedWork: false }))).status).toBe(409)
    yield* fixture.mode("no-issues")
    expect(yield* (yield* HttpClient.get(`${fixture.origin}${fixture.outputPath}/report`)).json).toMatchObject({ issues: [] })
    yield* fixture.mode("document-expired")
    expect((yield* HttpClient.get(`${fixture.origin}${fixture.documentPath}`)).status).toBe(410)
    yield* fixture.mode("expired")
    expect((yield* HttpClient.get(`${fixture.origin}${fixture.outputPath}/document`)).status).toBe(410)
    yield* fixture.mode("server-error")
    expect((yield* HttpClient.get(`${fixture.origin}/api/documents`)).status).toBe(503)
    yield* fixture.mode("unauthorized")
    expect((yield* HttpClient.get(`${fixture.origin}/api/session`)).status).toBe(401)
    yield* fixture.request("POST", "/auth/sign-in/email", '{"password":"dummy-credential-not-recorded"}')
    expect((yield* HttpClient.get(`${fixture.origin}/api/session`)).status).toBe(200)
    expect(yield* (yield* HttpClient.get(`${fixture.origin}/qa/logs`)).text).not.toContain("dummy-credential-not-recorded")
    yield* fixture.mode("deleted")
    expect((yield* fixture.list).documents).toEqual([])
    expect((yield* HttpClient.get(`${fixture.origin}${fixture.documentPath}`)).status).toBe(404)
  }).pipe(Effect.scoped, Effect.provide(fixtureLayer), Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" })), { timeout: 10000 })

  it.live("serves a clearly synthetic guide with exact source quotations and a controllable pending state", () => Effect.gen(function* () {
    const fixture = yield* setup()
    yield* fixture.mode("guide-running")
    expect((yield* fixture.detail).latestRun.state).toMatchObject({ _tag: "running", progress: { stage: "guide", completedUnits: 0, totalUnits: 1 } })
    expect((yield* HttpClient.get(`${fixture.origin}${fixture.outputPath}/document`)).status).toBe(404)
    yield* fixture.mode("guide-success")
    const document = yield* (yield* HttpClient.get(`${fixture.origin}${fixture.outputPath}/document`)).json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(CanonicalDocument)))
    const report = yield* (yield* HttpClient.get(`${fixture.origin}${fixture.outputPath}/report`)).json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(ProcessingReport)))
    expect(document.guide?.overview.text).toContain("synthetic")
    expect(document.guide !== undefined && validGuideSources(document.guide, document.sourceBlocks)).toBe(true)
    expect(report.receipts.some(({ receipt }) => receipt.id === document.guide?.providerAttemptId && receipt.stage === "guide")).toBe(true)
    yield* fixture.mode("success")
    expect(yield* (yield* HttpClient.get(`${fixture.origin}${fixture.outputPath}/document`)).json).not.toHaveProperty("guide")
  }).pipe(Effect.scoped, Effect.provide(fixtureLayer)), { timeout: 10000 })

  it.live("refuses uploads without creating files and resets rating, deletion, and logs", () => Effect.gen(function* () {
    const fixture = yield* setup()
    for (const [mode, status] of [["queue-full", 429], ["per-user-active", 409], ["storage-refused", 503]] as const) {
      yield* fixture.mode(mode)
      expect((yield* fixture.list).upload.availability._tag).toBe("enabled")
      expect((yield* fixture.request("POST", "/api/documents", "not even a PDF")).status).toBe(status)
      expect((yield* fixture.request("POST", "/api/documents", "discarded", fixture.origin, "")).status).toBe(400)
      expect((yield* fixture.list).documents).toHaveLength(1)
      expect(yield* (yield* HttpClient.get(`${fixture.origin}/qa/logs`)).text).not.toContain("not even a PDF")
    }
    for (const mode of ["budget-exhausted", "provider-disabled", "success"]) {
      yield* fixture.mode(mode)
      expect((yield* fixture.list).upload.availability._tag).toBe("disabled")
      expect((yield* fixture.request("POST", "/api/documents", "discarded")).status).toBe(503)
    }
    expect((yield* fixture.request("PUT", `${fixture.outputPath}/rating`, '{"value":"up","ownerId":"foreign"}')).status).toBe(400)
    expect((yield* fixture.request("PUT", `${fixture.outputPath}/rating`, '{"value":"up"}')).status).toBe(200)
    expect(yield* (yield* HttpClient.get(`${fixture.origin}${fixture.outputPath}/rating`)).json).toEqual({ value: "up" })
    expect(yield* (yield* HttpClient.get(`${fixture.origin}${fixture.outputPath}/text`)).text).toBe(completeText)
    expect((yield* fixture.request("DELETE", fixture.documentPath)).status).toBe(204)
    expect((yield* fixture.list).documents).toHaveLength(0)
    yield* fixture.request("POST", "/qa/reset")
    expect(yield* (yield* HttpClient.get(`${fixture.origin}/qa/logs`)).json).toEqual([])
    expect((yield* fixture.list).documents).toHaveLength(1)
    expect(yield* (yield* HttpClient.get(`${fixture.origin}${fixture.outputPath}/rating`)).json).toEqual({ value: null })
    expect(yield* fixture.fs.readDirectory(fixture.directory)).toEqual(["assets", "index.html"])
  }).pipe(Effect.scoped, Effect.provide(fixtureLayer)), { timeout: 10000 })
})
