# AmuseMe

**Today: humans and agents. Tomorrow: robots and humanoids.**

AmuseMe turns a PDF into a reading guide you can check. Choose a walkthrough, the document's claims and their limits, a document map, or the full text beside the original pages. Every explanation quotes the document exactly, and one click shows that passage on the original page.

Each run also produces a JSON guide for agents, where every claim points to the exact words it rests on.

## Try it

Open **https://guided-tours--amuseme-judges.us-east.modal.run** and sign in with any email. There's no password, and anyone who types that address can open the account. Upload only documents you're happy for others to see. Ten example documents are ready, and you can upload 3 PDFs of your own.

[Demo video](https://github.com/timezyme/meta-hackathon-paper-tours/releases/download/demo-2026-11-02/amuseme-demo.mp4)

## Meta models

- **Muse Spark 1.3** (`muse-spark-1.3`, Meta Model API) does every model step in the app: reading each page image, checking figure crops, fixing transcription errors, restoring headings, describing figures and writing the guide. Each step is a Mastra agent. When an answer fails a check, a Muse reviewer agent corrects it. No other model is used.
- **Muse Wonder 1.0** (`muse-wonder-1.0`) was used by our [Muse command-line tool](new/cli/muse/README.md) to review the demo video's audio and footage.

Before a guide is published, every quotation must match exactly one place in the document. This catches invented quotes. It doesn't prove the explanation is right, so the guide is labeled as AI-written.

## What was built during the hackathon

The starting point was our earlier PDF-to-text [foundation](https://github.com/timezyme/amuseme-foundation), frozen on October 28. It provides page rendering, the basic Muse Spark stages, the Mastra workflow, the clean-text reader, ZIP export and accounts.

Everything else is new: the reading guide, the quotation check, the document map, Muse reviewer agents, figure crop review, parallel processing, the spending guard, library page previews and the judges' site. `new/` holds new files. `changed/` holds edited foundation files, and `diffs/` shows each edit. [NEW-WORK.md](NEW-WORK.md) lists every file.

## Run it

You need Python 3.14.5, Node 24.19.0, pnpm 10.33.0 and uv. It was tested on macOS (Apple silicon) and on Linux (Modal).

```sh
curl -fL https://github.com/timezyme/amuseme-foundation/releases/download/foundation-2026-10-28/foundation.zip -o ../foundation.zip
python3 reconstruct.py reconstruct --candidate . --archive ../foundation.zip --output ../amuseme-app
cp LICENSE LICENSING.md ../amuseme-app/
cd ../amuseme-app
git init
pnpm install --frozen-lockfile --strict-peer-dependencies
uv venv --python 3.14.5 data/python/.venv
uv pip install --python data/python/.venv/bin/python -r python/requirements.txt
cp .env.example .env.local
```

In `.env.local`, set `BETTER_AUTH_SECRET` (at least 32 characters) and the `AMUSEME_INVITE_*` account fields (password 12–128 characters). Then:

```sh
pnpm build
pnpm provision:user
pnpm start
```

Open [127.0.0.1:4180](http://127.0.0.1:4180/) and sign in. `pnpm check` and `pnpm test` need no credentials.

To process uploads, also set `META_API_KEY`, `AMUSEME_PROCESSING_BUDGET_USD`, `AMUSEME_BUDGET_ID` and `AMUSEME_PROCESSING_ENABLED=true`. Uploads are limited to English PDFs of up to 50 MiB and 48 pages, and each document is capped at $30. A 4-page paper costs about $0.45, billed to your key.

## Testing and credits

[VERIFICATION.md](VERIFICATION.md) records what was tested and what wasn't. [CREDITS.md](CREDITS.md) credits the example documents, which are all openly licensed or public domain.

Code is licensed under [AGPL-3.0-only](LICENSING.md).
