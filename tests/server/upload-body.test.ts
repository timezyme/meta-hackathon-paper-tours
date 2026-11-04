import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { parseUpload } from "../../src/server/upload-body.ts"

const requestFor = (form: FormData, key = "upload-key-001") => new Request("http://127.0.0.1:4183/api/documents", {
  method: "POST", headers: { "idempotency-key": key }, body: form,
})
const oneFile = (content = "%PDF-fixture", name = "paper.pdf") => {
  const form = new FormData()
  form.append("file", new File([content], name, { type: "application/octet-stream" }))
  return form
}

describe("bounded multipart upload intake", () => {
  it.effect("preserves actual PDF bytes and the admission key without trusting MIME", () => Effect.gen(function* () {
    const result = yield* parseUpload(requestFor(oneFile("%PDF-α\u0000binary", "研究.pdf")), 100)
    expect(result.filename).toBe("研究.pdf")
    expect(result.idempotencyKey).toBe("upload-key-001")
    expect(new TextDecoder().decode(result.bytes)).toBe("%PDF-α\u0000binary")
  }))

  it.effect("rejects multiple files, forged fields, empty files, and malformed multipart", () => Effect.gen(function* () {
    const multiple = oneFile()
    multiple.append("file", new File(["second"], "second.pdf"))
    const identity = oneFile()
    identity.append("ownerId", "other-user")
    const stringFile = new FormData()
    stringFile.append("file", "not a file")
    for (const form of [multiple, identity, stringFile]) {
      const result = yield* parseUpload(requestFor(form), 100).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.code).toBe("invalid-input")
    }
    const empty = yield* parseUpload(requestFor(oneFile("")), 100).pipe(Effect.result)
    expect(empty._tag).toBe("Failure")
    if (empty._tag === "Failure") expect(empty.failure.code).toBe("empty-document")
    const malformed = new Request("http://127.0.0.1:4183/api/documents", {
      method: "POST", headers: { "idempotency-key": "upload-key-001", "content-type": "multipart/form-data; boundary=missing" }, body: "broken",
    })
    expect((yield* parseUpload(malformed, 100).pipe(Effect.result))._tag).toBe("Failure")
  }))

  it.effect("checks actual file and envelope bytes even when Content-Length lies", () => Effect.gen(function* () {
    const oversized = requestFor(oneFile("x".repeat(101)))
    oversized.headers.set("content-length", "1")
    const result = yield* parseUpload(oversized, 100).pipe(Effect.result)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure.code).toBe("limit-exceeded")
    const envelope = new Request("http://127.0.0.1:4183/api/documents", {
      method: "POST",
      headers: { "idempotency-key": "upload-key-001", "content-type": "multipart/form-data; boundary=fixture", "content-length": "1" },
      body: new Uint8Array(65537 + 100),
    })
    const bodyResult = yield* parseUpload(envelope, 100).pipe(Effect.result)
    expect(bodyResult._tag).toBe("Failure")
    if (bodyResult._tag === "Failure") expect(bodyResult.failure.code).toBe("limit-exceeded")
  }))

  it.effect("rejects invalid submission keys and unsafe display filenames", () => Effect.gen(function* () {
    expect((yield* parseUpload(requestFor(oneFile(), ""), 100).pipe(Effect.result))._tag).toBe("Failure")
    expect((yield* parseUpload(requestFor(oneFile("pdf", "a".repeat(256))), 100).pipe(Effect.result))._tag).toBe("Failure")
    expect((yield* parseUpload(requestFor(oneFile("pdf", "bad\u007fname.pdf")), 100).pipe(Effect.result))._tag).toBe("Failure")
    for (const filename of ["../paper.pdf", "C:\\private\\paper.pdf", "folder/paper.pdf"]) {
      expect((yield* parseUpload(requestFor(oneFile("pdf", filename)), 100).pipe(Effect.result))._tag, filename).toBe("Failure")
    }
  }))

  it.effect("times out a stalled body and cancels its reader", () => Effect.gen(function* () {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true } })
    const init: RequestInit & { duplex: "half" } = {
      method: "POST", headers: { "idempotency-key": "stalled-body", "content-type": "multipart/form-data; boundary=stalled" }, body: stream, duplex: "half",
    }
    const request = new Request("http://127.0.0.1:4183/api/documents", init)
    const fiber = yield* parseUpload(request, 100).pipe(Effect.result, Effect.forkChild)
    yield* TestClock.adjust("20 seconds")
    expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "Failure", failure: { code: "invalid-input", message: "The upload timed out. Try it again." } })
    expect(cancelled).toBe(true)
    expect(stream.locked).toBe(false)
  }))
})
