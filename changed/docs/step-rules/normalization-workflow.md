# Guarded document normalization

Covers: workflow:normalize-document, step:extract-document, step:check-pages, step:restore-headings, step:describe-figures, step:assemble-document, step:publish-document

The Mastra workflow owns seven ordered stages, including the reading-guide step after assembly and before export. Historical configurations pass through that step without provider work. Snapshots contain document/run IDs
and hash-addressed private artifact references. Source text, page PNGs, raw
provider output and credentials are not duplicated into workflow snapshots.
Only RunStarter can issue the in-memory execution permit for a live durable
claim. Generic Studio execution cannot acquire it. Every provider call passes
through ProviderGuard, with no automatic Mastra or SDK retries.

Local steps may repeat after interruption. Saved responses and artifacts are
validated before reuse. Source ownership, hash and current claim are checked
by storage and the provider guard. Publication validates all output bytes and
saved receipts, then commits the revision and terminal run atomically. A failed
step exposes no partial revision. Unknown remote completion is interrupted;
it never triggers an automatic paid resubmission.

A recovered pending workflow may start with its durable document/run IDs only
when the raw stored snapshot is exactly an unstarted snapshot: empty context,
state, execution paths and resume/wait maps; no invocation/result/error data;
the same run ID and current serialized graph (or the exact prior six-step graph only for configurations without a guide). Read this evidence through the
public workflow store because the processed workflow view omits raw fields.
Running snapshots use restart and preserve completed steps. A pending snapshot
with any execution evidence fails closed: installed Mastra restart resets such
snapshots to the first step.

Verification uses the real Mastra engine with fixture adapters, durable stores,
malformed responses, cancellation and restart. Live text and scanned PDFs are
separate integration checks within the user's shared authorized budget.

The installed @mastra/libsql1.27.0 interprets maxRetries as the total attempt
count in its snapshot write loop. Zero performs no write and throws an
unexpected-loop-exit error. Configure one to allow one local write attempt;
this does not enable model or transport retries. A real stored-workflow
regression test covers stage execution and snapshot persistence.

Muse review runs inside the step that owns the unit and adds no workflow steps, so snapshots and resume are unchanged; see [Muse review](muse-review.md). Figure crop review runs inside the extraction step after each page's figures are cropped; the extraction checkpoint holds the reviewed crops and their records.

New execution is Meta-only across every stage, including resumed checkpoints. Reject stale non-Meta configurations before preflight or spending. Meta extraction loops physical pages serially inside the existing extraction stage; its checkpoint retains every page receipt, including reused attempts. Historical published revisions remain readable.
