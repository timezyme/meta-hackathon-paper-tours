# AmuseMe

**Today: humans and agents. Tomorrow: robots and humanoids.**

AmuseMe turns a PDF into a reading guide you can check. Upload a research paper, a medical article, a court opinion, a class handout or a business brief, and choose how to read it: a step-by-step walkthrough, the document's claims with their support and limits, a document map, or the full text beside the original pages. Every explanation cites an exact quotation. One click opens that passage in the clean text or on the original page.

The same run produces a portable document: text, equations, tables, figure crops with AI-written descriptions, a structured JSON guide and a processing report. People read the guide; agents can use the JSON, where every claim points to the exact words it rests on. A home robot following a manual or a safety sheet will need the same thing. Meta is [reportedly building one](https://www.engadget.com/2303434/meta-reportedly-built-a-humanoid-robot-prototype-that-can-do-household-chores/).

## How Meta Muse Spark is used

Meta Muse Spark 1.3 (`muse-spark-1.3`, called through the Meta Model API at api.meta.ai) performs every model step, each through its own Mastra agent inside one durable Mastra workflow. The app calls no other model. Outside the app, the repository's Muse command-line tool ([new/cli/muse/](new/cli/muse/README.md)) calls Muse Spark 1.3 and Muse Wonder 1.0 (`muse-wonder-1.0`, same API). We used it to check narration audio and review the demo video. The host renders pages, validates each structured response, and saves it so recovery never repeats a completed call.

| Stage | What Muse Spark does |
|---|---|
| Page extraction | Transcribes each rendered page into ordered text, equations, tables, code and figure regions |
| Figure crop review | Checks each figure crop against the page image and corrects it if needed. When it can't confirm its correction, the published crop covers both the first box and the correction, and carries a visible warning |
| Page checking | Compares the extraction with the page image, repairs transcription errors, marks running headers and footers, and joins paragraphs split across pages, even across a running header |
| Document structure | Restores the heading hierarchy |
| Figure descriptions | Describes each cropped figure using its image and the surrounding text |
| Reading guide | Writes the overview, walkthrough and claims, citing exact source quotations |

**Muse review.** When a stage's answer fails validation, a reviewer agent for that stage gets what a human editor would: the page or figure image, the original input, the rejected answer and the exact list of problems. It returns a corrected answer, which is validated again. After two rounds the stage falls back to a safe default that keeps the source text unchanged, so a run finishes instead of failing. Every review is listed in the processing report.

Before a guide is published, every quotation must match exactly one location in its cited source block. This catches invented or misplaced quotes, but it does not prove the explanation is correct, so the interface labels the guide as AI-written.

## Run it

This repository contains the event work. The frozen [foundation](https://github.com/timezyme/amuseme-foundation) it builds on is supplied separately and excluded from the new-work claim. You need Python 3, Node 24.19.0, pnpm 10.33.0 and uv. Rebuild the application, then install it:

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

In `.env.local`, set `BETTER_AUTH_SECRET` to a random value of at least 32 characters and fill in the `AMUSEME_INVITE_*` fields for your account; the password must be 12–128 characters. Then build, create the account and start the app:

```sh
pnpm build
pnpm provision:user
pnpm start
```

Open [127.0.0.1:4180](http://127.0.0.1:4180/) and sign in with that account. `pnpm check` and `pnpm test` need no credentials.

Use the release archive above: its manifest pins the exact frozen files. PDF rendering requires exactly Python 3.14.5 and PyMuPDF 1.28.2. It was developed and tested on macOS (Apple silicon); the judge copy runs on Linux in a Modal container (`deploy/modal/`). Windows is untested.

Processing new uploads is off until you set `META_API_KEY`, `AMUSEME_PROCESSING_BUDGET_USD`, a stable `AMUSEME_BUDGET_ID` and `AMUSEME_PROCESSING_ENABLED=true` in `.env.local`. It sends the document to Meta and is billed to your key. Before each call, the app reserves its worst-case price and refuses the call if that would exceed the document's $30 cap or the budget. When Meta answers, the reservation is replaced by the price of the tokens Meta reports. Uploads are limited to English PDFs of up to 50 MiB and 50 pages; under the $30 cap, a document of about 40 pages with five figures fits. Saved documents stay readable and downloadable without a key.

## Try it as a judge

Watch the [demo video](https://github.com/timezyme/meta-hackathon-paper-tours/releases/download/demo-2026-11-02/amuseme-demo.mp4) (1:51, captioned stills of the real app), then open **https://guided-tours--amuseme-judges.us-east.modal.run** and sign in with your email. There is no password. The ten example documents are shared and read-only. Each judge can also upload 3 PDFs of their own, which are processed live by Muse Spark. This copy runs on Modal with its own $100 processing budget. Its deploy steps are in [docs/runbooks/modal-deploy.md](new/docs/runbooks/modal-deploy.md); these settings are off for local runs.

## What has been verified

Ten documents of seven types went from upload through guide to download:
- four research papers: one with a scanned page, one table-heavy, one figure-heavy and one code-heavy;
- a psychiatry research letter;
- a US Supreme Court opinion;
- an EPA class handout;
- an SBA economics brief;
- a NASA classroom activity;
- a scanned 1961 patent.

Independent reviews checked every guide quote, table and figure description against the source pages. Every quote matched its cited source exactly. The faults they found, such as an overstated claim and a misread axis range, are listed, along with one document (a safety sheet with misplaced figure crops) that was left out. The application passes type, lint and architecture checks, its full test suite and a production build.

Ten documents are not an accuracy benchmark. [VERIFICATION.md](VERIFICATION.md) records each check, its scope and its limits.

## Example documents

The ten shared examples are openly licensed or public domain:
- Longman et al., "Flooding, displacement, peritraumatic experience and disaster-related PTSD in northern New South Wales", *Aust N Z J Psychiatry* (2023), [doi:10.1177/00048674231203901](https://doi.org/10.1177/00048674231203901), CC BY 4.0
- Hartzer and Saripalli, "EKF_CAL: Extended Kalman Filter-based Calibration and Localization", *JOSS* (2025), [doi:10.21105/joss.07793](https://doi.org/10.21105/joss.07793), CC BY 4.0
- Kamath et al., "SOLWEIG-GPU: GPU-Accelerated Thermal Comfort Modeling Framework for Urban Digital Twins", *JOSS* (2026), [doi:10.21105/joss.09535](https://doi.org/10.21105/joss.09535), CC BY 4.0
- Guo et al., "MFGLib: A Library for Mean-Field Games", *JOSS* (2026), [doi:10.21105/joss.10137](https://doi.org/10.21105/joss.10137), CC BY 4.0
- Elsner, "Taming the Panda with Python", [arXiv:2307.07633](https://arxiv.org/abs/2307.07633), CC BY 4.0
- *Doe v. Dynamic Physical Therapy, LLC*, 607 U.S. 11 (2025); US EPA, *Half-Life: Teacher Answer Key* (EPA 402-B-19-055); SBA Office of Advocacy, *Critical Condition: The Poor Prognosis for Private Practices* (2026): US government works
- NASA Marshall, "3-2-1 Pop!", *Adventures in Rocket Science* (EG-2007-12-179-MSFC): NASA work, public domain
- US Patent 3,005,282, "Toy building brick" (1961): patent text and drawings, generally not subject to copyright

## What is new

[NEW-WORK.md](NEW-WORK.md) lists every changed and new file relative to the foundation. [changes.json](changes.json) records the added lines and copy/skip operations; `new/` holds the new files. The foundation is a mixed-origin snapshot that includes earlier document-processing code and some event-era adaptations. It is not a pre-event revision.

Original project code is licensed under [AGPL-3.0-only](LICENSING.md). Third-party notices are preserved.
