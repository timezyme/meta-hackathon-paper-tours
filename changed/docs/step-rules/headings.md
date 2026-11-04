# Heading decisions

1. Input is immutable Extraction plus its fully checked CorrectedText. Every original heading and paragraph is a candidate, in source order, including paragraphs without Markdown marks. Lists, captions, references, notes, tables, equations, and figures remain content, not candidates.
2. Send the full corrected document, including references, notes, tables, captions, and image links, with all candidate IDs. Spark 1.3 uses medium reasoning and an Effect-derived strict object schema containing HeadingDecision records. Require exactly one decision per candidate in order, levels 1–6 or explicit null, and at most one title at level 1. A promoted heading must occupy one whole block.
3. Apply decisions to copied blocks. Null demotes an original heading to prose and removes its leading heading mark; a retained/promoted heading receives its decided mark. Only then apply consecutive proposed prose joins, allowing only classified page furniture across the next page boundary while preserving it separately. Keep retained headings, lists, equations, references, and tables separate. Joined blocks retain all original source IDs and locations in order.
4. Export the decisions, final blocks, applied join count, and changed heading count for canonical assembly. Keep the original source extraction unchanged. Formatting retains every block and native figure link; do not copy the legacy bibliography/footer dropping behavior.
5. The manager owns guard persistence, receipt acceptance, retries, deadline/cancellation, and workflow ordering. Pure builders reject excessive context/bytes before dispatch without truncation. No fallback invents heading decisions after a provider failure. A rejected answer goes to [Muse review](muse-review.md); if review cannot correct it, the extractor's own classification is kept (heading marks give levels, unmarked heading blocks get level 2, paragraphs stay paragraphs, one level-1 title).

Ported from the normalization source at revision `abc31fb7745ecb973bbf0261a9e82f52ea8f17ad`, source rules 6 and 8, inspected October 27, 2026:

- `src/paper/heading-check-prompt.ts`: SHA-256 `e7b0cf2267a150f047216c61e843516ed2374a961cb2265dac551e0aaf08feee`.
- `src/paper/heading-correction.ts`: `c67e305ed8b5e2b78eae6769ac4f98b6c5f37199373dd511815c93f403f96ead`.

Adaptations: full-document evidence, every eligible source ID, explicit null instead of positional text labels, strict validation instead of fallback labels, and deferred safe joins. Join/formatter provenance is recorded in [page-check.md](page-check.md).
