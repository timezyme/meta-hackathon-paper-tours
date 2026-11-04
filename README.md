# AmuseMe

Turn a PDF into a reading guide you can check. Every explanation quotes the document, and one click shows that passage on the original page.

**Try it:** https://guided-tours--amuseme-judges.us-east.modal.run. Sign in with any email. There's no password, so upload only documents you're happy to share. Ten examples are ready, and you can upload 3 PDFs of your own. [Demo video](https://youtu.be/OYrDeTHN2HE)

## How it works

Meta **Muse Spark 1.3** (`muse-spark-1.3`, Meta Model API) does every model step, and no other model is used. Reviewer agents correct answers that fail a check. A guide is published only if every quotation matches its cited passage exactly. The app is TypeScript (React, Mastra, Effect), hosted on Modal.

## Built during the hackathon

Everything after the October 28 foundation, [`fa40c24`](https://github.com/timezyme/meta-hackathon-paper-tours/commit/fa40c24e14e59c31a6abd86fdab8997f44bb515f), was built during the hackathon. See [NEW-WORK.md](NEW-WORK.md) and the [full diff](https://github.com/timezyme/meta-hackathon-paper-tours/compare/fa40c24e14e59c31a6abd86fdab8997f44bb515f...main).

## Run it

You need Python 3.14.5, Node 24.19.0, pnpm 10.33.0 and uv.

```sh
pnpm install --frozen-lockfile
uv venv --python 3.14.5 data/python/.venv
uv pip install --python data/python/.venv/bin/python -r requirements.txt
cp .env.example .env.local    # set BETTER_AUTH_SECRET and the AMUSEME_INVITE_* account
pnpm build && pnpm provision:user && pnpm start    # open http://127.0.0.1:4180
```

To process uploads, also set `META_API_KEY` and the processing and budget variables in `.env.example`. A 4-page paper costs about $0.45.

[Example credits](CREDITS.md) · [License: AGPL-3.0-only](LICENSE)
