import { createAdaptorServer } from "@hono/node-server"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Crypto, Effect, FileSystem, Schema } from "effect"
import {
  AcceptedRun, ApiError, DocumentDetail, DocumentList, IdempotencyKey, RatingRequest, RetryRequest, RunId, UploadPolicy, UploadUnavailable,
  boundaryParseOptions, errorHttpStatus,
} from "../../src/domain/index.ts"
import { completeText, readerCanonical, readerPath, readerRecord, readerReport } from "../fixtures/reader.ts"
import { guidedCanonical, guidedReport } from "../fixtures/guide.ts"

const modes = ["success", "guide-success", "guide-running", "no-issues", "document-expired", "failed-recoverable", "failed-permanent", "unknown", "queued", "running", "expired", "deleted", "server-error", "unauthorized", "budget-exhausted", "provider-disabled", "queue-full", "per-user-active", "storage-refused"] as const
const Mode = Schema.Literals(modes)
const Port = Schema.Literals(["4187", "4193"])
const admissionRefusals = {
  "queue-full": { code: "queue-full", message: "The document queue is full" },
  "per-user-active": { code: "conflict", message: "A document is already queued or processing for this account" },
  "storage-refused": { code: "storage-failed", message: "The private upload could not be stored. Try again." },
} as const satisfies Record<string, typeof ApiError.Type>
class VisualFixtureError extends Schema.TaggedError<VisualFixtureError>()("VisualFixtureError", { operation: Schema.String, cause: Schema.Defect() }) {}
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } })
const error = (code: string, message: string, status: number) => json({ code, message }, status)
const escape = (value: unknown) => String(value).replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character)
const requestJson = (request: Request) => Effect.tryPromise({ try: () => request.json(), catch: (cause) => new VisualFixtureError({ operation: "read fixture JSON", cause }) }).pipe(Effect.catchTag("VisualFixtureError", () => Effect.succeed(null)))

export const startVisualFixture = Effect.fnUntraced(function* (port: typeof Port.Type, builtDirectory = ".mastra/output/app") {
  const fs = yield* FileSystem.FileSystem
  const crypto = yield* Crypto.Crypto
  const host = `127.0.0.1:${port}`
  const origin = `http://${host}`
  const documentPath = `/api/documents/${readerRecord.document.id}`
  const outputPath = `${documentPath}/outputs/${readerRecord.currentRevisionId}`
  const index = yield* fs.readFile(`${builtDirectory}/index.html`)
  const assets = new Map<string, Uint8Array>()
  for (const filename of yield* fs.readDirectory(`${builtDirectory}/assets`)) {
    if (/^[A-Za-z0-9_.-]+$/u.test(filename)) assets.set(`/app/assets/${filename}`, yield* fs.readFile(`${builtDirectory}/assets/${filename}`))
  }
  const sha = (bytes: Uint8Array) => crypto.digest("SHA-256", bytes).pipe(Effect.map((hash) => Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")))
  const fingerprints = { index: yield* sha(index), assets: Object.fromEntries(yield* Effect.forEach([...assets].filter(([path]) => /\.(js|css)$/u.test(path)), ([path, bytes]) => sha(bytes).pipe(Effect.map((hash) => [path, hash] as const)))) }
  const mime: Record<string, string> = { js: "text/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf" }
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  let mode: typeof Mode.Type = "success"
  let retainOutput = false
  let generation = 0
  let sequence = 0
  let record = readerRecord
  let rating: "up" | "down" | null = null
  let deleted = false
  let signedOut = false
  const retries = new Map<string, { body: string; response: typeof AcceptedRun.Type }>()
  const logs: Array<{ sequence: number; method: string; path: string; status: number; key?: string; body?: unknown }> = []
  const admissionRefusal = () => mode === "queue-full" || mode === "per-user-active" || mode === "storage-refused" ? admissionRefusals[mode] : null
  const startedAt = readerRecord.latestRun.createdAt
  const failedState = (next: typeof Mode.Type) => {
    const unknown = next === "unknown"
    const permanent = next === "failed-permanent"
    const message = unknown ? "Fixture: the provider may have completed work before the connection was lost."
      : permanent ? "Fixture: the saved provider response failed validation and cannot be retried."
        : "Fixture: the provider was temporarily unavailable."
    const code = unknown ? "provider-unknown-completion" : permanent ? "invalid-provider-response" : "provider-failed"
    return {
      _tag: unknown ? "interrupted" : "failed", finishedAt: startedAt,
      failure: { code, message, retryable: !permanent, stage: "page-check", pageId: null, figureId: null },
    }
  }
  const activeState = (next: typeof Mode.Type) => {
    if (next === "guide-running") return { _tag: "running", startedAt, progress: { stage: "guide", completedUnits: 0, totalUnits: 1 } }
    if (next === "running") return { _tag: "running", startedAt, progress: { stage: "page-check", completedUnits: 1, totalUnits: 3 } }
    return { _tag: "queued" }
  }
  const reset = Effect.fnUntraced(function* (next: typeof Mode.Type, saved: boolean) {
    mode = next
    retainOutput = saved
    generation += 1
    sequence = 0
    rating = null
    deleted = next === "deleted"
    signedOut = next === "unauthorized"
    retries.clear()
    logs.length = 0
    const failure = next === "failed-recoverable" || next === "failed-permanent" || next === "unknown"
    const active = next === "queued" || next === "running" || next === "guide-running" || next === "per-user-active"
    const visible = failure || active
    record = yield* Schema.decodeUnknownEffect(DocumentDetail)({
      ...readerRecord,
      currentRevisionId: visible && !saved ? null : readerRecord.currentRevisionId,
      latestRun: visible
        ? { ...readerRecord.latestRun, id: `qa-fixture-run-${generation}`, state: failure ? failedState(next) : activeState(next) }
        : readerRecord.latestRun,
    })
  })
  const unavailable = (): typeof UploadUnavailable.Type => {
    if (mode === "budget-exhausted") return { code: mode, reason: "Fixture: the processing budget is exhausted. New processing is unavailable." }
    if (mode === "provider-disabled") return { code: mode, reason: "Fixture: the processing provider is disabled. New processing is unavailable." }
    return { code: "fixture-uploads-disabled", reason: "Visual acceptance fixture: uploads are disabled; no files or provider calls are accepted." }
  }
  const policy = (): typeof UploadPolicy.Type => ({
    maxBytes: 50_000_000, maxPages: 50, mediaType: "application/pdf", mode: "fixture",
    availability: admissionRefusal() !== null ? { _tag: "enabled" } : { _tag: "disabled", ...unavailable() },
  })
  const control = () => [
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">`,
    `<title>AmuseMe fixture controls</title>`,
    `<style>body{font:16px system-ui;max-width:1000px;margin:32px auto;padding:0 20px;background:#f3f2ed;color:#20251c}`,
    `button,select{font:inherit;padding:10px;margin:5px}a{margin-right:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:16px}`,
    `label{display:block;margin:16px 0}</style>`,
    `<h1>QA fixture controls: visual only</h1><p>Unchanged compiled product UI. Synthetic data only. No database, real authentication, `,
    `providers, admitted uploads, or passthrough. Never enter real credentials.</p>`,
    `<form method="post" action="/qa/state"><label>Scenario <select name="mode">`,
    `${modes.map((value) => `<option${value === mode ? " selected" : ""}>${value}</option>`).join("")}</select></label>`,
    `<label><input type="checkbox" name="saved" value="yes"${retainOutput ? " checked" : ""}>`,
    ` Keep previous saved output during failed, queued, or running states</label>`,
    `<button>Apply scenario and clear log</button></form><form method="post" action="/qa/reset"><button>Reset to success and clear `,
    `log</button></form>`,
    `<p><a href="${readerPath}?p=1" target="_blank">Open reader</a><a href="/" target="_blank">Open library</a>`,
    `<a href="/qa">Refresh controls/log</a><a href="/qa/logs">JSON log</a></p><p>Current scenario: <strong>${escape(mode)}</strong>`,
    `. Fake retry changes the latest run to queued. Rating and terminal deletion remain in memory. Refresh the product tab after changing `,
    `scenarios.</p>`,
    `<p>Unauthorized shows sign-in. Use qa@example.test and any nonempty dummy password. Fields are not read or logged.</p>`,
    `<p>Admission refusal scenarios enable the chooser. A disposable PDF receives queue-full (429), per-user-active (409), or storage-refused `,
    `(503). The body is never read or stored. Reload the product tab after changing scenarios.</p>`,
    `<h2>Request log</h2><pre>${escape(JSON.stringify(logs, null, 2))}</pre><details><summary>Built candidate fingerprints</summary>`,
    `<pre>${escape(JSON.stringify(fingerprints, null, 2))}</pre></details></html>`,
  ].join("")
  const respond = Effect.fnUntraced(function* (request: Request) {
    const path = new URL(request.url).pathname
    const method = request.method
    if (request.headers.get("host") !== host) return error("forbidden", "Fixture accepts its loopback host only.", 403)
    if (method !== "GET" && request.headers.get("origin") !== origin) return error("forbidden", "Fixture mutations require the exact local origin.", 403)
    if (method === "GET" && path === "/qa") return new Response(control(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
    if (method === "GET" && path === "/qa/health") return json({ fixture: true, origin, fingerprints })
    if (method === "GET" && path === "/qa/logs") return json(logs)
    if (method === "POST" && (path === "/qa/reset" || path === "/qa/state")) {
      const fields = path === "/qa/reset" ? new URLSearchParams() : new URLSearchParams(yield* Effect.tryPromise({ try: () => request.text(), catch: (cause) => new VisualFixtureError({ operation: "read fixture controls", cause }) }))
      const next = path === "/qa/reset" ? "success" : fields.get("mode")
      if (!Schema.is(Mode)(next)) return error("invalid-input", "Unknown fixture state.", 400)
      yield* reset(next, fields.get("saved") === "yes")
      return new Response(null, { status: 303, headers: { location: "/qa" } })
    }
    const asset = assets.get(path)
    if (method === "GET" && asset !== undefined) return new Response(asset, { headers: { "content-type": mime[path.split(".").at(-1) ?? ""] ?? "application/octet-stream", "cache-control": "no-store" } })
    if (method === "GET" && (path === "/" || path === "/sign-in" || path === readerPath)) return new Response(index, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
    const entry: typeof logs[number] = { sequence: ++sequence, method, path, status: 0 }
    const reply = (response: Response) => { entry.status = response.status; logs.push(entry); if (logs.length > 500) logs.shift(); return response }
    if (method === "POST" && path === "/auth/sign-in/email") { signedOut = false; return reply(json({})) }
    if (method === "POST" && path === "/auth/sign-out") { signedOut = true; return reply(json({})) }
    if (signedOut && path.startsWith("/api/")) return reply(error("unauthenticated", "Fixture session is signed out.", 401))
    if (method === "GET" && path === "/api/session") return reply(json({ user: { id: readerRecord.document.ownerId, email: "qa@example.test", role: "user" } }))
    if (mode === "server-error" && path.startsWith("/api/documents")) return reply(error("storage-failed", "Fixture: document storage is temporarily unavailable.", 503))
    if (method === "GET" && path === "/api/documents") return reply(json({ documents: deleted ? [] : [record], upload: policy() } satisfies typeof DocumentList.Type))
    if (method === "POST" && path === "/api/documents") {
      const refusal = admissionRefusal()
      if (refusal !== null) {
        const key = request.headers.get("idempotency-key")
        entry.key = key ?? ""
        if (!Schema.is(IdempotencyKey)(key)) return reply(error("invalid-input", "Invalid fixture upload submission identifier.", 400))
        return reply(json(refusal, errorHttpStatus[refusal.code]))
      }
      const availability = policy().availability
      return reply(error("processing-unavailable", availability._tag === "disabled" ? availability.reason : "Fixture uploads are unavailable.", 503))
    }
    if (!path.startsWith(documentPath)) return reply(error("not-found", "No such fixture route.", 404))
    if (deleted) return reply(error("not-found", "Document not found.", 404))
    if (method === "GET" && path === documentPath) return reply(mode === "document-expired" ? error("expired", "Fixture document has expired before output lookup.", 410) : json(record))
    if (method === "GET" && path === `${documentPath}/status`) return reply(json(record.latestRun))
    if (method === "DELETE" && path === documentPath) {
      if (record.latestRun.state._tag === "queued" || record.latestRun.state._tag === "running") return reply(error("conflict", "Fixture processing must stop before deletion.", 409))
      deleted = true
      return reply(new Response(null, { status: 204 }))
    }
    if (method === "POST" && path === `${documentPath}/retry`) {
      const key = request.headers.get("idempotency-key")
      const input = yield* Schema.decodeUnknownEffect(RetryRequest)(yield* requestJson(request), boundaryParseOptions).pipe(Effect.catch(() => Effect.succeed(null)))
      entry.key = key ?? ""
      entry.body = input
      if (!Schema.is(IdempotencyKey)(key) || input === null) return reply(error("invalid-input", "Invalid fixture retry.", 400))
      const body = JSON.stringify(input)
      const previous = retries.get(key)
      if (previous !== undefined) return reply(previous.body === body ? json(previous.response, 202) : error("conflict", "Fixture key was used for a different request.", 409))
      const state = record.latestRun.state
      if ((state._tag !== "failed" && state._tag !== "interrupted") || !state.failure.retryable || input.previousRunId !== record.latestRun.id || (state.failure.code === "provider-unknown-completion" && !input.acknowledgePossibleRepeatedWork)) return reply(error("conflict", "Fixture run is not eligible for this retry.", 409))
      const response = yield* Schema.decodeUnknownEffect(AcceptedRun)({ documentId: record.document.id, runId: `qa-retry-${generation}` })
      retries.set(key, { body, response })
      record = { ...record, latestRun: { ...record.latestRun, id: yield* Schema.decodeUnknownEffect(RunId)(response.runId), state: { _tag: "queued" } } }
      return reply(json(response, 202))
    }
    if (path.startsWith(`${outputPath}/`)) {
      if (mode === "expired") return reply(error("expired", "Fixture saved output has expired.", 410))
      if (record.currentRevisionId === null) return reply(error("not-found", "Fixture has no published output.", 404))
      if (method === "GET" && path === `${outputPath}/document`) return reply(json(mode === "guide-success" ? guidedCanonical : readerCanonical))
      if (method === "GET" && path === `${outputPath}/report`) return reply(json(mode === "guide-success" ? guidedReport : mode === "no-issues" ? { ...readerReport, issues: [] } : readerReport))
      if (method === "GET" && path === `${outputPath}/text`) return reply(new Response(completeText, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": "attachment; filename=normalized.txt" } }))
      if (method === "GET" && path === `${outputPath}/images/figure-1`) return reply(new Response(png, { headers: { "content-type": "image/png" } }))
      if (path === `${outputPath}/rating`) {
        if (method === "DELETE") { rating = null; return reply(new Response(null, { status: 204 })) }
        if (method === "PUT") {
          const input = yield* Schema.decodeUnknownEffect(RatingRequest)(yield* requestJson(request), boundaryParseOptions).pipe(Effect.catch(() => Effect.succeed(null)))
          entry.body = input
          if (input === null) return reply(error("invalid-input", "Invalid fixture rating.", 400))
          rating = input.value
        }
        if (method === "GET" || method === "PUT") return reply(json({ value: rating }))
      }
    }
    return reply(error("not-found", "Only the declared synthetic fixture routes exist.", 404))
  })
  const runRequest = Effect.runPromiseWith(yield* Effect.context<never>())
  const listener = yield* Effect.acquireRelease(
    Effect.try({ try: () => createAdaptorServer({ fetch: (request) => runRequest(respond(request), { signal: request.signal }), overrideGlobalObjects: false }), catch: (cause) => new VisualFixtureError({ operation: "create fixture listener", cause }) }),
    (server) => Effect.callback<void>((resume) => { server.close(() => resume(Effect.void)); if ("closeAllConnections" in server) server.closeAllConnections() }),
  )
  yield* Effect.callback<void, VisualFixtureError>((resume) => {
    const onError = (cause: Error) => resume(Effect.fail(new VisualFixtureError({ operation: "listen", cause })))
    listener.once("error", onError)
    listener.listen(Number(port), "127.0.0.1", () => resume(Effect.void))
    return Effect.sync(() => { listener.off("error", onError) })
  })
  return { origin, fingerprints, listener, documentPath, outputPath, readerPath }
})

if (import.meta.main) Schema.decodeUnknownEffect(Port)(process.argv[2] ?? "4187").pipe(
  Effect.flatMap((port) => startVisualFixture(port)),
  Effect.tap((fixture) => Effect.log(`Synthetic visual fixture ready at ${fixture.origin}/qa; index SHA-256 ${fixture.fingerprints.index}`)),
  Effect.andThen(Effect.never),
  Effect.scoped,
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)
