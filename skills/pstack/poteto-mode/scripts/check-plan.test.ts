import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "bun:test";

const checker = join(import.meta.dir, "check-plan.mjs");
const rule =
	"A PR is verified only when its required checks pass and completion evidence is recorded.";

const validPlan = `# Demo

## How to read this
One box is one unit of work and names the evidence. Check a box only when its evidence exists. See playbooks/.
${rule}

## Program checklist
### Arm the program
- [ ] Write the standing orders. Read the playbook from the installed plugin. Arm the hourly audit tick.
### Spawn owners
- [ ] Spawn one owner per PR.
### PR mechanics
- [ ] Open each PR ready.
### Verdict and merge
- [ ] Record each verdict.
### Boot recipe
\`git show origin/main:\` /loop 1h status message
- [ ] Boot each live lane.

## PR 1
**Depends on.** None.
**Files.**
- [ ] Do the thing.
**Build.**
- [ ] Do the thing.
**You see.**
- [ ] Do the thing.
**Verify, unit.** ${rule}
- [ ] Check the thing.
**Verify, live.** ${rule} Ten lanes on the configured \`swarm workers\` model at the PR head
${Array.from({ length: 10 }, (_, i) => `- [ ] Lane ${i + 1}. Save \`lane-${i + 1}.png\`. Pass when evidence exists.`).join("\n")}
**Verify, perf.** ${rule}
- [ ] Metric. Recorded.
- [ ] Probe. Recorded.
- [ ] Baseline. Recorded.
- [ ] Rule. Recorded.
**Review gate.** None.
**Merge.**
- [ ] Merge when approved.

## Close the program
- [ ] Close.

## Appendix Prototype evidence
Recorded.
`;

const runPlan = (example: string, expectedExit: number, plan = validPlan) => {
	const directory = mkdtempSync(join(tmpdir(), "check-plan-test-"));
	const file = join(directory, "plan.md");
	writeFileSync(file, plan + example);
	try {
		const result = spawnSync("node", [checker, file], { encoding: "utf8" });
		expect(result.status).toBe(expectedExit);
		return result;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
};

const liveBlock = /\*\*Verify, live\.\*\*[\s\S]*?(?=\*\*Verify, perf\.\*\*)/;
const perfBlock = /\*\*Verify, perf\.\*\*[\s\S]*?(?=\*\*Review gate\.\*\*)/;
const oneLane = `**Verify, live.** ${rule}\n- [ ] Lane 1. Inspect the saved artifact. Save \`review.txt\`. Pass when all required content is present.\n`;

test("accepts one relevant scenario without a worker quota or hourly scheduling", () => {
	const plan = validPlan.replace(liveBlock, oneLane).replace("Arm the hourly audit tick.", "Report progress.");
	runPlan("", 0, plan);
});

test("accepts justified inapplicable performance and live checks", () => {
	const plan = validPlan
		.replace(perfBlock, `**Verify, perf.** ${rule} None. Prose changes do not affect runtime performance.\n`)
		.replace(liveBlock, `**Verify, live.** ${rule} None. There is no executable behavior; the saved document is inspected under unit checks.\n`);
	runPlan("", 0, plan);
});

test("rejects unexplained or contradictory verification exclusions", () => {
	for (const block of [liveBlock, perfBlock]) {
		const name = block === liveBlock ? "live" : "perf";
		for (const suffix of ["None.", "None. No runtime change.\n- [ ] Still run a check."]) {
			runPlan("", 1, validPlan.replace(block, `**Verify, ${name}.** ${rule} ${suffix}\n`));
		}
	}
});

test("rejects missing evidence, missing pass criteria, and duplicate scenario numbers", () => {
	for (const lane of [
		oneLane.replace("Save `review.txt`.", ""),
		oneLane.replace("Pass when all required content is present.", ""),
		oneLane + "- [ ] Lane 1. Save `second.txt`. Pass when checked.\n",
	]) runPlan("", 1, validPlan.replace(liveBlock, lane));
});

test("requires all performance measurement fields when performance applies", () => {
	for (const name of ["Metric", "Probe", "Baseline", "Rule"]) {
		runPlan("", 1, validPlan.replace(`- [ ] ${name}. Recorded.\n`, ""));
	}
});

test("accepts an explicit operator review gate without mandatory video", () => {
	const gate = "**Review gate.** User requested copy approval.\n- [ ] Show the exact revised copy to the operator and record approval.";
	runPlan("", 0, validPlan.replace("**Review gate.** None.", gate));
	runPlan("", 1, validPlan.replace("**Review gate.** None.", "**Review gate.** User requested copy approval."));
});

test("accepts the template shipped with the planning workflow", () => {
	const workflow = readFileSync(join(import.meta.dir, "../playbooks/multi-phase-plan.md"), "utf8");
	const template = workflow.split("````markdown\n")[1]?.split("\n````")[0];
	expect(template).toBeDefined();
	runPlan("", 0, template);
});

test("accepts ordinary, indented, and longer closing fences", () => {
	for (const indent of ["", " ", "  ", "   "])
		runPlan(`${indent}\`\`\`markdown\n## Example only\n${indent}\`\`\`\n`, 0);
	runPlan("```markdown\n## Example only\n````\n", 0);
});

test("accepts nested backticks and tilde info strings", () => {
	runPlan("````markdown\n```markdown\n## Example only\n```\n````\n", 0);
	runPlan("~~~markdown `info`\n## Example only\n ~~~\n", 0);
});

test("keeps mismatched, shorter, and suffixed closers inside the fence", () => {
	runPlan("````markdown\n~~~\n## Example only\n````\n", 0);
	runPlan("````markdown\n```\n## Example only\n````\n", 0);
	runPlan("````markdown\n``` info\n## Example only\n````\n", 0);
});

test("rejects headings and prose outside a proper close", () => {
	for (const suffix of ["  ", "\t"]) {
		const heading = runPlan(`\`\`\`markdown\n## Example only\n\`\`\`${suffix}\n## Example only\n`, 1);
		expect(heading.stderr).toContain('"## Example only" after Close the program is not an appendix');
	}

	const prose = runPlan("```markdown\nThis prose has a mid-sentence colon: inside code\n```\nThis prose has a mid-sentence colon: bad.\n", 1);
	expect(prose.stderr).toContain("mid-sentence colon");
});

test("rejects backtick info strings containing a backtick", () => {
	const result = runPlan("```markdown `invalid`\n## Example only\n```\n", 1);
	expect(result.stderr).toContain('"## Example only" after Close the program is not an appendix');
});
