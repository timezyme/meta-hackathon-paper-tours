---
name: guide-accuracy-review
description: Independently check a generated AmuseMe reading guide against its source pages and figures. Use after any live paid run, before claiming guide quality, or when asked whether a guide's quotes, numbers or figure descriptions are accurate.
---

# Review guide accuracy independently

The reviewer must be a different agent from the one that ran or tuned the processing. Do not read the runner's self-assessment. Never edit outputs, prompts or ledger rows; record findings only.

## Gather the evidence

Sign in as in [live paid run](../live-paid-run/SKILL.md), then fetch read-only for each document and its succeeded revision:

```sh
B=http://127.0.0.1:4184/api/documents/<id>
curl -s -b $J $B | jq .                                     # revision IDs
curl -s -b $J $B/outputs/<rev>/document -o qa/<review>/document.json
curl -s -b $J $B/outputs/<rev>/zip -o qa/<review>/output.zip
curl -s -b $J $B/original -o qa/<review>/original.pdf
curl -s -b $J $B/outputs/<rev>/images/<figureId> -o qa/<review>/<figureId>.png
```

Render page images from `original.pdf` with the repository's PyMuPDF interpreter (`data/python/.venv/bin/python`) and view them. Keep everything under ignored `qa/`.

## Check every item

1. Each quote occurs verbatim and exactly once in its cited `sourceBlockId`, and that block is on the page the guide cites.
2. Each passage and claim says what the page image shows. Read the page, not only the extracted text.
3. Each figure description matches the figure image: axes, labels, trends, panel count.
4. Numbers, units, signs and comparisons match the source exactly.
5. Each `support.strength` (`strong`, `partial`, `limited`) and each stated limit is justified by the cited sources.

## Report

One row per finding: document, guide item, page, block ID, kind (`error`, `overstatement` or `omission`), the guide text, the source text or image evidence, and severity. State how many items were checked per category and which were not checked. A clean result means no findings among the checked items, not a guarantee.
