# Muse review

Covers: agent:extraction-review, agent:page-check-review, agent:headings-review, agent:figures-review, agent:guide-review

1. Every Muse stage unit (extraction page, checked page, the heading pass, one figure, the guide) runs inside its existing workflow step. When the stage check rejects the unit's answer, the stage's reviewer runs next for that unit. No reviewer call is made for an answer that passes, so a clean run costs nothing extra.
2. Reviewers are registered Mastra agents with stable IDs `<stage>-review` (name "AmuseMe <stage> review"). They are created and registered with the stage agents in `makeMetaAgentBoundary` and accept only the same adapter-issued permit, bound to the reviewer's own agent ID. They keep one step, no tools, no memory and zero model, processor and transport retries.
3. The check is the stage validator plus checks that would otherwise fail a later step: page checks must not fix or join a block that an earlier page's check already used. Validators report concrete problems by block, figure or quote. The guard stores the first problems as the rejection message.
4. The reviewer gets what a human editor would: the unit's original evidence exactly as sent (text and, for extraction, page checking and figures, the image), then `museReview` with the original stage brief, the rejected answer, its SHA-256 and the problem list. It answers in the stage's schema. Its system prompt is the versioned brief `<stage>-review` / `amuseme-1` from `src/domain/prompt-templates.ts`; the stage's model, effort and output limit are unchanged.
5. A review is a normal guarded attempt with the `review` retry tag: it reserves the stage's maximum charge, gets a receipt, counts toward the run cap, the authorized budget and `maxProviderAttempts` for the unit, and keeps the reservation of the remaining mandatory stages free. The round and rejected-answer hash are part of the request, so the fingerprint is deterministic. Resume and retry replay saved answers and saved rejections (`ProviderGuard.rejected`) without another paid call. Existing fingerprints are unchanged, so no pipeline or prompt version changed.
6. At most two review rounds run per unit. When review cannot run (attempt allowance, budget, preflight or transient provider failure) or its answer is still invalid, the stage's safe fallback applies. Unknown completion, conflicts and storage failures still stop the run.
7. Fallbacks keep source text intact and downstream validation strict:
   - page checking keeps only the fixes and joins that pass every check alone, at worst no changes;
   - headings keep the extractor's classification (heading marks give the level, paragraphs stay paragraphs, one level-1 title);
   - a figure is published without an AI description;
   - the document is published without a reading guide;
   - extraction has no independent text source, so a page still invalid after review fails the run.
8. `processing-report.json` lists each review under optional `museReviews`: stage, reviewer agent, units, problems, rounds, attempt IDs, outcome `corrected` or `fallback`, and the fallback used. Each non-figure fallback also adds a `provider-failure` issue, so the run is `succeeded-with-issues`. Publication accepts a page without an accepted page-check receipt, or a configured guide that is missing, only when such a fallback is recorded. Older reports without the field still decode.
9. Tests cover correction on review, exhausted review, an attempt-limited fallback without review, zero-call replay of saved reviews, and the report records.
