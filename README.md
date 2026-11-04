# AmuseMe

Turn a PDF into a reading guide you can check. Every explanation quotes the document, and one click shows that passage on the original page.

**Try it:** https://guided-tours--amuseme-judges.us-east.modal.run. Sign in with any email. There's no password, so upload only documents you're happy to share. Ten examples are ready, and you can upload 3 PDFs of your own. [Demo video](https://github.com/timezyme/meta-hackathon-paper-tours/releases/download/demo-2026-11-02/amuseme-demo.mp4)

## How it works

Meta **Muse Spark 1.3** (`muse-spark-1.3`, Meta Model API) does every model step. It reads each page image, checks its own transcription and figure crops, restores headings, describes figures and writes the guide. Each step is a Mastra agent, and an answer that fails a check goes to a Muse reviewer agent for correction. A guide is published only if every quotation matches its cited passage exactly. No other model is used. The app is TypeScript (React, Mastra, Effect) and is hosted on Modal.

## Built during the hackathon

The first commit, [`fa40c24`](https://github.com/timezyme/meta-hackathon-paper-tours/commit/fa40c24e14e59c31a6abd86fdab8997f44bb515f), is our earlier PDF-to-text foundation as of October 28. It covers page rendering, basic Muse Spark stages, the reader, ZIP export and accounts. [Everything after it](https://github.com/timezyme/meta-hackathon-paper-tours/compare/fa40c24e14e59c31a6abd86fdab8997f44bb515f...main) was built during the hackathon, including the reading guide, the quotation check, the document map, the reviewer agents, figure crop review, parallel processing, the spending guard and the judges' site.

## Run it

You need Python 3.14.5, Node 24.19.0, pnpm 10.33.0 and uv. It's tested on macOS and Linux.

```sh
pnpm install --frozen-lockfile
uv venv --python 3.14.5 data/python/.venv
uv pip install --python data/python/.venv/bin/python -r python/requirements.txt
cp .env.example .env.local    # set BETTER_AUTH_SECRET and the AMUSEME_INVITE_* account
pnpm build && pnpm provision:user && pnpm start    # open http://127.0.0.1:4180
```

To process uploads, also set `META_API_KEY`, `AMUSEME_PROCESSING_BUDGET_USD`, `AMUSEME_BUDGET_ID` and `AMUSEME_PROCESSING_ENABLED=true`. Each document is capped at $30, and a 4-page paper costs about $0.45.

[Testing and limits](VERIFICATION.md) · [Example credits](CREDITS.md) · [License: AGPL-3.0-only](LICENSING.md)
