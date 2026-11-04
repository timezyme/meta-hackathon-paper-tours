# AmuseMe prototype

A dashboard mock for uploading a document, following its processing, and downloading normalized text with images. This explores the revised product idea; it is not a production application.

## Open

From the repository root, run:

```sh
python3 -m http.server 4177 --bind 127.0.0.1 --directory prototype
```

Open [the dashboard](http://127.0.0.1:4177/). No installation or build is required.

## Preview controls

The temporary header switches directly between **Empty**, **Uploaded**, **Processing**, **Ready**, **Document**, **With issues**, and **Failed**. The default is Empty. These are fixed mock states. Processing stays in place until another state is selected. With issues opens the same reader with an illustrative unresolved-item notice and downloads available. It does not ask users to approve repairs.

Width controls provide Desktop, 1024, 390, and 320 layouts. The app responds to the selected container width. **Dark mode is the default**; Light remains available. State, width, and theme selection are represented in the URL and survive reloads. Keyboard arrows, Home, and End navigate the state tabs.

The copy speaks as AmuseMe; the earlier "Sky" helper name was removed on October 31 because it clashed with the product name. **Try it with a sample paper** starts a twelve-second sequence in a single document card: read the pages, fix text and math, put headings in order, describe the pictures, and pack the download. The card shows a small illustrated page that untangles one step per stage, the current step, a progress bar, and a checklist of finished steps. Motion honors reduced-motion preferences by keeping only short fades.

Completion opens the Document page automatically. The Uploaded state's **Play sample demo** and Failed state's **Try again** start the same sequence. Uploaded is a paused preview of an otherwise automatic step. **Cancel demo** returns to Uploaded. Selecting a header tab stops playback immediately. Ready shows the completed document card with **Open your clean copy**, **Download ZIP**, and **Upload another**. A selected local file offers **Try the sample paper**.

## Input and output

- **Choose a PDF**, click the upload area, or drop a file into it. One non-empty file up to 50 MB can be added at a time. Selection reads metadata only; it does not upload or inspect the contents. These preview limits do not settle supported production formats.
- A real file selection is labeled **Not processed** and has no downloadable output. Header tabs return to the mock document.
- The Ready state provides **Open your clean copy** and **Download ZIP**. The Document header tab opens the same result page directly.
- The result page shows the clean copy beside one **Take it with you** panel. Figures and rendered mathematics are shown by default. Page controls sit in the toolbar above the document.
- A strip above the document shows the original filename, PDF format, page count, and file size, with a working **Open original** link. `sample/source.pdf` is copied unchanged from the same synthetic normalization fixture.
- The panel offers **Copy all text**, ZIP, and text-only downloads. **How this was produced**, marked for researchers, reveals four planned workflow stages. Expand a stage to inspect its proposed model and reasoning setting; **View prompt** reveals the full draft prompt.
- **What changed** (the processing report), collapsed by default beneath downloads, summarizes the saved normalization run. It records 37 updated blocks, 12 mapped headings, 2 image descriptions, and 0 paragraph joins. Download the report separately as `sample/processing-report.json`; the existing ZIP is unchanged.
- The report compares block content in the saved joined and corrected OCR stages by page and block index. Its 37 changes comprise 14 text, 13 equation, 5 caption, 2 title, and 3 list blocks. Counts describe recorded changes, not verified fixes or survival in the final export. The saved artifacts do not record an unresolved-issue count.
- **With issues** adds a clearly labeled illustrative issue in a banner above the document and in the panel, and outlines Equation (10) on page 2. **Show me** jumps to it. It remains attached to the sample when returning to the dashboard and reopening it, including after reload. Choosing a different header mock state selects that fixture instead. Page navigation is optional, and downloads remain available.
- The details are visibly labeled **Planned configuration**. Extraction shows MinerU on Modal; the three agent stages show **Muse Spark 1.3** (`muse-spark-1.3`) at high/medium/high reasoning. These choices were checked against current Meta documentation and event information; quality and account access remain unverified. The draft prompts and proposed settings are not the saved sample's execution record. No new processing or verification run was performed.
- **Copy all text** copies the entire normalized export, including both pages, and confirms success in a short notice. If clipboard access fails, the notice directs the user to the text-only download.
- **Was this helpful? Yes / Not really** rates the whole sample output. One choice can be selected, changed, or cleared. Feedback stays in page memory until reload, is not submitted, and is labeled accordingly after selection.
- On narrow screens, a bar fixed to the bottom holds **Copy**, **ZIP**, and **More**. **More** opens the panel as a bottom sheet. Close, Escape, or clicking outside dismisses it; keyboard focus stays within the open sheet and returns to **More** on dismissal. These controls never modify the download.
- The ZIP contains `normalized.txt`, `images/figure-1.jpeg`, `images/figure-2.jpeg`, and `images.json`. The JSON associates each image with the source block ID and saved AI-written description.

The text and images are copied unchanged from the supplied normalization example, artifact ID `15bc953548e8a98cfff8528edc4a8e6ac2bd370aac0f825fb8e7a87eb600f067`.

The text originates in `9-normalize-paper.txt`; the images originate in `4-join-pages-and-cut-figures/images/`; description mappings originate in `7-describe-figures/descriptions.json`. The sample is synthetic and contains invented measurements. No accuracy benchmark or new normalization run was performed.

The page uses inline CSS/JavaScript, an embedded Geist font, and locally vendored KaTeX **0.19.1** for mathematics. Licenses are in `FONT-LICENSE.txt` and `vendor/katex-0.19.1/LICENSE`. The [official KaTeX browser](https://katex.org/docs/browser) and [auto-render](https://katex.org/docs/autorender) documentation guided the integration.

The formatted reader uses static blocks derived from the saved normalized sample; it is not a general document parser. There is no model inference, live conversion, authentication, database, or external runtime request.

## Look and feel

The October 31 redesign was chosen after three independent design reviews (conversion-focused page design, interface polish and motion, and art direction). It is built for middle-school through college students and researchers:

- Nothing in the product reads smaller than 12px; body text and buttons are 16px, and every target is at least 44px.
- Plain words replace pipeline terms ("Clean copy", "What changed", "Describe the pictures"). Researcher detail stays one click away.
- Honesty labels are readable chips. AI-written content is always marked in violet; sample and illustrative content in blue; issues in amber; failure in red.
- The processing card's illustrated page shows the product's job: scrambled text, a broken equation, and a missing picture are fixed one step at a time. In the empty state, the same page sits beside the upload button as an example of copy-paste damage.
- The reader uses a system book serif for reading and Geist for everything else.

## Branding

The shared header uses the selected A Muse logo, with primary and reversed versions following the prototype theme. The adaptive SVG favicon follows the browser color scheme, with ICO fallback and an Apple touch icon. The selected logo assets are included locally in `assets/brand/`.

Branding was checked in the in-app browser at desktop, 390px and 320px widths, in light and dark themes. All seven mock states retained one visible, loaded logo. Dashboard/document navigation and keyboard activation passed. All five served assets matched the selected originals, with no browser warnings or errors. Chrome DevTools was unavailable because its profile was already in use; operating-system theme switching of the favicon was not exercised.

## Verification

The October 31 redesign was checked in Chrome the same day: every state in both themes at desktop, 390px, and 320px widths, with no text under 12px, no control under 44px, no sideways scrolling, and no KaTeX or script errors. Sample playback and downloads were not re-run on the redesign; the browser observations below describe the previous layout.

The updated flow was checked in Chrome: sample playback reaches the reader, cancel returns to Uploaded, retry starts playback, and changing header states cancels playback. All seven states fit the 320px container without outer horizontal overflow. The upload screen also fits at 390px, and the processing card was inspected at 1024px in light mode and at desktop width in dark mode.

Browser checks covered local file selection and removal, a filename containing markup characters, and empty-file rejection. Selected files remain unprocessed and offer no download. The illustrative issue survives a return to Ready, reload, and reopening the document. Its page link works, and downloads remain available. Source/output drawers, Escape focus restoration, and nested model/prompt details work. Both paper pages render without KaTeX errors. The downloaded processing report matches the local JSON byte for byte; its totals were independently checked against the saved normalization artifacts. JavaScript syntax and whitespace checks pass.

Earlier checks covered copying the entire export and feedback selection/change/clear. An actual paste matched `normalized.txt` by SHA-256. The model choices and prompt drafts are proposed and visibly labeled; these checks do not validate normalization accuracy.

The old reading switches, toys, and repair-review modal are absent. The existing brand header and embedded sample data were preserved. Earlier browser checks covered source-PDF opening, text-only download, prompt expansion by keyboard, narrow-pane dismissal, and focus wrapping. The downloaded text matched the saved export byte for byte. Clipboard rejection and missing-API handling passed an isolated handler check; actual browser permission denial was not simulated.

Earlier checks covered processing playback and cancellation, local file selection/removal, escaped filenames, empty-file and size-limit feedback. The drop handler was exercised using a scripted browser File/drop fixture; OS-to-browser dragging was not verified.

The browser downloaded the ZIP successfully. Its archive integrity passed, all four expected files were present, and its text and both images matched the supplied normalization artifacts byte for byte. Both preview images loaded. Console, JavaScript syntax, and whitespace checks passed. Captures and local browser fixtures are ignored under `qa/captures/`.

## Three new directions

[`concepts/`](concepts/) holds three alternatives to the dashboard. Open [the concept index](http://127.0.0.1:4177/concepts/) from the same server. Each concept changes what the user does, not only how it looks:

- **Live Page** (`live-page.html`): the original pages show while processing runs, so reading starts at once. When the run succeeds, the clean copy takes their place at the spot being read. A switch at the top of the page then flips between the clean copy and the original pages, keeping the reading spot. A failed run leaves the originals and no clean copy.
- **Side by Side** (`side-by-side.html`): the original page beside the clean copy. Every part the AI rewrote is an "AI edit", sorted into edits that change words or symbols, edits that change only formatting, and parts missing from the clean copy. A circled-i button after the filters explains the marks. Clicking a marked part opens what it said before, what it says now, where it is on the page, and why. The AI saves no reasons, so "why" says so and points to the original instead of guessing. Small symbol changes, such as bold lost from a math symbol, are named outright.
- **Pieces** (`pieces.html`): the result as cards to take one at a time: an equation as LaTeX, a table for a spreadsheet, a figure with its description. Pieces appear only when processing succeeds. Table 1, printed across two pages, is one piece with both parts kept separate. Copying everything stays one click away.

The concepts share `concepts/shared/`: the saved sample (generated from this page's embedded data and `sample/processing-report.json`), one block renderer, and a reviewer strip. Live Page and Side by Side also use the first-read text and page positions (`sample-source.js`, see below) and rendered images of the two source pages. The strip switches between Empty, Working, Done, With issue, and Failed, and between light and dark. State and theme are kept in the URL. The same twelve-second timeline, illustrative issue (Equation 10), and real downloads apply to each. Progress shows only what a real run reports: the step, and for some steps how many pages or pictures are done. A chosen local PDF is labelled not processed.

`sample-source.js` was generated from the saved run's first-read ("joined") response for the sample paper. Two parts of it are hand-made: the map of first-read blocks that the clean copy folded into a neighbouring part, and the three places missing from the saved clean copy (the panel label "(b) Directed network", section 9, References, and the footnote at the bottom of page 2). The scripts that generated the two sample files are not in this repository. All 37 recorded changes land in either the 26 changed parts (24 marked by block in the dashboard, plus two headings) or those missing places.

These behaviours need real-app support that does not exist yet:

- Cancel needs a cancellation route; the application has none.
- Outlines and the kept reading spot need page boxes for every block. The saved run has them; extraction that gives text blocks only a page does not.
- Tables cannot be joined. Pieces groups a "(continued)" table by its caption, which holds for this sample only.
- Finding parts missing from the clean copy needs a comparison of first-read and clean text.
- Try again and a named failed page should show only when the failure is marked retryable and names a page.

Each concept was checked in Chrome at desktop width and in 390px and 320px frames, in both themes and every state. No text was under 12px, no control under 44px, and nothing scrolled sideways. There were no KaTeX or console errors. Copy all text in Live Page matched `sample/normalized.txt` byte for byte. Pieces copied an equation as LaTeX and two pieces together correctly. Downloads were not triggered; their links point at the sample files above. Drag-and-drop from the operating system and clipboard failure were not exercised. Real processing takes minutes, not twelve seconds; the timeline is for review only.

## Superseded explorations

- `tour-demo.html`: miniature guided-tour demonstration above Sky's composer.
- `layouts.html`: Companion, Constellation, and Fieldnotes variants.
- `animation.html`: Three.js document-to-tour motion study, using the locally vendored Three.js 0.180.0 files and MIT license in `vendor/`.

These preserve earlier discovery. They do not define the current dashboard or MVP.
