# Synthetic contract fixtures

All PDFs and text in this directory were authored for AmuseMe and are dedicated to the public domain under CC0-1.0. They contain no real paper or private document.

These inputs exercise contracts, not OCR accuracy. `scan.pdf` contains a raster checker pattern and no text layer. Its decoded fixture records an unclassified image region rather than inventing recognized words. `empty.pdf` has one blank page and must not become usable output. The other files contain simple text, an ambiguous `x1` or `xl` expression, a reference, a note, a paragraph split over two pages, a table, or a figure with an author caption. `missing-description.pdf` includes a black square; lack of generated description must retain the figure and caption.

`contracts.ts` supplies hand-authored extracted and canonical values. Table markup, references, notes, ambiguous content, and all cross-page locations must survive round trips. Fixture hashes for source PDFs are real. Placeholder page-image and output hashes are explicitly fixture data; no image renderer, OCR provider, or export pipeline produced them. No prototype sample output or known omission is used as an expected result.

`mineru-normal.zip` is a synthetic native/compatibility archive for the complete saved-pipeline integration test. Its deliberate `l2 units` extraction mistake is repaired by a deterministic Meta fixture. This archive is not a real MinerU result.

`reader.ts` supplies the synthetic document, report, and text used by the manual visual server and its HTTP tests. It has no browser-runner dependency.

`seaborn-figure.jpg` is a figure from Michael L. Waskom (2021), "seaborn: statistical data visualization," *Journal of Open Source Software*, 6(60), 3021, https://doi.org/10.21105/joss.03021, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). It is unchanged.
