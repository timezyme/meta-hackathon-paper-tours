"""Regenerate owned synthetic PDF fixtures without third-party assets."""

import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).parent
SOURCES = {
    "normal": [["A synthetic document", "The result is 12 units."]],
    "scan": [["SCAN ONLY"]],
    "empty": [[]],
    "ambiguous-math": [["The printed symbol is ambiguous: x1 or xl."]],
    "references": [["References", "[1] Example Author. A fictional source. 2026."]],
    "notes": [["Main text.", "Note 1: Measurement uses invented data."]],
    "cross-page": [["A paragraph starts on this"], ["page and finishes here."]],
    "table": [["Table 1", "Name     Value", "Alpha    12", "Beta     9"]],
    "missing-description": [["Figure 1. A synthetic black square."]],
}


def pdf(pages, scan=False, figure=False):
    objects = [b"", b"", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for lines in pages:
        page_id = len(objects) + 1
        content_id = page_id + 1
        kids.append(f"{page_id} 0 R")
        if scan:
            pixels = bytes(0 if 8 <= y <= 23 and 5 <= x <= 58 and (x // 4 + y // 4) % 2 == 0 else 255 for y in range(32) for x in range(64))
            image_id = content_id + 1
            stream = b"q 256 0 0 128 72 600 cm /Scan Do Q"
            resources = f"<< /XObject << /Scan {image_id} 0 R >> >>"
        else:
            escaped = [line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") for line in lines]
            text = "BT /F1 12 Tf 72 740 Td " + " 0 -20 Td ".join(f"({line}) Tj" for line in escaped) + " ET"
            stream = (text + (" 72 560 100 100 re f" if figure else "")).encode("ascii")
            resources = "<< /Font << /F1 3 0 R >> >>"
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources {resources} /Contents {content_id} 0 R >>".encode())
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")
        if scan:
            objects.append(f"<< /Type /XObject /Subtype /Image /Width 64 /Height 32 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length {len(pixels)} >>\nstream\n".encode() + pixels + b"\nendstream")
    objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[1] = f"<< /Type /Pages /Kids [{' '.join(kids)}] /Count {len(kids)} >>".encode()
    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, value in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{number} 0 obj\n".encode() + value + b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    output.extend("".join(f"{offset:010d} 00000 n \n" for offset in offsets[1:]).encode())
    output.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(output)


metadata = {}
for name, pages in SOURCES.items():
    content = pdf(pages, scan=name == "scan", figure=name == "missing-description")
    (ROOT / f"{name}.pdf").write_bytes(content)
    metadata[name] = {"sha256": hashlib.sha256(content).hexdigest(), "byteCount": len(content), "pageCount": len(pages)}
(ROOT / "sources.json").write_text(json.dumps(metadata, indent=2) + "\n")
