import { Crypto, Effect, FileSystem, Path, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const LOCK_SCRIPT = String.raw`
import errno, json, os, stat, sys

def answer(status):
    print(json.dumps({"status":status}), flush=True)

try:
    import fcntl
    root=os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info=os.fstat(root)
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError("unsafe root")
    descriptor=os.open('.amuseme-process.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=root)
    info=os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
        raise ValueError("unsafe lock file")
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        if error.errno in (errno.EACCES, errno.EAGAIN):
            answer("busy")
            sys.exit(2)
        raise
    current=os.stat('.amuseme-process.lock', dir_fd=root, follow_symlinks=False)
    if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
        raise ValueError("lock path changed")
    record=json.dumps({"parentPid":os.getppid(),"holderPid":os.getpid(),"token":sys.argv[2]}).encode()
    os.ftruncate(descriptor, 0)
    os.write(descriptor, record)
    os.fsync(descriptor)
    os.fsync(root)
    answer("locked")
    while sys.stdin.buffer.read(1):
        pass
except (ImportError, AttributeError):
    answer("unavailable")
    sys.exit(3)
except (OSError, ValueError):
    answer("unsafe")
    sys.exit(4)
`

export class ProcessLockError extends Schema.TaggedError<ProcessLockError>()("ProcessLockError", {
  reason: Schema.Literals(["busy", "unsafe", "unavailable", "lost"]),
  message: Schema.String,
}) {}
const failure = (reason: ProcessLockError["reason"]) => new ProcessLockError({ reason, message: {
  busy: "Another AmuseMe process owns this data directory",
  unsafe: "The AmuseMe process lock requires a private owned directory and regular lock file",
  unavailable: "Exclusive local process locking is unavailable",
  lost: "The exclusive AmuseMe process lock was lost; stopping application work",
}[reason] })
const Handshake = Schema.Struct({ status: Schema.Literals(["locked", "busy", "unsafe", "unavailable"]) })

export interface ProcessLockOptions {
  readonly dataDirectory: string
  readonly pythonBin: string
}

const acquire = Effect.fn("ProcessLock.acquire")(function* (options: ProcessLockOptions) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  if (!path.isAbsolute(options.dataDirectory) || !path.isAbsolute(options.pythonBin)) return yield* failure("unsafe")
  yield* fs.makeDirectory(options.dataDirectory, { recursive: true, mode: 0o700 })
  const root = yield* fs.realPath(options.dataDirectory)
  const token = yield* crypto.randomUUIDv4()
  const process = yield* spawner.spawn(ChildProcess.make(options.pythonBin, ["-I", "-c", LOCK_SCRIPT, root, token], {
    stdin: "pipe", stdout: "pipe", stderr: "ignore", env: {}, extendEnv: false, forceKillAfter: "100 millis",
  }))
  let received = 0
  const lines = yield* process.stdout.pipe(Stream.mapEffect((bytes) => {
    received += bytes.byteLength
    return received <= 256 ? Effect.succeed(bytes) : Effect.fail(failure("unavailable"))
  }), Stream.decodeText(), Stream.splitLines, Stream.take(1), Stream.runCollect)
  const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Handshake))(lines[0], { onExcessProperty: "error" })
  if (result.status !== "locked") return yield* failure(result.status)
  return process
}, (effect) => effect.pipe(
  Effect.mapError((error) => error._tag === "ProcessLockError" ? error : failure("unavailable")),
  Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(failure("unavailable")) }),
))

export const withProcessLock = Effect.fn("withProcessLock")(function* <A, E, R>(options: ProcessLockOptions, application: Effect.Effect<A, E, R>) {
  const process = yield* acquire(options)
  const lost = process.exitCode.pipe(Effect.mapError(() => failure("lost")), Effect.andThen(Effect.fail(failure("lost"))))
  return yield* Effect.raceFirst(application, lost)
}, Effect.scoped)
