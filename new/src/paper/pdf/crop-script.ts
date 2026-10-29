import { PYMUPDF_VERSION } from "./limits.ts"
import { PdfRenderLimits } from "./render-script.ts"

export const CROP_SCRIPT = String.raw`
import hashlib
import importlib.metadata
import json
import os
import resource
import stat
import struct
import sys

request=json.loads(sys.argv[1])
created=False
phase="runtime"
try:
    if sys.version_info[:3] != (3,14,5) or importlib.metadata.version("pymupdf") != "${PYMUPDF_VERSION}":
        raise ValueError("runtime")
    resource.setrlimit(resource.RLIMIT_CPU,(10,11))
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS,(${PdfRenderLimits.memoryBytes},${PdfRenderLimits.memoryBytes}))
    import pymupdf
    phase="source"
    fd=os.open(request["privatePath"],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,"rb") as source:
        info=os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size != request["page"]["image"]["byteCount"] or info.st_size > ${PdfRenderLimits.maxImageBytes}:
            raise ValueError("source")
        data=source.read(${PdfRenderLimits.maxImageBytes + 1})
    if len(data)!=info.st_size or hashlib.sha256(data).hexdigest()!=request["page"]["image"]["hash"] or data[:8]!=b"\x89PNG\r\n\x1a\n":
        raise ValueError("source")
    width,height=struct.unpack(">II",data[16:24])
    if (width,height)!=(request["page"]["width"],request["page"]["height"]) or max(width,height)>${PdfRenderLimits.maxSidePixels}:
        raise ValueError("dimensions")
    box=request["box"]
    x,y,w,h=box["x"],box["y"],box["width"],box["height"]
    if not all(isinstance(v,int) for v in (x,y,w,h)) or min(x,y)<0 or min(w,h)<=0 or x+w>width or y+h>height:
        raise ValueError("box")
    source=pymupdf.Pixmap(data)
    if source.n!=3 or source.alpha:
        raise ValueError("pixels")
    phase="crop"
    clipped=pymupdf.Pixmap(pymupdf.csRGB,pymupdf.IRect(x,y,x+w,y+h),False)
    clipped.copy(source,clipped.irect)
    clipped.set_dpi(round(request["page"]["dpi"]),round(request["page"]["dpi"]))
    output=clipped.tobytes("png")
    if len(output)>${PdfRenderLimits.maxImageBytes}:
        raise ValueError("bytes")
    reopened=pymupdf.Pixmap(output)
    if (reopened.width,reopened.height)!=(w,h):
        raise ValueError("crop")
    directory=os.open(os.path.dirname(request["outputPath"]),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        info=os.fstat(directory)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("directory")
        fd=os.open(os.path.basename(request["outputPath"]),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=directory)
        created=True
        with os.fdopen(fd,"wb") as target:
            target.write(output)
            target.flush()
            os.fsync(target.fileno())
        os.fsync(directory)
    finally:
        os.close(directory)
    print(json.dumps({"width":w,"height":h,"byteCount":len(output),"hash":hashlib.sha256(output).hexdigest()}))
except Exception:
    if created:
        os.unlink(request["outputPath"])
    sys.exit(1 if phase=="source" else 2)
`
