# AmuseMe

AmuseMe turns PDFs into structured documents for people and AI. Upload a paper, read the normalized result, then copy the text or download it with its images and processing report.

A paper can look perfectly readable while its extracted text loses an equation, scrambles a table, or leaves a chart behind. Those gaps matter when you ask an AI to explain the paper. AmuseMe brings the text, structure, and figure context together, with source locations available in the reader and exports.

## From PDF to usable document

1. **Upload a PDF.** AmuseMe extracts its text, layout, and images, then checks the extraction against rendered source pages.
2. **Read the result.** Browse headings, equations, tables, and figures alongside the original PDF. Generated image descriptions are labeled as AI-written.
3. **Take it with you.** Copy the complete normalized text or download a ZIP. A processing report records changes and unresolved issues.

The application has invited accounts, private document libraries, saved processing progress, and downloads tied to a specific output revision. It supports both digital PDFs and scans.

## Where Meta fits

**Meta Muse Spark 1.3 performs the document normalization.** MinerU 4.0.12, running in a separate Modal service, supplies the initial extraction.

| Stage | Muse Spark's role | Reasoning |
|---|---|---|
| Page checking | Compare extracted blocks with the source page image; repair text, equations, and tables; identify split paragraphs | High |
| Document structure | Establish heading hierarchy and resolve paragraph joins using the corrected document | Medium |
| Figure descriptions | Describe each figure using its image and document context | High |

Mastra coordinates the workflow. Effect handles asynchronous work and resources. The final assembly and export are deterministic; model responses are saved for recovery and inspection. The interface uses React, with SQLite and local files holding private application state.

## What the demo shows

We processed all six pages of Guo et al.'s *MFGLib: A Library for Mean-Field Games* (JOSS, 2026; CC BY 4.0). Page 3 was rasterized to exercise extraction from a scanned equation and code page.

Two separate text-only evaluations used the same model and question: one received raw extraction, the other AmuseMe's normalized text. Both answered the mathematical questions correctly. The normalized input also let the model explain how the curves behaved in each figure panel, using the labeled AI-written description. The raw input lacked that visual evidence.

That is the benefit demonstrated on this paper: useful figure context reaches a reader that only receives text. It is one example, not a general accuracy benchmark. The output still contained imperfect code formatting and bibliography punctuation.

## What you download

| File | Contents |
|---|---|
| `normalized.txt` | Text, equations, tables, page and source labels, and image descriptions |
| `document.json` | Structured document with source locations |
| `images.json` | Figure metadata, source mappings, and descriptions |
| `processing-report.json` | Recorded changes, checks, and unresolved issues |
| Image files | Available images from the extraction |

The reader also provides the original PDF. Unavailable images are represented explicitly, and generated descriptions remain distinguishable from the author's captions.

## Run locally

Use **Node 24.19.0**, **pnpm 10.33.0**, and **uv** on macOS or Linux. PDF handling requires Python 3.14 and PyMuPDF 1.28.2; see the [PDF runtime prerequisites](python/README.md).

```sh
pnpm install --frozen-lockfile --strict-peer-dependencies
uv venv --python 3.14 data/python/.venv
uv pip install --python data/python/.venv/bin/python -r python/requirements.txt
cp .env.example .env.local
```

Edit `.env.local` using [.env.example](.env.example). Set a random `BETTER_AUTH_SECRET` of at least 32 characters and the `AMUSEME_INVITE_*` fields for your account. The password must be 12–128 characters. Then build, create the account, and start the app:

```sh
pnpm build
pnpm provision:user
pnpm start
```

Open [localhost:4180](http://127.0.0.1:4180/) and sign in with that account. Public signup is disabled.

New processing is disabled by default. To enable it, configure `META_API_KEY`, your separate MinerU service URL and token, a processing budget, and a stable budget ID in `.env.local`, then set `AMUSEME_PROCESSING_ENABLED=true`. Processing uses the configured external services and can incur charges. Keep the same budget ID and data directory across restarts so spending records remain intact. The [MinerU service source](modal/amuseme_mineru/) is included in this repository.

To explore the interface without provider access, run this after building:

```sh
pnpm exec node tests/manual/visual-server.ts
```

Open [the sample controls](http://127.0.0.1:4187/qa) and choose **Open reader**. This serves the compiled interface with synthetic data; it does not process uploads or make model calls.

## Development

```sh
pnpm check
pnpm test
pnpm build
```

These checks require no live provider credentials or inference. PDF integration tests need the Python environment above and access to `/bin/ps`. For development, `pnpm dev` watches the server; run `pnpm dev:app` in another terminal to rebuild the interface as you edit.

Source is organized under `src/app/` (interface), `src/domain/` (shared schemas), `src/mastra/` (workflow and routes), and `src/paper/` (document processing). Tests live in `tests/`, maintenance tools in `scripts/`, and the standalone [Semantic Scholar utility](cli/semantic-scholar/README.md) in `cli/semantic-scholar/`.

The [experimental Spark extraction command](cli/spark-extraction/README.md) runs a bounded, single-page trial through the existing normalization and export workflow. Its guide covers prerequisites, local inspection and explicitly authorized execution; normal uploads continue to use MinerU.

## Current limits

The current scope is English-language PDFs up to **50 MiB and 50 pages**, with additional document complexity and model context limits. The application runs locally on a single host and retains documents for seven days.

Model corrections can be wrong, including changes to numbers or table structure. Processing reports count changes; they do not certify accuracy. Keep the original available when interpreting a result. Broader document coverage and reconstruction accuracy remain unmeasured.

## Credits

**Document extraction is powered by MinerU.** See the [MinerU and service dependency notices](modal/amuseme_mineru/NOTICE.md). PDF validation and page rendering use PyMuPDF; its [license notices](python/README.md#provenance-and-licenses) are included.

AmuseMe adapts earlier normalization and extraction code into a document dashboard with Meta Muse Spark processing, a source-linked reader, and portable exports.
