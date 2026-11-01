---
name: no-comments
description: "Spawn the comment-sicko subagent, fix accepted findings, and offer encodings for claimed constraints."
---

# No comments

On Codex, read the [platform mapping](../poteto-mode/references/codex-tools.md), including its per-skill notes, before following this skill.

On GitHub Copilot, read the [platform mapping](../poteto-mode/references/copilot-tools.md), including its per-skill notes, before following this skill.

On Muse, read the [platform mapping](../poteto-mode/references/muse-tools.md), including its per-skill notes, before following this skill.

Spawn comment-sicko. Act on accepted findings.

Defer to comment-sicko's fresh perspective.

## Scope

Use the caller's files or diff. Otherwise use the current diff against the base branch, default `main`, including the working tree.

## Steps

1. Spawn `Agent` with `subagent_type: "pstack:comment-sicko"`. Pass the scope. Pick each subagent's reasoning level for the job, per the Subagents section of the **poteto-mode** skill. Do not restate its rules.
2. Inspect its report and diff. Reject application-code edits, scope escapes, exception-protected deletions, misstated `MUST KILL` reasons, and flags that treat kept intentional code as guilty. Reshape flags on our-code surprises stay actionable. Investigate reshape flags and preserve necessary constraints until a verified replacement or safe removal exists. Audit missed scoped lint and TypeScript suppressions. Correctness or safety suppressions stay actionable `MUST KILL`s. Restore deletions only with exact exceptions and scoped proof. Before accepting thin `IMPORTANT` or `do not remove` kills or keeps, run `/how` or `/why` on their symbol. If a deletion or retained constraint is ambiguous, investigate before changing it. Preserve a potentially necessary safeguard until its replacement or safe removal is verified. Reject unsupported reports and retry with the failure named or assign another independent reviewer. Do not lower the review requirement; a real reviewer-access blocker leaves the review incomplete while independent fixes continue.
3. Fix trivial accepted flags directly by deleting a dead path, dropping a parameter, or using the real API. If any fix needs a shape, run `/architect` once for the accepted set and surrounding code. Use the sketch to continue directly into implementation in step 4.
4. Implement the smallest root-cause fix in scope. Remove every named workaround. If the root cause is out of scope, land the smallest in-scope fix and report the rest open. The **principle-fix-root-causes** and **principle-redesign-from-first-principles** skills guide intent only. Neither authorizes widening the fence nor fixing instances outside it. Never bolt on symptom guards.
5. Preserve constraints expressed by comments. Within an authorized cleanup, replace a constraint with the smallest suitable type, runtime check, test, or lint rule and verify it before deleting the comment. Keep the comment if its constraint cannot yet be preserved. Ask only when encoding requires new authority or a material decision; do not delete a safeguard and leave its constraint unenforced.
6. Report verified cleanup, preserved constraints, and any concrete blocker. Required fixes remain owned and incomplete until verified; unrelated findings may be reported separately.
