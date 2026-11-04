import os
from pathlib import Path
import sys

import pymupdf


root = Path(sys.argv[1])
os.umask(0o077)

document = pymupdf.open()
document.new_page(width=612, height=792).insert_text((20, 30), "Synthetic admission fixture 1")
document.save(root / "normal.pdf", no_new_id=True)
document.close()
