# AmuseMe

AmuseMe turns a research PDF into a reading guide you can check. Upload a paper and choose how to read it: a step-by-step walkthrough, the paper's claims with their support and limits, or the full text beside the original pages. Every explanation cites an exact quotation from the paper. One click opens that passage in the clean text or on the original page.

The same run produces a portable document: text, equations, tables, figure crops with AI-written descriptions, and a processing report. You can copy it or download it as a ZIP.

## How Meta Muse Spark is used

Meta Muse Spark 1.3 performs every model step. The host renders pages, validates each structured response, and saves it so recovery never repeats a completed call.

| Stage | What Muse Spark does |
|---|---|
| Page extraction | Transcribes each rendered page into ordered text, equations, tables, code and figure regions |
| Page checking | Compares the extraction with the page image and repairs transcription errors |
| Document structure | Builds the heading hierarchy and joins paragraphs split across pages |
| Figure descriptions | Describes each cropped figure using its image and the surrounding text |
| Reading guide | Writes the overview, walkthrough and claims, citing exact source quotations |

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

Use the release archive above: its manifest pins the exact frozen files. Then follow the reconstructed README for pinned dependencies, build and account setup. Processing new uploads requires a Meta API key and a configured spending allowance. Saved papers stay readable and downloadable without them.

## What has been verified

On November 1, a six-page MFGLib paper with one scanned page went from upload through guide to download. It took 360 seconds and 15 accepted Muse Spark calls. Its guide has five steps, three claims and 33 quote references, and each reference is uniquely located in its source. All overview, step and claim text was reviewed against the paper. Downloaded ZIP, text and original-PDF bytes match their saved hashes. The application passes type, lint and architecture checks, its full test suite and a production build.

That is one paper, not an accuracy benchmark. [VERIFICATION.md](VERIFICATION.md) records each check, its scope and its limits.

## What is new

[NEW-WORK.md](NEW-WORK.md) lists every changed and new file relative to the foundation. [changes.json](changes.json) records the added lines and copy/skip operations; `new/` holds the new files. The foundation is a mixed-origin snapshot that includes earlier document-processing code and some event-era adaptations. It is not a pre-event revision.

Original project code is licensed under [AGPL-3.0-only](LICENSING.md). Third-party notices are preserved.
