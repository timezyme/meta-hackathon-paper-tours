---
name: workflow-ship-change
description: Verify and deliver a repository change through the commit, push, merge, or deployment stages the user requested. Use for shipping, publishing, or release preparation. Respect project release rules and existing authorization; invoking this skill does not grant permission to publish.
---

# Ship a change

Read the project's `AGENTS.md` and any matching project reference first. Establish the requested delivery stage, branch, remote, test commands, changelog convention, and deployment target from current instructions and configuration. Do not infer a live site, framework, game, or standing authorization from this imported skill. Complete the authorized stages and report exactly where delivery stops.

## 1. Inspect the checkout

Check status and existing staged files. Preserve other sessions' work and inspect relevant worktrees before overlapping edits. Use an isolated worktree when concurrent changes require one. Fetch the configured remote when needed; do not assume `origin/main` exists in a new repository.

## 2. Verify the change

Run checks appropriate to the changed behavior. For visual work, use [workflow-progress-screenshots](../workflow-progress-screenshots/SKILL.md) to inspect and display real before/after captures. Add a changelog entry and pictures when the project requires them, using its actual schema.

On Codex, run long commands with the available shell tool, retain the returned process/session identifier, and poll it with the matching continuation tool. Do not invent a `run_in_background` parameter. Check completion and exit status before reporting a pass.

## 3. Commit when authorized

Review the diff and staged contents. Stage explicit task-owned paths only. Do not include credentials, local environment files, dependencies, caches, or generated build output unless the project deliberately versions that output. Never overwrite another session's index or amend someone else's commit.

Use `bash <skill-dir>/scripts/commit-size.sh` to measure staged content when a size report is needed. Use the repository's commit convention; add attribution only when the current host or project specifies it.

## 4. Integrate and push when authorized

Fetch the destination and integrate its latest commits without rewriting shared history. Preserve concurrent changes, resolve conflicts, and rerun affected checks before pushing. Verify the resulting remote revision.

`bash <skill-dir>/scripts/push-main.sh` is specifically for an authorized fast-forward from HEAD to `origin/main`. Read it before use and use it only when those names match the project. It measures the pack, refuses over 50 MB, and checks the remote revision. Do not split an upload to evade a size limit. If an existing authorization does not cover the target or measured upload size, prepare the concrete result before requesting it.

## 5. Publish when authorized

Build the exact verified revision in a clean checkout. Use the project's configured provider and release procedure. Preview first when supported, exercise the deployed behavior, then verify production after promotion. Do not infer a Netlify, Supabase, media-storage, or gate-route contract from the helper scripts.

`bash <skill-dir>/scripts/upload-size.sh <directory>` measures an upload. Apply the project's upload limits; absent another limit, request approval above 50 MB unless the user already authorized that size.

`bash <skill-dir>/scripts/verify-live.sh <url> [extra-path ...]` checks HTTP responses for the page and referenced assets. Optional `AUTH_PATH` expects an unauthenticated POST to return 400, 401, or 403; `PRIVATE_PATH` expects an unauthenticated GET to return 401, 403, or a redirect. Use them only when those contracts match the project. HTTP checks complement browser and application tests; they do not prove the whole release works.

If automatic approval rejects an action, stop that action and report the reason. Do not retry through another tool or agent. If a release breaks production, report the measured failure immediately and use only an authorized recovery procedure.

## Report

State what changed, the completed delivery stages and revision, relevant test results, and any unverified stage. For deployment, include the verified URL and provider evidence. Include captures for visual changes and measured sizes when requested or required by a limit. Never call a local commit pushed or a deployment live without checking it.
