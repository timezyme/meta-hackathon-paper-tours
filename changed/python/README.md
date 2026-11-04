# Local PDF runtime

PDF admission accepts Python 3.14.x; render and crop require exactly Python 3.14.5. All three require PyMuPDF 1.28.2. Install this private environment explicitly before starting the app or running PDF integration tests.

```sh
uv venv --python 3.14.5 data/python/.venv
uv pip install --python data/python/.venv/bin/python -r python/requirements.txt
data/python/.venv/bin/python -I -c 'import sys, pymupdf; print(sys.version); print(pymupdf.VersionBind)'
volta run --node 24.19.0 pnpm exec vitest run tests/paper/pdf/admission.test.ts
```

The application receives the absolute path to `data/python/.venv/bin/python` through `PdfInspector.layer({ pythonBin })`. The `data/` directory is ignored. The runtime invokes that executable directly with isolated Python mode, a cleared environment, and a scoped process group. It does not invoke `uv`, install packages, or request network access. POSIX `fork`, CPU limits, and `/bin/ps` are required; Windows is unsupported.

The inspector parses PDF page operations without rendering or OCR. Its 1 GiB RSS threshold is monitored every 50 milliseconds. macOS cannot enforce the Linux address-space limit, so memory may overshoot between samples. The 10-second parent deadline, 5-second worker CPU limit, 64 KiB output bounds, and explicit PDF complexity limits provide separate bounds. Crop checks a hash-verified PNG, applies image size limits and a 10-second CPU limit, and sets an address-space limit on Linux, but has no RSS supervisor or address-space limit on macOS. This is not an operating-system security sandbox or a promise that every hostile PDF is harmless.

The source file `src/paper/pdf/script.ts` embeds the Python code so the server build carries exactly the inspected script. No external script path or filename from the browser controls execution. Later rendering must apply its own output-pixel and archive limits.

## Provenance and licenses

The local service adapts the Effect subprocess, pinned-version check, and JSON-result approach from `src/paper/pdf.ts` in the normalization source at `7579d048356374581dc7bca02691dc6a9a26a769`. The project owner authorized that reuse. The inspected source file had no license header and the source checkout had no root license file. No Apache license is inferred. The new admission, page-tree, resource, and safety checks are AmuseMe-owned code.

The installed PyMuPDF 1.28.2 wheel identifies its license as GNU Affero GPL 3.0 or an Artifex commercial license. Its unmodified notice is retained in [PYMUPDF-COPYING](PYMUPDF-COPYING), and the [versioned upstream license](https://github.com/pymupdf/PyMuPDF/blob/1.28.2/COPYING) is retained in [AGPL-3.0.txt](AGPL-3.0.txt). Deployment and distribution must account for the chosen license; this implementation does not establish a commercial entitlement or resolve those obligations.

Python's runtime is separately installed and not vendored here. It carries the [Python Software Foundation license and notices](https://docs.python.org/3.14/license.html). The PyMuPDF dependency may carry additional bundled third-party notices; preserve the installed wheel's notice files when packaging it.
