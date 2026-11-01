### Multi-phase or multi-PR plan

Plan the complete requested outcome. A planning-only request ends with a verified plan. When implementation is already authorized, continue from the plan through execution and verification without another approval pause.

1. For a small change with an obvious approach, use a short task list and perform the authorized work. Do not require a separate plan file.
2. Inspect the affected sources. Resolve technical questions through evidence and experiments; ask only for missing product decisions or authority. Keep read-only requests read-only.
3. Cover every requested outcome, dependency, owner, acceptance criterion, and authorized delivery stage. Choose an execution workflow that matches the user's request, including who may merge or publish. Delegate independent work only when useful.
4. For a multi-PR plan, fill the template below. Store it in the repository's plan directory or the user's requested location. Repeat the PR section as needed. Omit inapplicable work with a reason, not required outcomes.
5. Run `node skills/pstack/poteto-mode/scripts/check-plan.mjs <plan.md>` in this repository and fix reported problems. The checker validates structure; review coverage and applicability yourself.
6. For planning-only work, return the plan and validation result. For authorized implementation, execute the plan, fix failures, and verify the delivered result. A real blocker leaves the affected outcome incomplete. User stop and pause instructions take precedence.

**Verification.** A PR is verified only when its required checks pass and completion evidence is recorded. Select scenarios for the changed behavior and its normal, edge, failure, and regression cases. Record commands, evidence artifacts, and pass criteria. Measure performance when it is a requirement or affected by the change. Preserve project checks and required independent review. There is no fixed worker count or mandatory video. An operator review gate comes from the user's instructions or the project's authorization rules, not from changing an interaction alone.

````markdown
# <Program> plan

<Requested outcome, scope, and PR order.>

## How to read this

One box is one unit of work and names the evidence that checks it. Check a box only when its evidence exists. The execution workflow is `playbooks/<workflow>.md`. <State existing implementation and publication authority, who merges, and any explicit user review gates.>

A PR is verified only when its required checks pass and completion evidence is recorded.

## Program checklist

### Arm the program

- [ ] Map every requested outcome to work and acceptance evidence. Record existing authority and unresolved dependencies.
- [ ] Continue when execution is authorized. For a planning-only request, deliver the validated plan without executing its checklist.

### Spawn owners

- [ ] Assign an owner to each PR and record dependencies and file ownership. The primary agent may own the work directly.

### PR mechanics

- [ ] Record the base and candidate revisions. Run required checks with hooks enabled. Open or update PRs only when authorized.

### Verdict and merge

- [ ] Review the diff and evidence at the candidate revision. Complete required independent review, fix findings, and repeat affected checks.
- [ ] Complete the authorized delivery stages and verify their results.

### Boot recipe

- [ ] Record the commands, fixtures, serving revision, and driver needed to reproduce applicable checks.

## <Task as a verb phrase> (<PR id>)

**Depends on.** <PR id, or None.>

**Files.**

- [ ] <Exact files and changes.>

**Build.**

- [ ] <Complete behavior, owner, and integration work.>

**You see.**

- [ ] <Observable result and acceptance criterion.>

**Verify, unit.** A PR is verified only when its required checks pass and completion evidence is recorded.

- [ ] <Command and expected result. For prose-only work, name the document inspection and consistency checks.>

**Verify, live.** A PR is verified only when its required checks pass and completion evidence is recorded.

- [ ] Lane 1. <Scenario and driver.> Save `<evidence-path>`. Pass when <observable criterion>.

<Add numbered scenarios as needed. If no executable behavior is affected, replace the boxes with `None. <reason>` after the verification rule on the heading line. Document inspection remains required.>

**Verify, perf.** A PR is verified only when its required checks pass and completion evidence is recorded.

- [ ] Metric. <Measured quantity relevant to the change.>
- [ ] Probe. <Repeatable command or procedure.>
- [ ] Baseline. <Comparable baseline, or explain why only an absolute budget applies.>
- [ ] Rule. <Acceptance threshold.>

<If performance is unaffected and not requested, replace the boxes with `None. <reason>` after the verification rule on the heading line.>

**Review gate.** None. <Or name the explicit user or project requirement and add boxes recording the evidence presented to the operator and their approval.>

**Merge.**

- [ ] <Complete the authorized delivery stage and verify its revision. If delivery is local-only, record that boundary and verify the local artifact.>

## Close the program

- [ ] Reconcile every requested outcome with its evidence. Resolve required decisions and finish required work before reporting completion. Report a real blocker as incomplete work.
- [ ] Verify the final Git state required by the task without losing unrelated work. Report the result, verification, and material limitations.

## Appendix A. Prototype evidence

<Experiments and conclusions, or None with a reason.>
````

**Reply:** the requested deliverable, verification evidence, and actual delivery stage. Do not report implementation as complete when only a plan exists.
