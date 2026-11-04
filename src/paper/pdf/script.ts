import { PdfLimits, PYMUPDF_VERSION } from "./limits.ts"

export const INSPECTION_SCRIPT = String.raw`
import importlib.metadata
import json
import math
import os
import re
import signal
import stat
import subprocess
import sys
import time

LIMITS = json.loads('${JSON.stringify(PdfLimits)}')


def answer(value):
    print(json.dumps(value, allow_nan=False), flush=True)


class Rejection(Exception):
    def __init__(self, code):
        self.code = code


def reject(code):
    raise Rejection(code)


def page_tree(document):
    visited = set()

    def walk(xref, depth):
        if xref in visited:
            reject("unsupported-pdf")
        visited.add(xref)
        if depth > LIMITS["maxPageTreeDepth"] or len(visited) > LIMITS["maxPageTreeNodes"]:
            reject("limit-exceeded")
        kind = document.xref_get_key(xref, "Type")
        if kind == ("name", "/Page"):
            return [xref]
        if kind != ("name", "/Pages"):
            reject("unsupported-pdf")
        children_type, children = document.xref_get_key(xref, "Kids")
        if children_type != "array" or re.sub(r"\d+\s+\d+\s+R|\s|\[|\]", "", children):
            reject("unsupported-pdf")
        pages = []
        for child, generation in re.findall(r"(\d+)\s+(\d+)\s+R", children):
            pages.extend(walk(int(child), depth + 1))
            if len(pages) > LIMITS["maxPages"]:
                reject("limit-exceeded")
        count_type, count = document.xref_get_key(xref, "Count")
        if count_type != "int" or int(count) != len(pages):
            reject("unsupported-pdf")
        return pages

    kind, root = document.xref_get_key(document.pdf_catalog(), "Pages")
    if kind != "xref":
        reject("unsupported-pdf")
    return walk(int(root.split()[0]), 0)


def inspect(request):
    if sys.version_info[:2] != (3, 14):
        reject("processing-unavailable")
    try:
        if importlib.metadata.version("pymupdf") != "${PYMUPDF_VERSION}":
            reject("processing-unavailable")
        import pymupdf
    except ImportError:
        reject("processing-unavailable")
    pymupdf.TOOLS.mupdf_display_errors(False)
    pymupdf.TOOLS.mupdf_display_warnings(False)
    path = request["privatePath"]
    if not os.path.isabs(path):
        reject("invalid-input")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
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
            if len(content) != before.st_size or after.st_size != before.st_size or after.st_mtime_ns != before.st_mtime_ns:
                reject("invalid-input")
    except OSError:
        reject("storage-failed")
    if not content:
        reject("empty-document")
    if not content.startswith(b"%PDF-"):
        reject("unsupported-pdf")
    with pymupdf.open(stream=content, filetype="pdf") as document:
        if not document.is_pdf:
            reject("unsupported-pdf")
        if document.needs_pass or document.is_encrypted or document.xref_get_key(-1, "Encrypt")[0] != "null":
            reject("encrypted-pdf")
        page_count = document.page_count
        if page_count == 0:
            reject("empty-document")
        if page_count > LIMITS["maxPages"] or document.xref_length() > LIMITS["maxXrefs"]:
            reject("limit-exceeded")
        repaired = document.is_repaired
        pymupdf.TOOLS.mupdf_warnings(reset=True)
        page_xrefs = page_tree(document)
        if len(page_xrefs) != page_count:
            reject("unsupported-pdf")
        image_pixels = 0
        for xref in range(1, document.xref_length()):
            if document.xref_get_key(xref, "Subtype") != ("name", "/Image"):
                continue
            width = document.xref_get_key(xref, "Width")
            height = document.xref_get_key(xref, "Height")
            if width[0] != "int" or height[0] != "int":
                reject("unsupported-pdf")
            pixels = int(width[1]) * int(height[1])
            if int(width[1]) <= 0 or int(height[1]) <= 0:
                reject("unsupported-pdf")
            image_pixels += pixels
            if pixels > LIMITS["maxImagePixels"] or image_pixels > LIMITS["maxTotalImagePixels"]:
                reject("limit-exceeded")
        pages = []
        has_content = False
        for number in range(page_count):
            page = document.load_page(number)
            if page.xref != page_xrefs[number]:
                reject("unsupported-pdf")
            rect = page.rect
            width, height = rect.width, rect.height
            if not all(math.isfinite(value) for value in (rect.x0, rect.y0, rect.x1, rect.y1, width, height)) or min(width, height) <= 0:
                reject("unsupported-pdf")
            if max(width, height) > LIMITS["maxPageSidePoints"] or width * height > LIMITS["maxPageAreaPoints"]:
                reject("limit-exceeded")
            operations = page.get_bboxlog()
            has_content = has_content or bool(operations) or page.first_annot is not None or page.first_widget is not None
            pages.append({"pageNumber": number + 1, "widthPoints": width, "heightPoints": height, "rotation": page.rotation})
        if pymupdf.TOOLS.mupdf_warnings(reset=True):
            reject("unsupported-pdf")
        if not has_content:
            reject("empty-document")
        return {"_tag": "Inspected", "pageCount": page_count, "pages": pages, "repaired": repaired}


def worker(request):
    try:
        try:
            import resource
            resource.setrlimit(resource.RLIMIT_CPU, (LIMITS["cpuSeconds"], LIMITS["cpuSeconds"] + 1))
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            if sys.platform.startswith("linux"):
                resource.setrlimit(resource.RLIMIT_AS, (LIMITS["memoryBytes"], LIMITS["memoryBytes"]))
        except (ImportError, OSError, ValueError):
            reject("processing-unavailable")
        signal.signal(signal.SIGXCPU, lambda signum, frame: reject("limit-exceeded"))
        answer(inspect(request))
    except Rejection as error:
        answer({"_tag": "Rejected", "code": error.code})
    except MemoryError:
        answer({"_tag": "Rejected", "code": "limit-exceeded"})
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
            measurement = subprocess.run(["/bin/ps", "-o", "rss=", "-p", str(pid)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=1, check=False)
            rss = measurement.stdout.strip()
            if len(rss) > 32:
                reject("processing-unavailable")
            if rss and int(rss) * 1024 > LIMITS["memoryBytes"]:
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
