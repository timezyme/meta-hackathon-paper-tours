# Testing and limits

## Code

`pnpm check` (types and lint), `pnpm test` (710 tests in 78 files) and `pnpm build` pass.

## Ten example documents

Ten documents of seven types were processed live through the Meta pipeline:
- four research papers (one with a scanned page, one table-heavy, one figure-heavy and one code-heavy);
- a psychiatry research letter;
- a US Supreme Court opinion;
- an EPA class handout;
- an SBA economics brief;
- a NASA classroom activity;
- a scanned 1961 patent.

Separate AI agents checked each guide against the rendered pages. Every quote matched its cited passage exactly. The faults they found were left in place:
- **Panda paper:** claim 2 says the Python bindings perform "nearly like native C++", but the paper's Table I shows inverse kinematics about 3× slower. A figure description gives an axis as ±0.25 where it runs to ±0.3.
- **NASA activity:** a step description says three fins, but the drawing shows four.
- **Patent:** the FIG. 6 crop misses the top of the drawing, and FIGS. 9–11 lose a few labels. FIG. 4's description counts three tubes where two are visible.
- **SOLWEIG-GPU:** a figure description says buildings have low sky-view values, but the plot shows roofs high.
- **EKF_CAL:** a figure description understates the final error range (+100 mm, where the plot reaches about +150 mm).
- **EPA handout:** a figure description says the axis runs to "over 400", but it ends at 400.
- **Research letter:** the source's Table 1 repeats 299/235 in one row, and the guide doesn't flag it. One sentence stays split across pages because a table sits between its halves.
- **Court opinion:** one running head and the cover's watermark remain as body text.

A tenth candidate, an OSHA safety sheet, was left out. Six figure crops on its second page missed their pictograms. Ten documents are not an accuracy benchmark.

## Judges' copy on Modal

- **Interface:** two QA judge accounts were tested in Chrome and WebKit at widths from 320 to 1440 px. Sign-in, the examples, every reading mode, the downloads, keyboard focus and access checks all passed. Signed-out requests get 401, and another judge's documents get 404. The test found four faults, all fixed: table HTML in citations, bold markers in the reader, SQLite lock errors and duplicate ZIP names.
- **Upload:** a 4-page paper (faer, JOSS, CC BY 4.0) was processed twice. The first run took 12 min 49 s and cost $0.47. After parallel processing was added, the second took 7 min 14 s and cost $0.43. A review of the first run's guide found all 30 quotes exact, and three medium faults in how it reads the benchmark charts. A fake PDF, a 51-page PDF and a file over 50 MiB were each refused.
- **Returning to the tab:** the page stays where it was. If the session has ended, it goes to sign-in and comes back after sign-in.
- **Not tested on the hosted copy:** native downloads to disk and offline behavior.

## Cost

Before each Meta call is sent, it reserves its worst-case price. It is then charged for the tokens Meta reports, at $1.25 per million input tokens and $4.25 per million output tokens. The judges' $100 budget has been charged $0.90 so far.

## Limits

- The quotation check catches invented or misplaced quotes. It doesn't prove an explanation is right, so guides are labeled AI-written.
- The foundation still contains an older MinerU extraction path, which is not a Meta model. Live runs refuse to use it, and its service is stopped.
- Windows is untested.
- The full record of every check is in [the earlier version of this file](https://github.com/timezyme/meta-hackathon-paper-tours/blob/a9191cb700b6eac2bbd04230365a2d738649a0d5/VERIFICATION.md).
