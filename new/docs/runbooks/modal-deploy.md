# Judge deployment on Modal

`deploy/modal/app.py` runs one always-on AmuseMe container (`min_containers=1`, `max_containers=1`) behind Modal's HTTPS proxy. Judges type an email to sign in, see the shared examples read-only and can upload 3 PDFs each. Processing uses its own budget ID (`amuseme-modal-judges-2026-11`) with $100, below the $360.564373 ceiling in `src/processing/config.ts`, so the ceiling is unchanged.

| Resource | Name |
|---|---|
| App / URL label | `amuseme-judges` → `https://<workspace>--amuseme-judges.modal.run` (`<workspace>` is your Modal workspace name; `modal deploy` prints the URL) |
| Volume | `amuseme-judges-data`, data under `/amuseme` |
| Secret | `amuseme-judges-secrets`: `BETTER_AUTH_SECRET` (≥32 random characters), `META_API_KEY`, optional `AMUSEME_JUDGE_ACCESS_CODE` |

SQLite and the process lock need a local filesystem, so the container restores the volume to local disk at start, writes a consistent snapshot back every 60 seconds and once more on exit. Each snapshot backs up the databases first, then copies document files, so the saved rows never point at files missing from the volume. The app is separate from the MinerU app and its resources.

A crash can lose up to a minute of document and account changes. The provider spending ledger is tighter: every 2 seconds the container checks `provider_attempts` and `provider_charges` and snapshots at once when they change. Reservations are written before a provider call is sent, so a crash loses a reservation only if it happens within about 2 seconds plus one snapshot's duration of that write, or while the volume is unreachable (failed snapshots are retried every 2 seconds and logged). Spend in that window would not count against the $100 budget after restart; check Meta's usage page after any crash.

## Seeded data

`deploy/modal/seed_examples.py` reads a local data directory read-only and writes a new directory containing only:

- `application.sqlite`: a backup with every row removed except the examples owner's active, finished documents, their runs and published outputs. Accounts, sessions, admission keys, provider attempts, the spending ledger, ratings, retry and cleanup rows are deleted; the schema version is kept and checked.
- `documents/<id>/`: those documents' original PDFs and hash-named output objects.

It never copies `auth.sqlite`, `mastra.sqlite`, SQLite sidecars, the lock file, `uploads/`, `processing/`, `archives/`, `legacy-records/` or backups. The examples stay readable for 30 days from seeding (`--expires-days`). The deployed app creates its own empty `auth.sqlite`; the examples owner needs no account there.

## Steps

Run from the repository root with Python 3.11+.

Offline checks for both scripts (no Modal SDK needed): `python3 -I -m unittest discover -s tests/deploy`.

```sh
pip install modal
modal token new

# 1. Pick the examples owner and documents (read-only on the source).
DATA=/path/to/local/data
python3 -I deploy/modal/seed_examples.py --source "$DATA" --list
python3 -I deploy/modal/seed_examples.py --source "$DATA" --owner <USER_ID> --out /tmp/amuseme-seed
#   add --only <DOCUMENT_ID> (repeatable) to drop duplicates

# 2. Create the volume and upload the seed once, before the first deploy.
modal volume create amuseme-judges-data
modal volume put amuseme-judges-data /tmp/amuseme-seed /amuseme
modal volume ls amuseme-judges-data /amuseme      # expect application.sqlite and documents/

# 3. Create the secret from a private file (mode 0600, outside the repo) with
#    BETTER_AUTH_SECRET=..., META_API_KEY=... and optionally AMUSEME_JUDGE_ACCESS_CODE=...
modal secret create amuseme-judges-secrets --from-dotenv /path/to/private/amuseme-judges.env

# 4. Deploy. The origin must equal the URL deploy prints; if it differs, redeploy with the printed one.
AMUSEME_ORIGIN=https://<workspace>--amuseme-judges.modal.run AMUSEME_EXAMPLES_OWNER_ID=<USER_ID> \
  modal deploy --strategy recreate deploy/modal/app.py

# 5. Check.
curl -fsS https://<url>/health/ready               # {"status":"ready"}
curl -fsS https://<url>/auth/sign-in-options       # {"method":"email","accessCode":false}
```

Then open the URL, sign in with an email, open an example, and confirm the upload box says "3 uploads left of 3".

Optional overrides at deploy time: `AMUSEME_UPLOADS_PER_USER`, `AMUSEME_BUDGET_ID`, `AMUSEME_PROCESSING_BUDGET_USD`. Keep the same budget ID across redeploys.

## Redeploy, stop, logs

```sh
modal app stop amuseme-judges        # wait until `modal container list` shows no amuseme-judges container
AMUSEME_ORIGIN=... AMUSEME_EXAMPLES_OWNER_ID=... modal deploy --strategy recreate deploy/modal/app.py
modal app logs amuseme-judges
```

Stopping first lets the old container write its final snapshot before the new one restores. Never seed (`modal volume put`) over a volume that has served judges: it would overwrite the application database, including judges' uploads and the budget ledger. To turn off uploads without stopping the app, redeploy with `META_API_KEY` removed from the secret.
