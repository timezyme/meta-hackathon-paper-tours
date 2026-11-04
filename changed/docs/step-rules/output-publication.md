# Output publication

The output store publishes one immutable revision only after every manifest
artifact is durable and its bytes, size, and SHA-256 match. Canonical document,
image manifest, and report bytes must exactly match their supplied domain
objects. Shared publication validation preserves source coverage and requires
accepted page-check receipts. Each report receipt must also match its durable
provider-attempt record; callers cannot manufacture processing provenance.
Configured reading guides require their accepted matching guide receipt and a passed check. Exact quotations must resolve uniquely within immutable source blocks. The output store also verifies the saved response hash, compares its guide content byte-for-byte semantically with the published guide, and verifies the assembled source/context hash from its receipt. Historical outputs without guide configuration remain valid.

Within one SQLite transaction, recheck the current document/claim/lease, insert
the manifest, mark the matching run successful (with issues when present), and
remove its queue entry. No user observes a successful half-written output.
Ordinary run updates reject successful states; the dispatcher confirms the
already-published state returned by the workflow instead of publishing it again.
Publication performs no model calls and does not retry a failed provider.

All reads and replaceable ratings require the active owner and exact published
revision. Only manifest entries are downloadable. Expiry/deletion removes
publication and rating rows as well as the document's private artifact directory.
Failures return typed storage errors; they do not become empty successful files.

Tests exercise atomic visibility, missing/corrupt files, fabricated receipts,
lost/stale claims, cross-owner/revision denial, rating replacement, and deletion.

## Offline code-classification repair

The explicit maintenance command repairs the historical host conversion that
changed Meta `code` blocks into `unclassified`. It requires an active owner's
latest completed revision, no queued/running work, the exclusive process lock,
hash-verified prior artifacts, unchanged durable accepted receipts, and the saved
Meta extraction response identifying each exact block as code. It changes only
those block kinds, removes only their matching classification warnings, and
records the previous revision and changed IDs in the new report. Text, locations,
guide content, images, original revisions, receipts and all charges remain intact.

The guide is verified against its original generation context before this
classification-only repair; it is not represented as a new generation against
different block metadata. Normal publication cannot accept repair metadata.
The repair creates one new terminal local run/revision and switches the document
pointer atomically after export validation. It has no provider or dispatcher
dependency and cannot spend money. A stale revision, changed response, invalid
source mapping, or interrupted transaction fails without replacing the original.
