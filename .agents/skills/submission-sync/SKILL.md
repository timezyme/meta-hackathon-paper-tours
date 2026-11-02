---
name: submission-sync
description: Regenerate this submission's changes.json, NEW-WORK.md, submission.json and new/ from the amuseme-app checkout, then prove reconstruction matches. Use when application work must be reflected in the submission, when files were added or deleted in the app, or before updating VERIFICATION.md.
---

# Sync the submission from amuseme-app

Read `amuseme-app/docs/step-rules/submission-preparation.md` first. Never copy app Git history here. `A=../amuseme-app`, `W=` a fresh scratch directory outside both repositories.

## Regenerate

```sh
curl -fL https://github.com/timezyme/amuseme-foundation/releases/download/foundation-2026-10-28/foundation.zip -o $W/foundation.zip
mkdir $W/baseline && unzip -q $W/foundation.zip -d $W/baseline        # unzip keeps executable bits
jq -r '.newFiles[]' submission.json > $W/new-files.txt                  # then add new app files, remove deleted ones
python3 $A/scripts/submission/prepare.py prepare --baseline $W/baseline \
  --manifest foundation-manifest.json --manifest-sha256 "$(jq -r .foundationManifestSha256 submission.json)" \
  --tree $A --output $W/out $(sed 's/^/--new-file /' $W/new-files.txt)
```

Every new file needs its own `--new-file`; untracked files are never swept in. A file deleted from the app must leave `new-files.txt`. Read every added line and new file in `$W/out/candidate` for credentials, private documents, runtime data, generated memory and non-event work before copying.

## Copy into this repository

```sh
C=$W/out/candidate
cp $C/changes.json $C/submission.json $C/NEW-WORK.md $C/reconstruct.py $C/foundation-manifest.json .
rsync -a --delete $C/new/ new/
```

Do not copy the candidate's generic `README.md` or `.gitignore`. Diff `NEW-WORK.md` before overwriting and keep any maintained notes.

## Prove it

```sh
python3 reconstruct.py reconstruct --candidate . --archive $W/foundation.zip --output $W/rebuilt
```

Compare every path in `submission.json` between `$W/rebuilt` and `$A` by bytes and executable mode. In `$W/rebuilt`, `git init`, install pinned dependencies as its README says, then run `python3 -m unittest discover -s tests/submission -v`, `pnpm check`, `pnpm test` and `pnpm build`.

Update `VERIFICATION.md` with only what was actually run: file counts (changed, new, preserved), commands, results, and whether dependencies were a clean install or a linked existing installation. Do not commit or push unless the user asks.
