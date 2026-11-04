# Presenting the AmuseMe demo

Use a completed MFGLib run and its saved comparison. Opening an existing result is a replay; describe it that way. Confirm the local application, source document, downloaded output, and saved answers are available before presenting. The [paired result](result.md) records what was observed and its limits.

## Talk track

### 0:00–0:25 · Problem

Show page 3 of the source and then Figure 1 on page 4.

“A paper contains more than paragraphs. Equations, reading order and figures carry evidence. A text-only agent can miss that evidence even when it can read the surrounding prose. AmuseMe turns an uploaded PDF into readable text and images, with source locations and a report of what happened.”

### 0:25–0:50 · Input and processing

Show the upload control without submitting, then open the completed MFGLib document.

“Here is the real six-page paper we processed through this application. It is openly licensed, and we retained its attribution. We rasterized page three to exercise a scanned equation and code page. I’m opening the completed run now, so this is the saved result, not a new live processing run.”

### 0:50–1:20 · Meta’s contribution

Point to the document’s processing information and then its equations and figure description.

“MinerU extracts the document on our separate Modal service. Meta Muse Spark 1.3 then checks text and equations against rendered pages, resolves headings, and writes figure descriptions. The workflow keeps the original source blocks, records provider responses, and assembles the export. Generated descriptions are labeled separately from author captions. These checks can still miss errors; they are not a guarantee of perfect transcription.”

### 1:20–1:45 · Readable output and download

Show the reader’s source page, equation and labeled figure description. Open the actual downloaded `normalized.txt` and bundle contents.

“The result is useful outside this dashboard. The download contains normalized text, unchanged extracted images, the structured document and a processing report. Page and block labels let a downstream reader cite the source. This text is the exact file downloaded through Chrome, verified against the published revision and its hash.”

### 1:45–2:30 · The observed difference

Show the two saved answers beside the source figure. Highlight the raw answer’s limitation and the normalized answer’s two figure bullets.

“We asked the same question in two fresh Codex sessions using the same model and effort. One received original extraction text; one received the exact AmuseMe export. Neither received image pixels or the answer key. Both correctly calculated the rewards: 0.7, minus 0.2 and 1.2. The difference was the figure. The raw answer could identify axes from plotting code, but correctly said it could not verify curve shapes. The normalized answer described the left panel’s oscillating original curve and the right panel’s late upward turn, using the labeled generated description. Those patterns are visible in the source.”

### 2:30–3:00 · Honest close

Show the comparison table, then the processing report’s retained issue.

“That is the result we observed: figure evidence became available to a text-only reader. This is one paper, not an accuracy benchmark. The output still has an unclassified code block and transcription limitations. Meta Muse Spark powers the document processing; Codex was only the downstream consumer. AmuseMe’s value is a portable document that carries more of the paper’s evidence into the next task, with its source and limitations still visible.”

## Rehearsal

1. Use the current verified production build and invited account. Confirm the serving checkout and URL with the manager. Follow [local setup](https://github.com/timezyme/meta-hackathon-paper-tours#run-it); do not start the unguarded Mastra CLI listener. Finish active processing before rehearsal. Do not submit another PDF, retry a run, or clear a receipt to make the demonstration look fresh.
2. Open the completed document and confirm its saved revision against the private preparation manifest. Have source pages 3 and 4, the reader, downloaded text, report, both answers and the [result table](result.md) ready. Keep the separately held [answer key](answer-key.md) out of any downstream prompt.
3. Verify the private evidence still exists under `qa/implementation/demo/`. The source images are `source-page-3.png` and `source-page-4.png`; answers are `raw-answer.md` and `normalized-answer.md`. `download/normalized.txt` must hash to `b0ea44df812077f1955a310f6de40b5859ef7c4000bf4f8b3ef170a3ee0ef4a6`. The raw baseline in `prepared/raw-extraction.txt` must hash to `86e99d6d42ea0872d012cce12a0947c23fa70a5a28037b9ea83e552e051029da`. Use [preparation instructions](preparation.md) if a fresh verification directory is needed; this makes no model calls.
4. Practice each transition with a timer. Keep the comparison visible for the longest segment. Do not scroll through the whole paper or read the full answers aloud. The timings are rehearsal targets, not a measured presentation duration.
5. If the application is unavailable, show the saved source, actual downloaded artifacts and saved answers, explicitly calling them saved evidence. Do not imply that a progress animation, fresh upload or recording is running. If private evidence is absent, stop the evidence portion rather than reconstructing a result.
6. Before sharing, hide account details, local paths, terminal configuration and private administration views. Retain the paper’s author attribution and CC BY 4.0 notice. This guide authorizes no new processing, publication, deployment or recording.

## Optional judge questions

| Question | Short answer |
|---|---|
| What does Meta do? | Meta Muse Spark 1.3 performs page checking at high effort, heading resolution at medium effort and figure description at high effort. MinerU supplies extraction; Modal hosts that separate service. The downstream comparison used fresh Codex Astra xhigh sessions and did not spend the application’s Meta budget. |
| What was held constant? | The uploaded source and extraction run, task, downstream model/effort, prompt wrapper and 500-word answer limit. Both inputs retained page/source labels and contained no image pixels. The raw baseline came from immutable original blocks and captions, without generated descriptions. The normalized input was the exact downloaded export. |
| What improved? | One predeclared source check: panel-specific curve behavior became answerable from the generated figure description. The mathematics was already correct in both answers. This does not establish a general accuracy rate or prove every normalization change helped. |
| How is it organized? | Effect owns I/O and scoped resources. Mastra orders extraction, page checking, headings, figures, assembly and export. Checkpoints refer to private artifacts by hash. Publication validates artifacts and receipts before committing a successful revision. |
| What happens after a timeout? | Saved responses can be reused. MinerU recovery retrieves the same UUID with GET instead of repeating a submission. Unknown completion stays explicit; any eligible retry is bounded and consumes the existing budget. There is no exactly-once billing claim. |
| Are the numbers verified corrections? | No. This report records 18 updated blocks, 20 heading changes and three joins. Those count changes. It also retains an unclassified `code_body` issue. Code comment markers and bibliography punctuation still need source checking. |
| Where are documents kept? | In private local storage for invited owners, with a separate authenticated AmuseMe service on Modal. Seven-day access expiry and cleanup exist; physical remote deletion can lag. Hosting, provider retention and public deployment are separate concerns. See the [Modal runbook](../runbooks/mineru-modal.md). |

## Source and scoring check

Guo et al. (2026), *MFGLib: A Library for Mean-Field Games*, JOSS 11(120), 10137, DOI `10.21105/joss.10137`, CC BY 4.0. Private `source-provenance.json` records original SHA-256 `1e5b47706c0fe2e760439eff536dec9b0c53e363003a4e628f8470df3e936075` and uploaded mixed-scan SHA-256 `c4524cec02675132b4906b4e06721f0bcee5af337425d0dd8bc67a3eb3b3a60f`. Only page 3 was rasterized at 200 dpi; all six pages and visible attribution remain.

An independent worker opened the actual page 3 and page 4 images and read both exact saved answers on October 27, 2026. The six source-check scores in [result.md](result.md) agree with those images. Page 3 shows the three reward equations, action exclusion of 0, deterministic transition and the stated configuration. Page 4 shows the log-scale exploitability plots, left-panel original oscillations and right-panel original late rise. The normalized answer’s endpoints are plausible approximate readings, not exact trace data. The raw answer correctly abstains on unavailable curve shapes. No scoring disagreement was found on those six checks. Final timing, navigation and delivery remain the manager’s rehearsal.
