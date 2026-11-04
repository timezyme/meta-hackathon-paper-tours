import { PYMUPDF_VERSION } from "./limits.ts"

export const PYTHON_PREAMBLE = String.raw`
import importlib.metadata
import json
import os
import sys


def answer(value):
    print(json.dumps(value, allow_nan=False), flush=True)


class Rejection(Exception):
    def __init__(self, code):
        self.code = code


def reject(code):
    raise Rejection(code)


def pinned_pymupdf():
    if sys.version_info[:3] != (3, 14, 5):
        reject("processing-unavailable")
    try:
        if importlib.metadata.version("pymupdf") != "${PYMUPDF_VERSION}":
            reject("processing-unavailable")
        import pymupdf
    except ImportError:
        reject("processing-unavailable")
    return pymupdf


def limit_resources(cpu_seconds, memory_bytes):
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        if sys.platform.startswith("linux"):
            resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
    except (ImportError, OSError, ValueError):
        reject("processing-unavailable")


def private_directory(path, dir_fd=None, code="storage-failed"):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)
    info = os.fstat(fd)
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        os.close(fd)
        reject(code)
    return fd


def write_private(directory, name, data):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        os.unlink(name, dir_fd=directory)
        raise
`
