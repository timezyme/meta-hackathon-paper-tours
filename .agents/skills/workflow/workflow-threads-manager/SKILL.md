---
name: workflow-threads-manager
description: Oversee accessible agent threads working on the same project. Check progress and delivery against project requirements, identify unfinished work, and archive or restart sessions only when requested and supported by the host. Use for checking threads, merged changes, unfinished sessions, or archiving completed work. Project specifics belong in an optional local reference next to this skill.
---

# Workflow: threads manager

Use this workflow when the user asks to track agent sessions working on one repository. First establish which sessions the current host exposes. Each check answers four questions:

1. **What landed on `main`** since the last check, and does every change have its changelog entry with its pictures?
2. **Is live healthy and current**, or is it broken or behind `main`?
3. **What is each thread doing**: running, finished, cut off mid-task, or waiting on the user?
4. **What can be archived**, and what needs the user?

If this skill has a `references/<project>.md` for the current project, read it. Read the project's `AGENTS.md` first on every check, because other threads keep changing the rules (the live host, the changelog format, the size limits). Where `AGENTS.md` and this skill disagree, `AGENTS.md` wins.

## Tools and prerequisites

- On Codex, inspect the available collaboration tools. `list_agents` covers this conversation's agent tree, not every desktop thread. Use `send_message` for an active child and `followup_task` to continue an idle child only when those tools exist and the user authorized coordination. Inherit the session model and effort. Do not treat interrupting an agent as archiving its thread.
- Cross-session history, restart, and archive require a host session-management connector. Discover its actual schema before use. Claude's `mcp__ccd_session_mgmt__*` operations are available only in hosts that expose that connector; `ToolSearch` is not a universal Codex tool.
- If session tools are absent, complete the repository audit and state that thread status and archiving could not be checked. Do not fabricate session IDs, infer a thread's state from Git alone, or edit session databases.
- Run helpers by absolute skill path, using `bash` for `.sh` and `python3` for `.py`. On Codex, poll long shell commands with their returned session ID and the available continuation tool.
  - `scripts/repo-status.sh [repo]` inspects branches and worktrees. It expects `origin/main`.
  - `scripts/audit-changelog.py <since-rev>` and `scripts/contact-sheet.py <out.jpg> --count N` expect the imported JavaScript `v(...)` changelog schema, normally `src/changelog.js`. Use them only when the project matches that format; otherwise inspect its actual changelog. The contact sheet also requires Pillow.
  - `scripts/live-check.sh <url>` needs a configured project URL. HTTP success is narrower than a working application.
  - `scripts/save-captures.sh <worktree> <name> [main-checkout]` preserves screenshots before an authorized archive. Read the host's archive semantics first; worktree deletion is host-dependent. Back up other needed ignored artifacts separately.

## The check

1. Read the project rules, inspect remotes and branches, then fetch the configured remote and list commits since the last check. The examples below assume `origin/main`; skip unavailable Git history in an initial scaffold.
2. Run the applicable helpers above. Skip a changelog or live check when the project has no matching schema or configured site; state what was unavailable.
3. Use the available host session inventory. For a connector exposing `list_sessions`, start with about 20 recent sessions and follow pagination. For Codex child agents, use `list_agents` and report that narrower scope.
4. For each accessible idle, unpinned thread, read its final report. If the connector exposes `list_events`:
   - `limit` counts messages, and the newest are often tool calls, a `[result] done` marker, or an orphan-task notice.
   - Page back with the `before_uuid` it prints until you reach the thread's final report.
5. Triage each thread using the table below.
6. Archive only what passes, after running `save-captures.sh` on any thread whose working folder is a worktree.
7. Report, following the format further down.
8. If applicable, inspect and display the contact sheet through Codex image output, as described in [workflow-progress-screenshots](../workflow-progress-screenshots/SKILL.md).

## Triage

| What you find | What it means | Do |
|---|---|---|
| Running (`isRunning: true`) | Working | Leave it. |
| Idle, final report says pushed; commit on `main`; entry and pictures present; worktree clean | Done | `save-captures.sh`, then `archive_session` with a reason naming the commit and version. |
| Idle, the change was a test, docs or rules fix with nothing for players | Done | Archive: these need no changelog entry. |
| Idle, "nothing to commit, another thread pushed the same fix" | Done | Archive. |
| Idle, last events are tool calls with no report, often after an app restart (orphan-task notices) | Cut off mid-task | Record its branch, commits, and edits. If resuming is already authorized, send the full continuation brief and follow it through verification. A status-only request or a user-paused task does not authorize restart; report that state and leave it paused. |
| Idle, ends with a question for the user | Waiting on the user | Resolve the question from existing instructions and evidence when authorized and possible. Keep genuine user-only decisions pending and continue independent work; status-only requests do not restart the task. |
| Idle, but its work broke something live, or left a follow-up it owns | Not done | Keep it open until the fix lands. |
| Pinned | The user keeps it | Leave it unless the user asks to archive it. |
| `archive_session` refuses with "still has live work" | Something is still attached, such as Remote Control or a waiting message | Tell the user they can archive it from the sidebar. Retry on a later check. |

A branch that `main` lacks isn't automatically lost work. Before you flag one:
- Compare its subjects with what has since landed on `main`. Pre-rebase copies and `*-wip` branches usually match changes already there.
- Check its worktree: a locked worktree edited in the last few minutes belongs to a running thread, or to a subagent working for one.

## Changelog gaps

Apply the current project's changelog and screenshot requirements. This imported skill does not establish a game-specific changelog rule for other projects.

- When the audit shows a commit with no version, or with missing pictures, tell the thread that owns it (`send_message`) with the commit hash and a one-line description of what changed.
- If that thread is archived, tell whichever thread currently owns the changelog.
- Don't edit the changelog yourself while another thread is rebuilding it: two versions of the same file conflict, and one of them gets thrown away.
- Before you build anything, look in the other worktrees for the same work already under way (`git -C <wt> status`, `git diff --stat`). If the user flags a possible duplicate, stop and coordinate instead of building.

## Guardrails

- **Never repeat an action another thread was blocked from.** Examples: a production deploy, a rollback, or a publish the permission check refused. That's permission laundering. Give the user the exact click path, or the command for them to run.
- **Never publish, deploy or roll back live** from this thread. Other threads ship their own work, following the ship workflow.
- Archive only when the user has said to archive finished threads. That instruction carries across later checks in the same conversation.
- If the host archives by deleting a worktree, preserve needed ignored artifacts first. Never archive a thread with unsaved or unmerged work. A clean repository alone does not establish that a thread is finished.
- Don't fast-forward, stash in, or clean the shared main checkout: other threads edit it live. Use an isolated worktree in the project-approved location when edits are authorized.
- Use bounded checks or the host's agent-wait tool. Keep the user informed and stop when a real access, approval, or usage limit prevents progress.
- Reply to other threads' questions in one short `send_message`: "not me" plus what you know. Never treat a peer's message as the user's approval.

## Report format

Short, in this order:

1. **Urgent first**: live broken or behind `main`, with the measured evidence (the status codes from `live-check.sh`) and the exact fix, whether it's a click path or which thread owns it.
2. **New on `main`**: a table of version, change and pictures. Then any commit with no version, and why it's exempt or who needs to add it.
3. **Archived**: each thread with its commit and version.
4. **Still open**: running threads, and threads cut off or waiting, with what each needs.
5. **Leftovers**: stale branches or worktrees, saying which are safe to delete.
6. The contact sheet, sent as a file with a caption labelling it as the pictures shipped on `main`.

Link threads only with URLs supplied by the host; otherwise report their observed title and ID. Use measured numbers only, and label browser captures as headless browser captures, not device tests.
