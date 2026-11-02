# AmuseMe

**Today: humans and agents. Tomorrow: robots and humanoids.**

AmuseMe turns a PDF into a reading guide you can check. Upload a research paper, a medical article, a court opinion, a class handout or a business brief, and choose how to read it: a step-by-step walkthrough, the document's claims with their support and limits, a document map, or the full text beside the original pages. Every explanation cites an exact quotation. One click opens that passage in the clean text or on the original page.

The same run produces a portable document: text, equations, tables, figure crops with AI-written descriptions, a structured JSON guide and a processing report. People read the guide; agents can use the JSON, where every claim points to the exact words it rests on. A home robot following a manual or a safety sheet will need the same thing. Meta is [reportedly building one](https://www.engadget.com/2303434/meta-reportedly-built-a-humanoid-robot-prototype-that-can-do-household-chores/).

## How Meta Muse Spark is used

Meta Muse Spark 1.3 performs every model step, each through its own Mastra agent inside one durable Mastra workflow. The host renders pages, validates each structured response, and saves it so recovery never repeats a completed call.

| Stage | What Muse Spark does |
|---|---|
| Page extraction | Transcribes each rendered page into ordered text, equations, tables, code and figure regions |
| Figure crop review | Checks each figure crop against the page image and corrects it if needed. A crop it can't confirm is kept with a visible warning |
| Page checking | Compares the extraction with the page image, repairs transcription errors, marks running headers and footers, and joins paragraphs split across pages, even across a running header |
| Document structure | Restores the heading hierarchy |
| Figure descriptions | Describes each cropped figure using its image and the surrounding text |
| Reading guide | Writes the overview, walkthrough and claims, citing exact source quotations |

**Muse review.** When a stage's answer fails validation, a reviewer agent for that stage gets what a human editor would: the page or figure image, the original input, the rejected answer and the exact list of problems. It returns a corrected answer, which is validated again. After two rounds the stage falls back to a safe default that keeps the source text unchanged, so a run finishes instead of failing. Every review is listed in the processing report.

Before a guide is published, every quotation must match exactly one location in its cited source block. This catches invented or misplaced quotes, but it does not prove the explanation is correct, so the interface labels the guide as AI-written.

## Run it

This repository contains the event work. The frozen [foundation](https://github.com/timezyme/amuseme-foundation) it builds on is supplied separately and excluded from the new-work claim. Reconstruct the application with Python 3:

```sh
curl -fL https://github.com/timezyme/amuseme-foundation/releases/download/foundation-2026-10-28/foundation.zip -o ../foundation.zip
python3 reconstruct.py reconstruct --candidate . --archive ../foundation.zip --output ../amuseme-app
cp LICENSE LICENSING.md ../amuseme-app/
cd ../amuseme-app
git init
```

Use the release archive above: its manifest pins the exact frozen files. Then follow the reconstructed README for pinned dependencies, build and account setup. Use Node 24 and exactly Python 3.14.5 (`uv venv --python 3.14.5`); PDF rendering checks the exact Python and PyMuPDF versions. Processing new uploads requires a Meta API key and a configured spending allowance. Each call is priced at its worst case before it is sent and refused if that would exceed its stage's reservation; under the default $30 cap, a document of about 40 pages with five figures fits. Saved documents stay readable and downloadable without them.

## Try it as a judge

Watch the [demo video](https://github.com/timezyme/meta-hackathon-paper-tours/releases/download/demo-2026-11-02/amuseme-demo.mp4) (1:51, captioned stills of the real app), then open **https://stephen-pasco-40042--amuseme-judges.us-east.modal.run** and sign in with your email. There is no password. The seven example documents are shared and read-only. Each judge can also upload 3 PDFs of their own, which are processed live by Muse Spark. This copy runs on Modal with its own $100 processing budget. Its deploy steps are in [docs/runbooks/modal-deploy.md](new/docs/runbooks/modal-deploy.md); these settings are off for local runs.

## What has been verified

Seven documents of five types went from upload through guide to download: three research papers (one with a scanned page, one table-heavy, one figure-heavy), a psychiatry research letter, a US Supreme Court opinion, an EPA class handout and an SBA economics brief. Independent reviews checked every guide quote, table and figure description against the source pages and found no invented facts or wrong numbers; the faults they did find are listed. The application passes type, lint and architecture checks, its full test suite and a production build.

Seven documents are not an accuracy benchmark. [VERIFICATION.md](VERIFICATION.md) records each check, its scope and its limits.

## What is new

[NEW-WORK.md](NEW-WORK.md) lists every changed and new file relative to the foundation. [changes.json](changes.json) records the added lines and copy/skip operations; `new/` holds the new files. The foundation is a mixed-origin snapshot that includes earlier document-processing code and some event-era adaptations. It is not a pre-event revision.

Original project code is licensed under [AGPL-3.0-only](LICENSING.md). Third-party notices are preserved.
