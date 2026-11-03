# Verification and limits

## Submission syncs to application commits `38fd2f8` and `76f7d43` — November 3, 2026

The submission was regenerated twice on November 3: first from application commit `38fd2f8` (pushed as `563e307`), then from `76f7d43` (pushed as `546a453`). Together they add:
- the hosted-copy fixes and the real-cost charging described below;
- the single README, which replaces the application's own README with a pointer to this one;
- a base64 form in `changes.json` for changed binary foundation files. With it, the submission now records the changed `prototype/` brand icons and the 7 prototype files changed on November 1, which earlier syncs had missed.

Reconstruction from `foundation-2026-10-28` reproduces all 472 selected paths: 133 changed, 82 new and 257 preserved. Every path matches application commit `76f7d43` by bytes and executable mode. The rebuilt tree was set up with `git init`, with `node_modules` and `data/python/.venv` linked from the existing application install, so this was not a clean install. These passed:
- the submission unit tests;
- `pnpm check`;
- `pnpm test` (793 of 793; 791 of 791 at `38fd2f8`);
- `pnpm build`.

## Judges' copy tested as a judge, and real costs recorded — November 3, 2026

### Hosted judge test

A separate agent followed a written judge checklist on https://guided-tours--amuseme-judges.us-east.modal.run, signed in as two QA judges (`amuseme-qa-a-20261103@example.com` and `amuseme-qa-b-20261103@example.com`). It used Chrome at 1440 px and cmux WebKit at 1024, 390 and 320 px. Neither account uploaded anything.

- **Passed:**
  - Email sign-in, sign-out and signing in again as the same account, including with a mixed-case address and spaces. Two judges were signed in at once.
  - A signed-out link to a document returns there after sign-in.
  - The library shows the 10 examples and "3 uploads left of 3", and the examples are read-only.
  - Every example opens. The walkthrough, claims, map, original-page preview, full reader, pages dialog, processing report and prompt templates all work.
  - For all 10 examples, the ZIP, text, report, document JSON and original download (checked through fetch, not saved to disk). Copying all the text matches the text download.
  - Keyboard focus works. The security headers are present. Requests without a session get 401, and a cross-origin sign-in gets 403.
  - Nothing overflows sideways at 390 or 320 px.
- **Found and fixed** in application commit `55c0203`, redeployed at 22:26Z:
  - Citations from tables showed raw HTML in the evidence drawer, on 7 of the 10 examples.
  - Literal `**` bold markers showed in the reader on 8 of the 10.
  - SQLite writes on the hosted copy did not wait for locks. The volume snapshot's read lock made them fail at once with `SQLITE_BUSY` (three errors in the logs). Both databases now wait up to 5 s. New tests hold a lock from another process; they fail on the old code.
  - The upload notice said "Local documents"; it now says "Uploaded documents".
  - Every ZIP was named `amuseme-document.zip`; each is now `amuseme-<document ID prefix>.zip`.
- **Rechecked after that redeploy:**
  - All 270 walkthrough and claim citations show no table HTML and keep their highlight.
  - All 42 reader pages show no bold markers.
  - Downloads return 200 with the new names.
  - The logs showed no `SQLITE_BUSY` in the 12 minutes after the deploy.
- **Not run on the hosted copy:**
  - Processing an upload, the checklist's one paid step.
  - Native Chrome downloads to disk.
  - Offline behavior, because neither browser driver can cut the network.
  - Refusing a fourth upload. That rule is covered by `tests/server/shared-examples.test.ts`.
- **Open:** the README's demo video link downloads a file instead of playing, because GitHub serves release files as attachments.

### Completed Meta calls are charged their reported tokens

Meta reports token counts but no price, so every completed call kept its worst-case reservation in the ledger. On the judges' copy, the $100 budget would have run out after about 18 short uploads. Application commit `43c67e5` prices each completed Meta call from its reported input and output tokens, at $1.25 per million input tokens and $4.25 per million output tokens. A call without both counts keeps its reservation. Every call is still checked against its worst-case price before it is sent.

All 447 completed Meta calls in the local ledger reported both counts. None would have cost more than its reservation: the highest was 38% of it. Across those calls' 19 runs, including failed ones, the priced totals were $0.02 to $1.89, against $2.90 to $28.50 reserved. New tests in `tests/processing/cost-model.test.ts` and `tests/processing/guards.test.ts` cover the priced charge and the missing-count case, and the guard test fails on the previous code. `pnpm check` and all 793 tests in 77 files passed. Ledger totals in the entries below are worst-case reservations recorded before this change.

The judges' copy was redeployed from application commit `76f7d43`, which includes the change, at 22:48Z, as app `ap-LPfwPcnF84Df7OnKgMzglj`. Before the deploy, `pnpm check`, all 793 tests, `pnpm build` and the submission unit tests passed in that checkout. After it:
- health reported ready, and sign-in was email-only with no access code;
- requests without a session got 401, and a cross-origin judge sign-in got 403;
- the volume's documents, runs, outputs, users (2), provider attempts (0) and charges (0) were identical row for row before and after;
- the logs for the next 10 minutes showed no `SQLITE_BUSY` and no failed snapshot.

The interface sweeps were not repeated on this deploy, since the change does not touch the interface. The new pricing has not run on the hosted copy, because nothing has been processed there.

### Other checks

- **Rights.** The five openly licensed examples were checked at their sources: Crossref for the three JOSS papers, Europe PMC for the research letter and arXiv for the Panda paper. All five are CC BY 4.0. The README credits all ten examples.
- **Setup from a fresh clone.** A fresh clone of this repository at `546a453` (application `76f7d43`) was set up by running the README's "Run it" commands in order:
  - reconstruction;
  - a clean `pnpm install` into a new `node_modules`;
  - a fresh Python 3.14.5 environment with PyMuPDF 1.28.2;
  - build, account creation and start;
  - signing in at 127.0.0.1:4180 and opening the library.

  `pnpm check`, all 793 tests in 77 files and the 10 submission unit tests passed. The same steps had also passed at `de6b4c3`. pnpm 10.33.0 ran through `npx`, because this machine's default pnpm runs on Node 22 and fails the engine check.
- **MinerU app stopped.** The superseded `amuseme-staging-mineru` Modal app was stopped and its volumes kept. It served MinerU, the non-Meta model of the early extraction experiments. The judges' copy never called it.

## Submission sync to application commit `11ebdd1` — November 3, 2026

The submission was regenerated from application commit `11ebdd1`, thirteen commits after `15a0856`.
- **The first eight** (synced earlier to `906302d`) add the Muse CLI (`cli/muse/`), raise the processing ceiling to $480.564373, reject figure-crop corrections that grow into the page or a neighbouring figure, and run up to three figure calls at a time.
- **The last five** pin Python 3.14.5 in the setup steps and estimate one to two minutes per figure. They also let each crop-review round measure overlap from the box it was shown, and publish an unconfirmed crop widened to hold both the extractor's proposal and the last valid correction. The last commit records the approved $35 NASA and OSHA crop re-run in the operations runbook.

Preparation used the commit's tracked files (`git archive 11ebdd1`) with the foundation's own `prototype/` files, as before. The untracked `cli/modal/` and the application's later `prototype/concepts/` files were not included. The last five commits add or delete no files, so the 79 new files are unchanged. They include the six selected at the `906302d` sync: `cli/muse/README.md`, `cli/muse/muse`, `cli/muse/muse.py`, `cli/muse/test_muse.py`, `tests/paper/figure-crop.test.ts` and `tests/processing/figure-concurrency.test.ts`. `python/README.md` now differs from the foundation, so it moves from preserved to changed.

Every line added in the last five commits was read for credentials, private documents, runtime data, generated memory and non-event work, and none were found. All five commits are dated November 2, 2026. The four Muse CLI files were read again: the key comes only from `META_API_KEY` or `--env-file`, is redacted from error text and is never written to the ledger. A pattern scan of all added text and new files found only `example.test` placeholder addresses, a Modal secret name and lists that exclude private paths.

Preparation, reconstruction and the Python unit tests ran with the system Python 3.14.7. Reconstruction from this repository reproduced all 469 selected files: 122 changed, 79 new and 268 preserved. All 383 files outside `prototype/` match the commit by bytes and executable mode, checked against both the application checkout and a `git archive` of the commit. The 86 inherited prototype files keep their exact foundation bytes and modes.

The reconstructed tree was set up with:
- `git init`;
- a clean `pnpm install --frozen-lockfile --strict-peer-dependencies` into a new `node_modules`, filled from the machine's pnpm package store rather than linked to an existing installation (pnpm 10.33.0 under Node 24.19.0, through `volta run --node 24.19.0`);
- a fresh `uv venv --python 3.14.5` environment from `python/requirements.txt` (Python 3.14.5, PyMuPDF 1.28.2).

These passed:
- the 8 submission unit tests (`python3 -m unittest discover -s tests/submission -v`);
- the 10 offline Muse CLI tests (`python3 -m unittest discover -s cli/muse -p 'test_*.py' -v`);
- the 5 offline deployment tests (`python3 -I -m unittest discover -s tests/deploy`);
- `pnpm check`, `pnpm test` (76 files, 782 tests) and `pnpm build`.

The application's setup now pins `--python 3.14.5`. At the `906302d` sync, an environment created with `--python 3.14` resolved to Python 3.14.7, and 32 PDF tests in 5 files failed until it was recreated with 3.14.5. No live processing, Chrome check or hosted-copy check was run for this sync. The NASA and OSHA re-runs in the application's runbook, including the approved $35 crop re-run, were not run or verified here.

## Three more example documents — November 2–3, 2026

The user authorized processing four more openly licensed documents of other kinds: up to $120 for six runs, then up to $35 for two crop re-runs. Three became shared examples; the safety sheet did not.

| Type | Document | Rights | Pages | Example run |
|---|---|---|---|---|
| Classroom instructions | NASA Marshall, "3-2-1 Pop!", *Adventures in Rocket Science* (EG-2007-12-179-MSFC) | NASA work, public domain | 4 | `dfc4a546` (third run) |
| Patent, scanned | US 3,005,282, "Toy building brick" (1961) | Patent text and drawings, generally not subject to copyright | 5 | `82703425` |
| Code-heavy paper | Elsner, "Taming the Panda with Python", arXiv:2307.07633 | CC BY 4.0 | 5 | `15ce6a85` |
| Safety sheet (not used) | OSHA 3491, Hazard Communication Standard pictogram QuickCard | US government work | 2 | none |

Uploaded PDF SHA-256: NASA `28490ea659d062c1dd908bd9d8f7751d858456881a5da882b514c999f118c5d6`; patent `879bc9f70d072affae63c481d122d29f3a285f5c3b2ed5245ad805c6d86c2045`; Panda `b8f6dc919aba43bd62003bb269b5bbe2c0e4451c73a91d326de60b3d9686bff6`; OSHA `9841b6a851befb60fd7bf3532813afc521fafaf9b0b5cc37c7dabe7b7cf55a83`.

### Figure crops took three rounds

1. **First runs.** Crop review grew NASA step drawings (1–6% of the page) and OSHA pictograms (0.8% each) into boxes of 49–60% of the page that held the other figures. Corrections that cover half the page, or half of another figure's region, are now rejected unless the proposal already did.
2. **Second runs.** No crop was inflated, but two other faults showed.
   - Corrections Muse never confirmed were published. They cut off three NASA step drawings and the top of the patent's FIG. 6, all of which the proposals had held whole.
   - OSHA proposals sat up to 290 px above their pictograms. Each correction had to overlap the first proposal, so it could move only about 110 px in total.

   Each review round now measures overlap from the box it was shown. A crop that ends unconfirmed is published as the smallest box holding both the proposal and the last correction, unless that takes in another figure.
3. **Third runs (NASA and OSHA only).**
   - **NASA:** every crop holds its drawing. The worst clip is about 27 px of one fin tip, from a correction Muse confirmed.
   - **OSHA page 1:** fixed; all nine crops hold at least 94% of their pictogram.
   - **OSHA page 2:** the six lower crops still hold no pictogram, because those proposals were 250–290 px off. Three of their descriptions describe pictograms that are not in the image, so OSHA is not an example.

The patent example ran before the third fix. Its FIG. 6 is missing the top of the drawing, and FIGS. 9–11 lose a few labels.

### Independent accuracy reviews

Each guide was reviewed by a different agent, using the application's guide-accuracy-review skill, against rendered pages.

| Document | Quotes verbatim in the cited block | Findings |
|---|---|---|
| NASA | 35 of 35 | Five low-severity faults. A step-3 description says three fins; the drawing shows four. One claim says "upward rocket motion" is equal and opposite where the source says "a force". |
| Patent | 30 of 30 | Three low-severity faults. A limit about the disclaimer of claims 1–3 can be read the wrong way. FIG. 4's description counts three tubes where two are visible. FIG. 10's description puts the slits at the contact points. All reference numerals match the drawings. |
| Panda | 34 of 34 | One medium-severity fault: claim 2 says the Python bindings "perform nearly like native C++", but the paper's Table I shows inverse kinematics about 3× slower. One low-severity fault: a figure description gives the horizontal axis as ±0.25 where it runs to ±0.3. Table I matches exactly, and the one figure crop is tight. |

Reserved spend: the six runs reserved $78.70, and the two crop re-runs reserved $29.60. These are worst-case reservations; the application does not record measured billing (`actual_microusd` is null). Processing took 13–29 minutes per document, about a minute per page plus one to two minutes per figure.

## Judge access and Modal deployment — November 2, 2026

The application gained email-only judge sign-in, shared read-only examples, a per-user upload cap, HTTPS-origin support behind a proxy, and a Modal deployment (`deploy/modal/`). The judge copy is deployed at https://guided-tours--amuseme-judges.us-east.modal.run.
- **Seed.** Its volume was seeded with the seven current example documents: 7 documents, 8 runs and 8 outputs. There are no accounts, provider attempts, ledger rows or ratings, and the three superseded first-run copies were left out.
- **Checked after deploy:**
  - `/health/ready` returns `ready`.
  - `/auth/sign-in-options` reports email sign-in with no access code.
  - The page loads.
  - The documents API refuses requests without a session (401).
  - A cross-origin sign-in request is refused (403).
- **Hosted judge test:** signing in and opening the examples were tested on November 3 (see above). Processing an upload there has not been tested.
- **Re-seeded and redeployed on November 3.** Before the change, the volume still had no accounts, provider attempts or charges, and only the examples owner's 7 documents. The app was stopped, and the volume was given the ten reviewed examples: the seven above plus NASA `dfc4a546`, the patent `82703425` and Panda `15ce6a85`. That is 10 documents, 11 runs and 11 outputs, with no charges. The superseded NASA and OSHA runs were left out. The app was then redeployed from application commit `11ebdd1`. `/health/ready` returned `ready`, sign-in options reported email only, the page loaded, the documents API returned 401 without a session, a cross-origin sign-in returned 403, and the logs showed no errors.

The submission was regenerated from application commit `15a0856` with Python 3.14.5 and Node 24.19.0. Reconstruction from this repository reproduced all 463 selected files: 121 changed, 73 new and 269 preserved. All 377 files outside `prototype/` match the commit by bytes and executable mode; the 86 inherited prototype files keep their exact foundation bytes and modes. In the reconstructed tree, after `git init`, a clean `pnpm install --frozen-lockfile --strict-peer-dependencies` and a fresh `uv` environment from `python/requirements.txt` (PyMuPDF 1.28.2), these passed: the 8 submission unit tests, the 5 offline deployment tests (`python3 -I -m unittest discover -s tests/deploy`), `pnpm check`, `pnpm test` (74 files, 751 tests) and `pnpm build`.

## Four more document types — November 2, 2026

The user authorized processing four short, openly licensed documents that are not research papers, so the guide could be checked on other kinds of writing.

| Type | Document | License | Pages |
|---|---|---|---|
| Biomedical | Longman et al., research letter on flood-related PTSD, *Aust N Z J Psychiatry* 57(12), 2023 (PMC10666513) | CC BY 4.0 | 3 |
| Legal | *Doe v. Dynamic Physical Therapy, LLC*, 607 U.S. 11 (2025), per curiam, Reporter's preliminary print | US government work | 4 |
| Class handout | US EPA, *Half-Life: Teacher Answer Key* (EPA 402-B-19-055) | US government work | 2 |
| Business | SBA Office of Advocacy, *Critical Condition: The Poor Prognosis for Private Practices* (Sept. 2026) | US government work | 4 |

Uploaded PDF SHA-256: letter `33f884da08c5e286838e171e8839b24aa39ade567f29cf8f1bdeece132b23107`; SBA brief `ab40c8cb94aa12e271bb6df09be4b1f27871665dd8db92cd26a50926f4d36c43`.

Two sources needed a lossless copy before upload, because the renderer refuses PDFs that are encrypted or that MuPDF must repair:

- The court opinion carries a permissions-only lock (no password). The copy removes the lock: `3cdcbc7b…` → `06d6fb0f0ec462fedb5b25680898b46d7034b16c4482b3e7fa6dc844206608f2`.
- The EPA handout has a damaged accessibility tag tree that MuPDF repairs while drawing. The copy drops the tag tree: `505659da…` → `c0869999c0319aff79c899ed3f01459ec733f580c1f532fab32c094d630788f9`.

For both, every page renders pixel-identical to the original at 150 dpi and the extracted text is identical.

### What failed first, and what changed

Before Muse review existed, three of the four runs stopped on a rejected model answer, and none was retryable:

- **Page check (letter, twice; court opinion once).** Muse proposed joining a sentence that continues onto the next page, but the gap held a running header ("Cite as: 607 U. S. …", a journal running title) that extraction had classified as a paragraph. Joins may only cross recognized page furniture, so the whole page answer was rejected.
- **Headings (SBA brief).** Muse correctly marked the two-line cover title "CRITICAL / CONDITION" as the document title, but the validator accepted only one-line headings. This was a validator bug: a block already extracted as a heading may now span lines, which are joined with a space. Promoting a multi-line paragraph is still rejected.

Muse review was then added: a reviewer Mastra agent per stage receives the original evidence, the rejected answer and the exact problems, returns a corrected answer, and falls back to a safe default after two rounds (see `docs/step-rules/muse-review.md`). With it, the letter and the court opinion each had one page-check answer rejected and corrected in one review round; the handout and the SBA brief needed none. The five failed attempts were removed from the library through the application's own delete, which keeps their ledger rows.

### Second round: crop review, page furniture and per-call pricing

An accuracy review of the first runs found no wrong numbers or invented facts, but it did find the EPA chart crop cut off with body text inside, and two sentences split across pages by running heads. Three changes followed:

- **Figure crop review.** A Mastra agent sees the page image and the proposed crop, and confirms or corrects it for up to two rounds. If it can't confirm, the crop is kept with a visible warning.
- **Page furniture.** Page check may now mark a running header or footer as furniture, so a sentence can be joined across it.
- **Per-call pricing.** Each call is priced before dispatch. The price is the counted input tokens plus a 65,536-token framing reserve at $1.25 per million, plus the full 16,384 output tokens at $4.25 per million. The call is refused if that worst case exceeds the stage's reservation. Reservations dropped from $1.50–$2.50 to $0.20–$0.50 per call, so a 15-page document with 5 figures reserves at most $14.50 of its $30 cap.

The handout, the court opinion and the letter were then processed again.

| Document | Pages | First run: calls / reserved | Second run: calls / reserved | Second run tokens (in / out) |
|---|---|---|---|---|
| EPA handout | 2 | 7 / $12.50 | 8 / $2.90 | 37,760 / 25,663 |
| Court opinion | 4 | 11 / $20.50 | 10 / $3.40 | 53,194 / 36,475 |
| Research letter | 3 | 9 / $16.50 | 9 / $3.10 | 65,987 / 51,437 |
| SBA brief (not re-run) | 4 | 12 / $22.00 | — | 64,148 / 29,726 |

"Reserved" is the ledger's worst-case hold, not a bill; Meta calls do not report a final charge. At published rates the second-run tokens cost roughly $0.16, $0.22 and $0.30. The cumulative ledger stands at $280.90 of the $360.564373 ceiling. Processing was disabled again afterwards.

Second accuracy review of the re-runs. All 75 guide quotes appear exactly once in the cited block and match the PDF; no wrong numbers, names or invented facts.

- **Fixed:** the EPA chart crop now frames the whole chart and nothing else (crop review: confirmed). The court opinion's dispositive sentence is joined across pages 2–3. The EPA guide no longer overstates industrial uses, and no longer quotes a question prompt as evidence.
- **Still present:**
  - The letter's results sentence stays split across pages 1–2. The gap holds Table 1 and its notes, not just furniture, so page check correctly refuses the join.
  - One "Per Curiam" running head on page 2 of the opinion, and the "Page Proof Pending Publication" watermark on its cover, remain as body paragraphs.
- **Source errors and minor wording issues:**
  - The letter's Table 1 repeats 299/235 in its "Yes" row. That is an error in the source, and the guide does not flag it.
  - The letter's two table header rows are in reverse order. All 40 data cells match.
  - The EPA figure description says the axis runs to "over 400" (it ends at 400), and one EPA claim is rated "limited" where "strong" fits.

The superseded first runs remain in the library until the owner removes them.

### Reconstruction checks

The submission was regenerated from application commit `b9b5404` with Python 3.14.5 and Node 24.19.0. Reconstruction from this repository reproduced all 455 selected files: 104 changed, 65 new and 286 preserved. All 369 files outside `prototype/` match the commit by bytes and executable mode; the 86 inherited prototype files keep their exact foundation bytes and modes. In the reconstructed tree, after `git init` and a clean `pnpm install --frozen-lockfile --strict-peer-dependencies`, the 8 submission unit tests, `pnpm check`, `pnpm test` (71 files, 738 tests) and `pnpm build` all passed.

## Two additional papers — November 2, 2026

The user authorized up to $60 for two more short, openly licensed papers: one with a data table and one with plotted figures. Both were uploaded to the local application through its upload API, using the ordinary signed-in session, and processed by the same Meta-only pipeline.

| Paper | Pages | Time | Meta calls | Reserved | Guide | Quote references | Reported issues |
|---|---|---|---|---|---|---|---|
| Kamath et al., *SOLWEIG-GPU* (JOSS 2026, CC BY 4.0) | 4 | 251 s | 11 | $20.50 | 5 steps, 3 claims, 6 limits | 27 | 0 |
| Hartzer & Saripalli, *EKF_CAL* (JOSS 2025, CC BY 4.0) | 5 | 261 s | 14 | $26.00 | 5 steps, 3 claims, 6 limits | 30 | 0 |

All 25 provider attempts completed. Uploaded PDF SHA-256: SOLWEIG-GPU `339a5c8e7ce3b0ede4db12b21bfe079be59eb8ebd281eac15241a795f055dd48`; EKF_CAL `55d02d55860c2ba70f89a7abe780ff57621868f2bf782f092797a349203d9a90`.

SOLWEIG-GPU's benchmark table was extracted as a four-column table; all 12 cells match page 3 of the PDF. EKF_CAL's two line plots received generated descriptions whose axes, ranges, series colours and convergence shape match page 4. Publication accepted every guide quotation as an exact, unique match in its cited source block.

An independent reviewer then checked all 36 guide passages against the page images. All 57 quotations were re-verified as exact, unique matches on the correct pages. No passage contained a factual error, and the support labels were judged reasonable. The review found these faults:

- SOLWEIG-GPU's figure description says buildings have low sky-view values; the plot shows roofs high and only trees low.
- One SOLWEIG-GPU limit drops "always" from its quotation's meaning ("may not have" rather than "may not always have").
- EKF_CAL's step 3 groups a Matlab toolbox with offline tools for a weakness the paper attributes to the others.
- EKF_CAL's second figure description slightly understates the final error range (+100 mm, where the plot reaches about +150 mm).
- EKF_CAL's page footers merge the page number into the citation text.

These outputs were not edited. The interface labels guides and figure descriptions as AI-written and links every passage to its source for that reason.

The ledger now holds 169 charge records accounting for $145.564373 against a $160.564373 ceiling, with the original budget identity and every earlier record unchanged. These are worst-case reservations; provider billing was not reported. The data directory was copied before the runs, and paid processing was disabled immediately afterward.

## Paper map — November 2, 2026

A paper map is now a fourth reading option. It is built in the browser from the saved guide, so it needs no model call, server route or storage change. Walkthrough steps, cited passages, claims and limits are drawn as connected items. Selecting any item lists its connections and opens the exact cited passage in the source viewer. The map discloses that its connections come from the guide's citations, not measured relationships. Its renderer adapts the curved-link geometry of Vectorize Hindsight's MIT-licensed Constellation component; the notice and license are retained.

## Library and reader redesign — November 2, 2026

Chrome opened the existing six-page paper from the redesigned library. The library, goal chooser, sign-in form and full reader fit 320, 390, 1024 and 1440 CSS-pixel viewports in both themes. The walkthrough and claims opened their saved content. Selecting a citation showed its exact quotation, and switching to the original showed the scanned page. Escape returned focus to the citation. The full reader switched between the original and clean text on page 2.

The ZIP saved through the new downloads panel contained all five expected files. Its 354,085 bytes matched the previously verified repaired ZIP by SHA-256 (`653ba678e3813703fc61fae1c7fb1cc352dc0ab333c154644d937a96d2149ab1`). All five entries matched their stored hashes and all 33 guide references matched their source passages.

A separate Chrome session uploaded a new one-page PDF to an isolated local test instance. Real upload admission accepted the file, the queued screen retained the selected goal, and the original page was readable while queued. The test instance had no processing worker. The saved paper used for the reader and download checks came from the November 1 live run. A separate fixture confirmed that a paper without a saved guide still opens in the full reader.

The final application passed `pnpm check`, all 686 tests across 67 files, and `pnpm build`. The PDF cancellation test now waits for both child processes to start before checking that cancellation stops them.

Reconstruction from this repository reproduced all 430 selected files by bytes and executable mode. The inventory includes 86 changed files, 40 new files and 86 preserved historical prototype files. All 83 app tests passed in the reconstructed tree against the existing pinned dependency installation.

## Live reading-guide result — November 1, 2026

A fresh six-page MFGLib mixed-scan PDF was uploaded through the ordinary interface; processing completed in 359.965 seconds. Run `959bfe8e-ac93-4fbe-b408-f5ef0458aa38` recorded 15 accepted Meta Muse Spark 1.3 calls: six extractions, six page checks, headings, a figure description and the reading guide. The uploaded PDF's SHA-256 is `c4524cec02675132b4906b4e06721f0bcee5af337425d0dd8bc67a3eb3b3a60f`.

The saved guide contains five steps, three claims, six stated limits, and 33 quote references. Every reference exactly matches a unique location in its immutable source block. The references use 23 distinct source/quotation pairs, with some cited more than once. Review covered the overview, all steps, all claims and their support and limits against the cited sources and saved receipts. The downloaded structured document includes the guide; normalized text stays separate from it.

Native Chrome verification covered the real upload, saved guide after a server restart, every walkthrough step and claim, completion states, reader/source-original switching, source quotation navigation and the issue report. The final source-scroll fix was built and checked on the actual stored guide. Separate synthetic checks covered processing-to-ready progress, the selected reading goal, browser history and Escape focus return.

Actual ZIP, text and original-PDF downloads were verified. The 354,498-byte ZIP contains five entries, each matching its saved manifest hash. The text is 26,249 bytes with SHA-256 `96c7704e3d65b895c1347c11757de13c1a1bc2c9307b9500cd9d034f5bef5138`; the original download matches the uploaded PDF's bytes and hash. A separate read of the downloaded ZIP confirmed the manifest hashes, guide counts and exact, unambiguous source references.

The run finished with two reported `unclassified-content` issues for retained blocks on pages 3 and 4. This acceptance test does not establish error-free extraction or constitute a full scientific, mathematical or table-fidelity audit. Broad accuracy remains unmeasured.

The new run accounted for $28.50 using worst-case reservations, within the explicitly authorized $30 allowance. Actual provider billing was not reported. The 129 prior charge records remained unchanged, and paid processing was disabled after the test. The original budget identity and ledger were preserved.

Fixture tests also exercise malformed source references, saved-response replay, missing funding, altered guide output, and compatibility with historical configurations and workflow snapshots. The final source navigation change passed 75 app checks. Before the code-classification repair below, the application passed `pnpm check`, all 666 tests across 64 files, and `pnpm build`. This result does not depend on the earlier October 28 live test.

## Code-classification repair — November 1, 2026

The two warnings were caused by the application converting Meta's correctly identified code blocks into `unclassified` blocks. Code is now an explicit shared block kind, preserved by both extraction paths. Unsupported content still produces a warning.

Both flagged sections were compared line by line with original PDF pages 3 and 4: 29 and 25 code-body lines, respectively. Their contents, comments, punctuation and indentation match; Python syntax parsing also passes. The code was not executed. Markdown fences remain a representation around the printed code.

An offline repair verified the original saved provider responses, their identities and hashes, the prior publication and the guide's original source context. It created revision `7beee674-96b5-4518-b3d7-982d1b2f67c1`, changing only the two code classifications and their related report entries. The previous revision, all 144 charge records and all 47 saved provider-attempt records remain unchanged. The guide, figures, source PDF and block text remain unchanged. This repair used no new model calls or spending and kept paid processing disabled.

After rebuilding and restarting the actual local app, native Chrome showed both code sections, the existing guide and zero unresolved issues. A fresh 354,085-byte ZIP matched all five saved artifact hashes. Its text entry and the separate 26,233-byte text download have SHA-256 `964bce1450e6f513ca0eb03f59cad3a660ca8e7694dfab0948dcdb5d2804970d`. The report identifies the previous revision and repaired block IDs. Zero reported issues does not establish that the complete document is error-free.

The repaired application passed `pnpm check`, all 678 tests across 66 files, and `pnpm build`. Nine new repair tests cover preserved content and historical data, incorrect or corrupt evidence, stale and repeated repairs, rollback, and opening the repaired document after a database restart. The extraction regression tests also cover exact code formatting and retained warnings for genuinely unsupported content.

## November 1 reconstruction checks

The November 1 reconstruction contains 425 files. All 339 application, configuration, documentation and test files outside `prototype/` match the selected current application snapshot by bytes and executable mode. The 86 inherited prototype files retain their exact foundation bytes and modes; the separate goal-first reference prototype is not included. The package records 85 changed files and 35 explicitly selected new files.

Reconstruction directly from this repository passed all byte and executable-mode checks. The eight packaging tests passed, as did `pnpm check` and all 111 selected app, extraction, guide, repair and publication tests across 13 files in the reconstructed tree. The application checks used the existing pinned dependency installation through a local link; this was not a clean dependency-install test. Runtime data, credentials, private audit output and generated memory remain excluded. Repository skills and licenses were preserved separately from the application inventory.

## Historical live result — October 28, 2026

A six-page MFGLib paper, with page 3 rasterized, completed through the local application's ordinary upload in 235.749 seconds. The run recorded 14 accepted Meta Muse Spark 1.3 calls: six extractions, six page checks, headings and a figure description. No non-Meta model ran in this workflow.

Independent source comparison checked four displayed equations, the scanned page's 29 code lines and a complete 1495×578 two-panel figure crop. The crop's pixels match its source-page region. The caption remains separate from the generated description. Two retained code blocks have disclosed classification warnings. This paper did not exercise tables; broad accuracy is unmeasured.

The manager inspected the finished reader, page navigation, processing report and model details in Chrome after a server restart. A normal native ZIP download matched all five published artifact hashes.

That integrated source passed type, lint and architecture checks, 630 tests and a production build. The final image-label wording change additionally passed those checks, 15 focused reader/app-shell tests and another build. Eight packaging tests passed. Its 398 reconstructed source files matched the tested checkout by bytes and executable mode. Those counts describe the earlier snapshot.

The earlier demonstration was a 130-second captioned sequence of real captured screens, with processing time shortened. It was not a continuous recording or a general accuracy benchmark and has been withdrawn.
