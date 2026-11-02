# Repository agent skills

These are the repository's adapted agent instructions and their supporting files. They are development tools, outside the application reconstruction and the hackathon new-work inventory.

The completion fixes remove arbitrary retry limits, repeated approval requests for already authorized work, silent scope reductions, and premature handoffs. Explicit user pauses, read-only scope, access controls, spending limits, and genuine approval requirements remain in force.

## Sources and licenses

- `pstack/` is the locally adapted pstack skill collection. Its MIT license is in `pstack/LICENSE`; additional upstream notices are retained in `pstack/poteto-mode/references/licenses/`.
- The interface skills in `../.agents/skills/` retain their individual MIT licenses and supporting references. Repository workflow adaptations are retained alongside their helpers.
- `browser-verify`, `live-paid-run`, `guide-accuracy-review` and `submission-sync` in `../.agents/skills/` are repository-authored AmuseMe workflow skills with no third-party source. The first three are identical copies of the application checkout's skills; `submission-sync` exists only here. The worker-brief rule in `iterate-until-verified` is a repository addition, also kept identical with the application copy.
- This snapshot includes dependencies of the edited skills so their referenced playbooks and scripts remain available after cloning. It does not install a global plugin or configure machine-local memory.

## Verification

Run the completion-rule regression tests from the repository root:

```sh
bun test ./skills/pstack/poteto-mode/scripts/check-plan.test.ts
```

The tests cover proportional verification scenarios, justified exclusions, evidence requirements, explicit review gates, and Markdown fence handling. The workflow skills have no automated tests. After editing one, compare it with the application copy (`diff -r ../amuseme-app/.agents/skills/<name> .agents/skills/<name>`) and check its commands against the current scripts and runbooks. Inspect instruction edits for continued ownership of requested work while preserving the user's authority and explicit stops.
