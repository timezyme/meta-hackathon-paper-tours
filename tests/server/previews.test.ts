import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Clock, Deferred, Effect, Fiber, FileSystem, Layer, Path, Schema } from "effect"
import { AuthService } from "../../src/auth/index.ts"
import { Session } from "../../src/domain/index.ts"
import { PdfInspector, PdfRenderer, RenderedPdfPage, type PdfInspection } from "../../src/paper/pdf/index.ts"
import { DocumentHandler, type PreviewQueue } from "../../src/server/documents.ts"
import { DocumentStore, makeDocumentStoreLayer } from "../../src/storage/index.ts"
import { directory, owner, setup } from "../fixtures/published-output.ts"

const origin = "http://127.0.0.1:4186"
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const busyMessage = "Another original page is loading. Try again shortly."
const busy = { status: 429, body: { code: "queue-full", message: busyMessage } }
const inspection = { pageCount: 1, pages: [], repaired: false } as unknown as PdfInspection

const fixture = Effect.fnUntraced(function* (render: Effect.Effect<void>, previewQueue?: PreviewQueue) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { dataDirectory } = yield* directory
  const stores = yield* Layer.build(makeDocumentStoreLayer({ dataDirectory, queueLimit: 10 }))
  return yield* Effect.gen(function* () {
    const state = yield* setup(dataDirectory)
    const user = { id: owner, role: "user", email: "owner@example.test" }
    const session = yield* Schema.decodeUnknownEffect(Session)({ user })
    const page = yield* Schema.decodeUnknownEffect(RenderedPdfPage)({
      pageNumber: 1, width: 1, height: 1, dpi: 72, widthPoints: 1, heightPoints: 1, physicalRotation: 0,
      image: { path: "page-1.png", mediaType: "image/png", byteCount: png.byteLength, hash: "0".repeat(64) },
    })
    const counts = { started: 0, running: 0, mostAtOnce: 0 }
    const renderer = PdfRenderer.of({
      crop: () => Effect.die("Previews never crop"),
      render: (input) => Effect.gen(function* () {
        counts.started += 1
        counts.running += 1
        counts.mostAtOnce = Math.max(counts.mostAtOnce, counts.running)
        yield* render
        yield* fs.writeFile(path.join(input.outputDirectory, page.image.path), png).pipe(Effect.orDie)
        return [page]
      }).pipe(Effect.ensuring(Effect.sync(() => { counts.running -= 1 }))),
    })
    const auth = AuthService.of({
      getSession: () => Effect.succeed(session),
      handle: () => Effect.succeed(new Response(null, { status: 404 })),
    })
    const handler = yield* DocumentHandler.pipe(Effect.provide(DocumentHandler.layer({
      origin, temporaryDirectory: path.join(dataDirectory, "uploads"), previewQueue,
      admissionConfiguration: { _tag: "live", pipelineVersion: "live-1", configuration: state.claim.run.configuration },
    }).pipe(Layer.provide(Layer.mergeAll(
      Layer.succeed(AuthService, auth), Layer.succeed(DocumentStore, state.documents),
      Layer.succeed(PdfRenderer, renderer),
      Layer.succeed(PdfInspector, { inspect: () => Effect.succeed(inspection) }),
    )))))
    const id = state.claim.document.id
    const url = `${origin}/api/documents/${id}/preview?page=1`
    const preview = (signal?: AbortSignal) => handler.handle("preview", new Request(url, {
      headers: { cookie: "owner", origin }, ...(signal === undefined ? {} : { signal }),
    }), id)
    const answer = (signal?: AbortSignal) => preview(signal).pipe(Effect.flatMap((response) =>
      response.headers.get("content-type") === "image/png"
        ? Effect.succeed({ status: response.status, body: null })
        : Effect.promise(() => response.json()).pipe(
          Effect.map((body: unknown) => ({ status: response.status, body })),
        )))
    return { preview, answer, counts }
  }).pipe(Effect.provide(stores))
})

const waitUntil = Effect.fnUntraced(function* (condition: () => boolean) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) yield* Effect.sleep("5 millis")
  expect(condition()).toBe(true)
})

describe("original page previews", () => {
  it.live("renders ten concurrent library covers one at a time and answers all of them", () => Effect.gen(function* () {
    const f = yield* fixture(Effect.sleep("30 millis"))
    const responses = yield* Effect.forEach(Array.from({ length: 10 }), () => f.preview(), { concurrency: "unbounded" })
    expect(responses.map((response) => response.status)).toEqual(Array.from({ length: 10 }, () => 200))
    for (const response of responses) {
      expect(new Uint8Array(yield* Effect.promise(() => response.arrayBuffer()))).toEqual(png)
    }
    expect(f.counts).toMatchObject({ started: 10, mostAtOnce: 1 })
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { timeout: 10000 })

  it.live("turns away only the requests that find every waiting place taken", () => Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const f = yield* fixture(Deferred.await(gate), { waiting: 2, wait: "10 seconds" })
    const admitted = yield* Effect.forEach(Array.from({ length: 3 }), () => f.answer().pipe(Effect.forkChild))
    yield* waitUntil(() => f.counts.started === 1)
    expect(yield* f.answer()).toEqual(busy)
    yield* Deferred.succeed(gate, undefined)
    expect((yield* Fiber.joinAll(admitted)).map((result) => result.status)).toEqual([200, 200, 200])
    expect(f.counts).toMatchObject({ started: 3, mostAtOnce: 1 })
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { timeout: 10000 })

  it.live("gives up on a wait past its deadline but never cuts a started render", () => Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const f = yield* fixture(Deferred.await(gate), { waiting: 2, wait: "100 millis" })
    const first = yield* f.answer().pipe(Effect.forkChild)
    yield* waitUntil(() => f.counts.started === 1)
    const asked = yield* Clock.currentTimeMillis
    expect(yield* f.answer()).toEqual(busy)
    expect((yield* Clock.currentTimeMillis) - asked).toBeGreaterThanOrEqual(90)
    yield* Effect.sleep("100 millis")
    yield* Deferred.succeed(gate, undefined)
    expect((yield* Fiber.join(first)).status).toBe(200)
    expect(f.counts.started).toBe(1)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { timeout: 10000 })

  it.live("leaves the queue and never renders when the client goes away while waiting", () => Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const f = yield* fixture(Deferred.await(gate), { waiting: 1, wait: "10 seconds" })
    const first = yield* f.answer().pipe(Effect.forkChild)
    yield* waitUntil(() => f.counts.started === 1)
    const client = new AbortController()
    const abandoned = yield* f.preview(client.signal).pipe(Effect.forkChild)
    yield* Effect.sleep("20 millis")
    expect(yield* f.answer()).toEqual(busy)
    client.abort()
    yield* Fiber.await(abandoned)
    const next = yield* f.answer().pipe(Effect.forkChild)
    yield* Deferred.succeed(gate, undefined)
    expect((yield* Fiber.join(first)).status).toBe(200)
    expect((yield* Fiber.join(next)).status).toBe(200)
    expect(f.counts.started).toBe(2)
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), { timeout: 10000 })
})
