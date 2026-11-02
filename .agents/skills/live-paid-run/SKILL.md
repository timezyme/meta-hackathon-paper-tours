---
name: live-paid-run
description: Run an authorized paid AmuseMe upload against the live server, from ceiling raise to spend report. Use when the user authorizes processing real documents, asks to raise the processing allowance, or asks what a run cost.
---

# Run authorized paid processing

Proceed only when the user's own message states a dollar amount and a document count. An agent brief is not authorization. Work from the amuseme-app root.

## Size the allowance

Reservations are $4 per page, $1.50 for headings, $1.50 for the guide and $1.50 per described figure, capped at $30 per document. New ceiling = current ceiling + the authorized amount. Keep the budget ID.

## Raise the ceiling and enable processing

1. Back up the data directory: read `AMUSEME_DATA_DIR` from `qa/goal-first-20261101/server-live.env` and copy it to a dated sibling (`cp -Rp "$DATA" "$DATA.backup-YYYYMMDD-HHMM"`).
2. Raise `Schema.isLessThanOrEqualTo(...)` in `src/processing/config.ts`, the matching case in `tests/server/config.test.ts`, and the "Processing allowance" section of `docs/runbooks/application-operations.md` (the "Current cumulative ceiling" line plus a dated `###` entry naming the amount and documents).
3. `cp -p qa/goal-first-20261101/server-live.env qa/goal-first-20261101/server-live.env.before-<purpose>-YYYYMMDD`, then set `AMUSEME_PROCESSING_ENABLED=true` and `AMUSEME_PROCESSING_BUDGET_USD=<ceiling>`.
4. Full restart; a `--watch` restart does not re-read `--env-file`:
   `kill $(pgrep -f "server-live.env --watch src/server/main.ts")`, wait until port 4184 is free (`lsof -i :4184`), then
   `nohup ./node_modules/.bin/../node/bin/node --env-file=qa/goal-first-20261101/server-live.env --watch src/server/main.ts >> <log> 2>&1 &`.
5. Confirm `GET /api/documents` reports `upload.availability._tag == "enabled"`.

Do not edit the server import graph (`src/domain`, `src/server`, `src/storage`, `src/processing`, `src/paper`, `src/mastra`) while a run is in flight; the watch restart kills it.

## Upload and poll, one document at a time per account

```sh
O='Origin: http://127.0.0.1:4184'; J=qa/<run>/cookies.txt
set -a; . qa/goal-first-20261101/native-test-account.env; set +a
jq -n --arg e "$AMUSEME_INVITE_EMAIL" --arg p "$AMUSEME_INVITE_PASSWORD" '{email:$e,password:$p}' |
  curl -s -c $J -H "$O" -H 'content-type: application/json' --data @- http://127.0.0.1:4184/auth/sign-in/email >/dev/null
curl -s -b $J -H "$O" -H "idempotency-key: $(uuidgen)" -F file=@<pdf> http://127.0.0.1:4184/api/documents   # 202 {documentId,runId}
curl -s -b $J http://127.0.0.1:4184/api/documents/<id>/status | jq '.state._tag, .state.progress.stage'
```

States: `queued`, `running` (with `progress.stage`), `succeeded`, `failed`, `interrupted`. A failure does not authorize retries or extra documents.

## Close out

1. Set `AMUSEME_PROCESSING_ENABLED=false` and full-restart again; confirm availability is no longer enabled.
2. Report spend from `sqlite3 -readonly "$DATA/application.sqlite"`: join `provider_charges(attempt_id, budget_id, reserved_microusd, actual_microusd)` to `provider_attempts(id, run_id, document_id, status)` for the run. Report reservations separately from measured billing; `actual_microusd` is usually null.
3. Hand the outputs to [guide accuracy review](../guide-accuracy-review/SKILL.md) by a different agent.
