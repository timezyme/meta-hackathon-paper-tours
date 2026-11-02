import { PdfRenderLimits } from "./render-script.ts"
import { PYTHON_PREAMBLE } from "./script-preamble.ts"

export const CROP_SCRIPT = String.raw`${PYTHON_PREAMBLE}
import hashlib
import stat
import struct

MAX_IMAGE_BYTES = ${PdfRenderLimits.maxImageBytes}
MAX_SIDE_PIXELS = ${PdfRenderLimits.maxSidePixels}


def source_png(request):
    expected = request["page"]["image"]
    fd = os.open(request["privatePath"], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077
                or info.st_size != expected["byteCount"] or info.st_size > MAX_IMAGE_BYTES):
            reject("invalid-input")
        data = source.read(MAX_IMAGE_BYTES + 1)
    if len(data) != info.st_size or hashlib.sha256(data).hexdigest() != expected["hash"] or data[:8] != b"\x89PNG\r\n\x1a\n":
        reject("invalid-input")
    return data


def crop(request, state):
    limit_resources(10, ${PdfRenderLimits.memoryBytes})
    pymupdf = pinned_pymupdf()
    state["phase"] = "source"
    data = source_png(request)
    width, height = struct.unpack(">II", data[16:24])
    if (width, height) != (request["page"]["width"], request["page"]["height"]) or max(width, height) > MAX_SIDE_PIXELS:
        reject("invalid-input")
    box = request["box"]
    x, y, w, h = box["x"], box["y"], box["width"], box["height"]
    if not all(isinstance(v, int) for v in (x, y, w, h)) or min(x, y) < 0 or min(w, h) <= 0 or x + w > width or y + h > height:
        reject("invalid-input")
    source = pymupdf.Pixmap(data)
    if source.n != 3 or source.alpha:
        reject("invalid-input")
    state["phase"] = "crop"
    clipped = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(x, y, x + w, y + h), False)
    clipped.copy(source, clipped.irect)
    clipped.set_dpi(round(request["page"]["dpi"]), round(request["page"]["dpi"]))
    output = clipped.tobytes("png")
    if len(output) > MAX_IMAGE_BYTES:
        reject("processing-unavailable")
    reopened = pymupdf.Pixmap(output)
    if (reopened.width, reopened.height) != (w, h):
        reject("processing-unavailable")
    directory = private_directory(os.path.dirname(request["outputPath"]), code="processing-unavailable")
    try:
        write_private(directory, os.path.basename(request["outputPath"]), output)
        state["created"] = True
        os.fsync(directory)
    finally:
        os.close(directory)
    return {"_tag": "Cropped", "width": w, "height": h, "byteCount": len(output), "hash": hashlib.sha256(output).hexdigest()}


def main(request):
    state = {"phase": "runtime", "created": False}
    try:
        answer(crop(request, state))
    except Exception as error:
        if state["created"]:
            os.unlink(request["outputPath"])
        if isinstance(error, Rejection):
            code = error.code
        else:
            code = "invalid-input" if state["phase"] == "source" else "processing-unavailable"
        answer({"_tag": "Rejected", "code": code})


main(json.loads(sys.argv[1]))
`
