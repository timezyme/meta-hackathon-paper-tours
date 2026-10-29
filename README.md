# AmuseMe

**Development in progress. This project is unfinished.**

AmuseMe turns PDFs into portable text, equations, tables and images. Readers can compare the result with its source, inspect processing issues and download the normalized document.

## Work in progress

This development checkpoint contains Meta-only processing changes made after a separately frozen October 28 integration. Muse Spark reads rendered pages, checks transcriptions, organizes headings and describes figures. The host validates structured responses, crops figure regions and records their source. Saved responses support recovery without repeating completed model calls.

The separate foundation is a mixed-origin snapshot containing earlier document-processing code **and event-era adaptations**. It is not a pre-event revision, and its contents are excluded from the new-work claim. [NEW-WORK.md](NEW-WORK.md) lists changed and new files; [changes.json](changes.json) records readable additions and line operations without copied context or deleted source.

## Run

The frozen [foundation](https://github.com/timezyme/amuseme-foundation) is supplied separately and excluded from the new-work claim. Download it and reconstruct with Python 3:

```sh
curl -fL https://github.com/timezyme/amuseme-foundation/releases/download/foundation-2026-10-28/foundation.zip -o ../foundation.zip
python3 reconstruct.py reconstruct --candidate . --archive ../foundation.zip --output ../amuseme-app
cp LICENSE LICENSING.md ../amuseme-app/
cd ../amuseme-app
git init
```

Follow the reconstructed README for pinned dependencies, build and account setup. The synthetic reader fixture does not process uploads. Real processing requires a Meta key and a configured spending allowance.

## Observed result

One six-page document completed in 235.749 seconds with 14 accepted Meta calls. Independent review verified four equations, 29 code lines, and a complete two-panel figure crop against the source pixels. The original caption and AI-written description were retained. Two code blocks remained unclassified and were reported as issues; their fenced text was retained. The document had no extracted tables, so live table fidelity was not tested.

In Chrome, the reader survived a restart and the downloaded ZIP's five artifact hashes matched the saved output. These observations concern one document, not a general accuracy guarantee. Original project code is licensed under [AGPL-3.0-only](LICENSING.md); third-party terms remain intact.

[Verification](VERIFICATION.md) records the limited test scope. The premature demo has been withdrawn.
