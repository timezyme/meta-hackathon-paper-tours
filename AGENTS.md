# AmuseMe repository guide

## Repository layout

This repository is the public submission, not the full application checkout. Read [README.md](README.md), [NEW-WORK.md](NEW-WORK.md), and [VERIFICATION.md](VERIFICATION.md) for setup, provenance, and the limits of existing verification.

- `new/` contains added application files. `changes.json` records changes to the separate frozen foundation; `reconstruct.py` rebuilds the application from both.
- Follow the reconstructed application's setup and checks when changing application behavior. Keep the submission inventory and reconstruction inputs consistent with those changes.
- Regenerate and verify the inventory with [submission sync](.agents/skills/submission-sync/SKILL.md).
- Keep the submission history separate from application development history. Never merge or push inherited application history into this repository.
- Keep credentials, private documents, runtime data, generated memory, and audit backups out of commits. Preserve third-party licenses and notices.

## Agent tools

Repository skills live in `.agents/skills/` and `skills/pstack/`. See [skill provenance and checks](skills/README.md). On Codex, use pstack's [tool mapping](skills/pstack/poteto-mode/references/codex-tools.md).

For plan-checker changes, run `bun test ./skills/pstack/poteto-mode/scripts/check-plan.test.ts`. Match other checks to the changed behavior; application build checks require the reconstructed checkout.
