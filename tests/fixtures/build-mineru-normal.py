"""Synthetic native/compatibility MinerU archive for the existing normal.pdf fixture."""
import io
import json
from pathlib import Path
import zipfile

middle = {
    "schema": "docvortex.middle", "schema_version": "2.0", "is_full_document": True,
    "metadata": {"file_suffix": "pdf", "producer": {"name": "mineru", "version": "4.0.12"},
                 "document": {"page_count": 1, "page_count_kind": "physical"}},
    "extensions": {"docvortex_layout": {"version": 1, "pages": [{"page_idx": 0, "width_pt": 612, "height_pt": 792}]}},
    "pages": [{"page_idx": 0, "blocks": [
        {"index": 0, "type": "doc_title", "bbox": [0.1, 0.1, 0.8, 0.15], "content": [{"type": "text", "content": "A synthetic document"}]},
        {"index": 1, "type": "text", "bbox": [0.1, 0.2, 0.8, 0.25], "content": [{"type": "text", "content": "The result is l2 units."}]},
    ]}],
}
content = json.dumps(middle, separators=(",", ":")).encode()
markdown = b"# A synthetic document\nThe result is l2 units.\n"

def archive(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as stream:
        for name, data in entries.items():
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100600 << 16
            stream.writestr(info, data)
    return output.getvalue()

native = archive({"middle_json.json": content, "markdown.md": markdown, "model_output.json": b"{}"})
Path(__file__).with_name("mineru-normal.zip").write_bytes(archive({
    "document.md": markdown, "document_model.json": b"{}", "document_middle.json": content,
    "document_content_list.json": b"[]", "document_content_list_v2.json": b"[]", "native/mineru.zip": native,
}))
