import { MineruLimits } from "./contracts.ts"
import { PYMUPDF_VERSION } from "../../pdf/index.ts"

export const MINERU_ARCHIVE_SCRIPT = String.raw`
import hashlib
import importlib.metadata
import io
import json
import os
import re
import resource
import signal
import stat
import subprocess
import sys
import time
import zipfile

LIMITS = json.loads('${JSON.stringify(MineruLimits)}')
MEMORY_BYTES = 1024 ** 3

class Rejected(Exception):
    def __init__(self, code):
        self.code = code

def reject(code="invalid-archive"):
    raise Rejected(code)

def answer(value):
    print(json.dumps(value, allow_nan=False), flush=True)

def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            reject()
        result[key] = value
    return result

def read_json(data):
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=no_duplicates,
                          parse_constant=lambda _: reject())
    except (UnicodeError, ValueError, RecursionError):
        reject()

def run(root):
    try:
        installed = importlib.metadata.version("pymupdf")
        import pymupdf
    except (ImportError, OSError, importlib.metadata.PackageNotFoundError):
        reject("processing-unavailable")
    if sys.version_info[:2] != (3, 14) or installed != "${PYMUPDF_VERSION}":
        reject("processing-unavailable")
    pymupdf.TOOLS.mupdf_display_errors(False)
    pymupdf.TOOLS.mupdf_display_warnings(False)
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    resource.setrlimit(resource.RLIMIT_FSIZE, (LIMITS["maxExpandedBytes"], LIMITS["maxExpandedBytes"]))
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (1024 ** 3, 1024 ** 3))
    source = os.path.join(root, "source.zip")
    size = os.stat(source, follow_symlinks=False)
    if not stat.S_ISREG(size.st_mode) or size.st_mode & 0o077 or size.st_size == 0:
        reject()
    if size.st_size > LIMITS["maxCompressedBytes"]:
        reject("limit-exceeded")
    with open(source, "rb") as stream:
        original = stream.read(LIMITS["maxCompressedBytes"] + 1)
    totals = {"entries": 0, "expanded": 0}
    def inspect(data, nested=False):
        files, manifest, paths, spellings = {}, [], {}, {}
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            totals["entries"] += len(entries)
            if not entries or totals["entries"] > LIMITS["maxEntries"]:
                reject("limit-exceeded")
            for entry in entries:
                name = entry.orig_filename
                directory = entry.is_dir()
                path = name[:-1] if directory else name
                parts = path.split("/")
                kind = stat.S_IFMT(entry.external_attr >> 16)
                key = path.casefold()
                if (not re.fullmatch(r"(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*", path)
                        or entry.flag_bits & 1 or kind not in {0, stat.S_IFREG, stat.S_IFDIR}
                        or (kind == stat.S_IFDIR and not directory) or (kind == stat.S_IFREG and directory)
                        or (directory and entry.file_size) or key in paths
                        or any(paths.get("/".join(parts[:i]).casefold()) is False for i in range(1, len(parts)))
                        or (not directory and any(other.startswith(key + "/") for other in paths))):
                    reject()
                for index in range(1, len(parts) + 1):
                    prefix = "/".join(parts[:index])
                    folded = prefix.casefold()
                    if folded in spellings and spellings[folded] != prefix:
                        reject()
                    spellings[folded] = prefix
                paths[key] = directory
                if totals["expanded"] + entry.file_size > LIMITS["maxExpandedBytes"]:
                    reject("limit-exceeded")
                chunks, length = [], 0
                with archive.open(entry) as member:
                    while chunk := member.read(65536):
                        length += len(chunk)
                        totals["expanded"] += len(chunk)
                        if length > entry.file_size or totals["expanded"] > LIMITS["maxExpandedBytes"]:
                            reject("limit-exceeded")
                        chunks.append(chunk)
                if length != entry.file_size:
                    reject()
                content = b"".join(chunks)
                if directory:
                    manifest.append({"_tag": "directory", "path": path, "byteCount": 0})
                    continue
                is_zip = path.lower().endswith(".zip") or content.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")) or zipfile.is_zipfile(io.BytesIO(content))
                if path.lower().endswith(".pdf") or b"%PDF-" in content[:1024] or (is_zip and (nested or path != "native/mineru.zip")):
                    reject()
                if path == "native/mineru.zip" and (nested or not is_zip):
                    reject()
                if is_zip:
                    native_files, _ = inspect(content, True)
                    files["__native__"] = native_files
                files[path] = content
                manifest.append({"_tag": "file", "path": path, "byteCount": length, "hash": hashlib.sha256(content).hexdigest()})
        return files, manifest
    files, entries = inspect(original)
    required = ["document.md", "document_model.json", "document_middle.json", "document_content_list.json", "document_content_list_v2.json", "native/mineru.zip"]
    if any(name not in files for name in required):
        reject()
    middle_bytes = files["document_middle.json"]
    middle = read_json(middle_bytes)
    if (not isinstance(middle, dict) or middle.get("schema") != "docvortex.middle"
            or middle.get("schema_version") != "2.0" or middle.get("is_full_document") is not True
            or middle.get("metadata", {}).get("producer") != {"name": "mineru", "version": "4.0.12"}):
        reject()
    for name in ["document_model.json", "document_content_list.json", "document_content_list_v2.json"]:
        read_json(files[name])
    native = files["__native__"]
    if any(native.get(original) != files[compatibility] for original, compatibility in [("middle_json.json", "document_middle.json"), ("markdown.md", "document.md"), ("model_output.json", "document_model.json")]):
        reject()
    for name, data in files.items():
        if name.startswith("images/") and native.get(name) != data:
            reject()
    if any(name.startswith("images/") and files.get(name) != data for name, data in native.items()):
        reject()
    references = set()
    pending = [(middle, 0)]
    count = 0
    while pending:
        value, depth = pending.pop()
        count += 1
        if count > LIMITS["maxNodes"] or depth > LIMITS["maxDepth"]:
            reject("limit-exceeded")
        if isinstance(value, dict):
            reference = value.get("image_path")
            if reference is not None:
                if not isinstance(reference, str): reject()
                references.add(reference)
            pending.extend((child, depth + 1) for child in value.values())
        elif isinstance(value, list):
            pending.extend((child, depth + 1) for child in value)
    images = []
    for name in sorted(references):
        data = files.get(name)
        if data is None:
            continue
        if not isinstance(data, bytes) or not data:
            reject()
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            media, extension = "image/png", ".png"
        elif data.startswith(b"\xff\xd8\xff") and data.endswith(b"\xff\xd9"):
            media, extension = "image/jpeg", ".jpeg"
        elif data.startswith(b"RIFF") and data[8:12] == b"WEBP" and int.from_bytes(data[4:8], "little") + 8 == len(data):
            media, extension = "image/webp", ".webp"
        else:
            reject()
        suffix = name.lower().rsplit(".", 1)[-1]
        if suffix not in ({"jpg", "jpeg"} if media == "image/jpeg" else {extension[1:]}):
            reject()
        # Public APIs retain original pixels and report actual raster dimensions,
        # independent of the image's DPI-scaled page rectangle.
        with pymupdf.open(stream=data, filetype=extension[1:]) as image_document:
            if image_document.page_count != 1:
                reject()
            information = image_document[0].get_image_info(hashes=False, xrefs=False)
            if len(information) != 1:
                reject()
            width, height = information[0]["width"], information[0]["height"]
        if width <= 0 or height <= 0:
            reject()
        if width * height > 100_000_000:
            reject("limit-exceeded")
        pixmap = pymupdf.Pixmap(data)
        if pixmap.width != width or pixmap.height != height:
            reject()
        del pixmap
        digest = hashlib.sha256(data).hexdigest()
        images.append({"archivePath": name, "artifact": {"path": "images/" + digest + extension, "mediaType": media, "byteCount": len(data), "hash": digest}})
    destinations = set()
    for image in images:
        destination = image["artifact"]["path"]
        if destination in destinations:
            suffix = len(destinations)
            stem, ext = destination.rsplit(".", 1)
            image["artifact"]["path"] = stem + "-" + str(suffix) + "." + ext
        destinations.add(image["artifact"]["path"])
    def write_fixed(name, data):
        descriptor = os.open(os.path.join(root, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
    write_fixed("middle.json", middle_bytes)
    for index, image in enumerate(images):
        write_fixed("image-" + str(index), files[image["archivePath"]])
    answer({"_tag": "Decoded", "manifest": {"compressedByteCount": len(original), "middlePath": "document_middle.json", "entries": entries, "nativeAssets": images}})

def worker(root):
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        signal.signal(signal.SIGXCPU, lambda signum, frame: reject("limit-exceeded"))
        run(root)
    except Rejected as error:
        answer({"_tag": "Rejected", "code": error.code})
    except MemoryError:
        answer({"_tag": "Rejected", "code": "limit-exceeded"})
    except Exception:
        # Native parser exceptions must never expose provider content or paths.
        answer({"_tag": "Rejected", "code": "invalid-archive"})


def supervise(root):
    if not hasattr(os, "fork"):
        answer({"_tag": "Rejected", "code": "processing-unavailable"})
        return
    pid = os.fork()
    if pid == 0:
        worker(root)
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
            if rss and int(rss) * 1024 > MEMORY_BYTES:
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


supervise(sys.argv[1])
`
