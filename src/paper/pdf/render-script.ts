import { PdfLimits, PYMUPDF_VERSION } from "./limits.ts"

export const PdfRenderLimits = {
  dpi: 300,
  maxSidePixels: 3300,
  maxPagePixels: 3300 * 3300,
  maxTotalPixels: 50 * 3300 * 3300,
  maxImageBytes: 32 * 1024 * 1024,
  maxTotalImageBytes: 100 * 1024 * 1024,
  timeoutMs: 120_000,
  cpuSeconds: 60,
  memoryBytes: PdfLimits.memoryBytes,
  maxOutputBytes: PdfLimits.maxOutputBytes,
} as const

export const RENDER_SCRIPT = String.raw`
import hashlib
import importlib.metadata
import json
import math
import os
import signal
import stat
import subprocess
import sys
import time

LIMITS = json.loads('${JSON.stringify(PdfLimits)}')
RENDER = json.loads('${JSON.stringify(PdfRenderLimits)}')


def answer(value):
    print(json.dumps(value, allow_nan=False), flush=True)


class Rejection(Exception):
    def __init__(self, code):
        self.code = code


def reject(code):
    raise Rejection(code)


def private_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        os.close(fd)
        reject("storage-failed")
    return fd


def source_bytes(request):
    fd = os.open(request["privatePath"], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_mode & 0o077:
            reject("storage-failed")
        if before.st_size > LIMITS["maxBytes"]:
            reject("limit-exceeded")
        if before.st_size != request["byteCount"]:
            reject("invalid-input")
        content = source.read(LIMITS["maxBytes"] + 1)
        after = os.fstat(source.fileno())
        if (len(content) != before.st_size or after.st_size != before.st_size
                or after.st_mtime_ns != before.st_mtime_ns
                or hashlib.sha256(content).hexdigest() != request["sourceHash"]):
            reject("invalid-input")
    if not content.startswith(b"%PDF-"):
        reject("unsupported-pdf")
    return content


def render(request):
    if sys.version_info[:3] != (3, 14, 5):
        reject("processing-unavailable")
    try:
        if importlib.metadata.version("pymupdf") != "${PYMUPDF_VERSION}":
            reject("processing-unavailable")
        import pymupdf
    except ImportError:
        reject("processing-unavailable")
    pymupdf.TOOLS.mupdf_display_errors(False)
    pymupdf.TOOLS.mupdf_display_warnings(False)
    os.umask(0o077)
    root = private_directory(request["outputDirectory"])
    try:
        pages_dir = os.open("pages", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        info = os.fstat(pages_dir)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            os.close(pages_dir)
            reject("storage-failed")
    finally:
        os.close(root)
    try:
        with pymupdf.open(stream=source_bytes(request), filetype="pdf") as document:
            if not document.is_pdf:
                reject("unsupported-pdf")
            if document.needs_pass or document.is_encrypted or document.xref_get_key(-1, "Encrypt")[0] != "null":
                reject("encrypted-pdf")
            if document.page_count != request["pageCount"]:
                reject("invalid-input")
            if not 0 < document.page_count <= LIMITS["maxPages"] or document.xref_length() > LIMITS["maxXrefs"]:
                reject("limit-exceeded")
            image_pixels = 0
            for xref in range(1, document.xref_length()):
                if document.xref_get_key(xref, "Subtype") != ("name", "/Image"):
                    continue
                width = document.xref_get_key(xref, "Width")
                height = document.xref_get_key(xref, "Height")
                if width[0] != "int" or height[0] != "int" or min(int(width[1]), int(height[1])) <= 0:
                    reject("unsupported-pdf")
                pixels = int(width[1]) * int(height[1])
                image_pixels += pixels
                if pixels > LIMITS["maxImagePixels"] or image_pixels > LIMITS["maxTotalImagePixels"]:
                    reject("limit-exceeded")
            pages = []
            total_pixels = 0
            total_bytes = 0
            pymupdf.TOOLS.mupdf_warnings(reset=True)
            for index in range(document.page_count):
                page = document.load_page(index)
                width, height = page.rect.width, page.rect.height
                if not all(math.isfinite(v) for v in (width, height)) or min(width, height) <= 0:
                    reject("unsupported-pdf")
                if max(width, height) > LIMITS["maxPageSidePoints"] or width * height > LIMITS["maxPageAreaPoints"]:
                    reject("limit-exceeded")
                zoom = min(RENDER["dpi"] / 72, RENDER["maxSidePixels"] / max(width, height))
                expected_pixels = math.ceil(width * zoom) * math.ceil(height * zoom)
                if expected_pixels > RENDER["maxPagePixels"] or total_pixels + expected_pixels > RENDER["maxTotalPixels"]:
                    reject("limit-exceeded")
                pixmap = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), colorspace=pymupdf.csRGB, alpha=False)
                if max(pixmap.width, pixmap.height) > RENDER["maxSidePixels"]:
                    reject("limit-exceeded")
                total_pixels += pixmap.width * pixmap.height
                if total_pixels > RENDER["maxTotalPixels"]:
                    reject("limit-exceeded")
                dpi = zoom * 72
                pixmap.set_dpi(round(dpi), round(dpi))
                data = pixmap.tobytes("png")
                total_bytes += len(data)
                if len(data) > RENDER["maxImageBytes"] or total_bytes > RENDER["maxTotalImageBytes"]:
                    reject("limit-exceeded")
                name = f"page-{index + 1:03d}.png"
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=pages_dir)
                with os.fdopen(fd, "wb") as output:
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
                pages.append({"pageNumber": index + 1, "width": pixmap.width, "height": pixmap.height,
                    "dpi": dpi, "widthPoints": width, "heightPoints": height, "physicalRotation": page.rotation,
                    "image": {"path": "pages/" + name, "mediaType": "image/png", "byteCount": len(data),
                              "hash": hashlib.sha256(data).hexdigest()}})
                del pixmap, data
            if pymupdf.TOOLS.mupdf_warnings(reset=True):
                reject("unsupported-pdf")
            os.fsync(pages_dir)
            return {"_tag": "Rendered", "pages": pages}
    finally:
        os.close(pages_dir)


def worker(request):
    try:
        try:
            import resource
            resource.setrlimit(resource.RLIMIT_CPU, (RENDER["cpuSeconds"], RENDER["cpuSeconds"] + 1))
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            if sys.platform.startswith("linux"):
                resource.setrlimit(resource.RLIMIT_AS, (RENDER["memoryBytes"], RENDER["memoryBytes"]))
        except (ImportError, OSError, ValueError):
            reject("processing-unavailable")
        signal.signal(signal.SIGXCPU, lambda signum, frame: reject("limit-exceeded"))
        answer(render(request))
    except Rejection as error:
        answer({"_tag": "Rejected", "code": error.code})
    except MemoryError:
        answer({"_tag": "Rejected", "code": "limit-exceeded"})
    except OSError:
        answer({"_tag": "Rejected", "code": "storage-failed"})
    except Exception:
        answer({"_tag": "Rejected", "code": "unsupported-pdf"})


def supervise(request):
    if not hasattr(os, "fork"):
        answer({"_tag": "Rejected", "code": "processing-unavailable"})
        return
    pid = os.fork()
    if pid == 0:
        worker(request)
        os._exit(0)
    finished = False
    try:
        while True:
            result, status = os.waitpid(pid, os.WNOHANG)
            if result:
                finished = True
                if status != 0:
                    answer({"_tag": "Rejected", "code": "limit-exceeded"})
                return
            measurement = subprocess.run(["/bin/ps", "-o", "rss=", "-p", str(pid)], stdout=subprocess.PIPE,
                                         stderr=subprocess.DEVNULL, timeout=1, check=False)
            rss = measurement.stdout.strip()
            if len(rss) > 32:
                reject("processing-unavailable")
            if rss and int(rss) * 1024 > RENDER["memoryBytes"]:
                answer({"_tag": "Rejected", "code": "limit-exceeded"})
                return
            time.sleep(0.05)
    except Exception:
        answer({"_tag": "Rejected", "code": "processing-unavailable"})
    finally:
        if not finished:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(pid, 0)


supervise(json.loads(sys.argv[1]))
`
