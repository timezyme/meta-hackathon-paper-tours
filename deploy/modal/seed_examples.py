"""Build a seed data directory that holds only one owner's finished documents.

The source directory is opened read-only. The output contains:

- application.sqlite: a SQLite backup of the source with every row deleted except
  the chosen owner's active documents whose latest run finished, their runs and
  their published outputs. Accounts, sessions, admission keys, provider attempts,
  spending ledger rows, ratings, retry and cleanup records are all removed.
- documents/<id>/: the original PDF and hash-named output objects of those
  documents only.

It never copies auth.sqlite, mastra.sqlite, SQLite sidecars, the process lock,
uploads/, processing/, archives/, legacy-records/ or backups.

It builds in a private (0700) sibling staging directory and moves it to --out only
after every check passes; on failure the staging directory is deleted.

    python3 -I deploy/modal/seed_examples.py --source DATA_DIR --list
    python3 -I deploy/modal/seed_examples.py --source DATA_DIR --owner USER_ID --out OUT_DIR [--only DOCUMENT_ID ...]
"""

import argparse
import datetime
import json
import os
import shutil
import sqlite3
import stat
import sys
import tempfile
from contextlib import closing

FINISHED = ("succeeded", "succeeded-with-issues")
CLEARED_TABLES = (
    "admission_requests", "accepted_jobs", "provider_attempts", "provider_charges", "ratings",
    "document_policies", "retry_requests", "retry_authorizations", "remote_cleanup", "validator_repairs",
)
TEMPORARY = (".source.tmp", ".blob-")


def open_read_only(path):
    return closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True))


def finished_documents(connection, owner=None):
    query = (
        "SELECT d.id, d.owner_id, json_extract(d.document_json, '$.originalFilename') FROM documents d "
        "JOIN runs r ON r.id = d.latest_run_id WHERE d.lifecycle = 'active' AND r.state IN (?, ?)"
    )
    rows = connection.execute(query + ("" if owner is None else " AND d.owner_id = ?"), FINISHED + (() if owner is None else (owner,))).fetchall()
    return sorted(rows, key=lambda row: (row[1], row[2], row[0]))


def list_owners(source):
    with open_read_only(os.path.join(source, "application.sqlite")) as connection:
        for document_id, owner, filename in finished_documents(connection):
            print(f"{owner}  {document_id}  {filename}")


def copy_tree(source, target):
    for root, directories, files in os.walk(source):
        relative = os.path.relpath(root, source)
        os.makedirs(os.path.join(target, relative), mode=0o700, exist_ok=True)
        for name in directories + files:
            if os.path.islink(os.path.join(root, name)):
                raise SystemExit(f"Refusing symbolic link in document data: {os.path.join(relative, name)}")
        directories[:] = [name for name in directories if not name.startswith(TEMPORARY)]
        for name in files:
            if name.startswith(TEMPORARY) or name.endswith(".tmp"):
                continue
            destination = os.path.join(target, relative, name)
            shutil.copyfile(os.path.join(root, name), destination)
            os.chmod(destination, 0o600)


def seed(source, owner, out, expires_days, only):
    if os.path.exists(out) and os.listdir(out):
        raise SystemExit(f"Output directory is not empty: {out}")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    staging = tempfile.mkdtemp(prefix=f".{os.path.basename(out)}.", dir=os.path.dirname(out))
    try:
        summary = build(source, owner, staging, expires_days, only)
        os.rename(staging, out)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    print(json.dumps(summary, indent=2))


def build(source, owner, out, expires_days, only):
    os.chmod(out, 0o700)
    database = os.path.join(out, "application.sqlite")
    with open_read_only(os.path.join(source, "application.sqlite")) as origin, closing(sqlite3.connect(database)) as copy:
        origin.backup(copy)
    os.chmod(database, 0o600)
    expires_at = int((datetime.datetime.now(datetime.UTC) + datetime.timedelta(days=expires_days)).timestamp()) * 1000
    expires_iso = datetime.datetime.fromtimestamp(expires_at / 1000, datetime.UTC).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    connection = sqlite3.connect(database)
    try:
        version = connection.execute("PRAGMA user_version").fetchone()[0]
        kept = [row for row in finished_documents(connection, owner) if not only or row[0] in only]
        if only and len(kept) != len(set(only)):
            raise SystemExit("Some --only IDs are not finished active documents of this owner")
        if not kept:
            raise SystemExit(f"No finished active documents belong to {owner}")
        ids = [row[0] for row in kept]
        marks = ",".join("?" for _ in ids)
        with connection:
            connection.execute("PRAGMA foreign_keys = OFF")
            for table in CLEARED_TABLES:
                connection.execute(f"DELETE FROM {table}")
            connection.execute(f"DELETE FROM outputs WHERE document_id NOT IN ({marks})", ids)
            connection.execute(f"DELETE FROM runs WHERE document_id NOT IN ({marks})", ids)
            connection.execute(f"DELETE FROM documents WHERE id NOT IN ({marks})", ids)
            connection.execute(
                f"UPDATE documents SET expires_at = ?, document_json = json_set(document_json, '$.expiresAt', ?) WHERE id IN ({marks})",
                [expires_at, expires_iso, *ids],
            )
            active = connection.execute("SELECT count(*) FROM runs WHERE state NOT IN ('succeeded','succeeded-with-issues','failed','interrupted')").fetchone()[0]
            if active:
                raise SystemExit("A kept document still has queued or running work")
        connection.execute("VACUUM")
        if connection.execute("PRAGMA user_version").fetchone()[0] != version:
            raise SystemExit("Schema version changed while seeding")
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise SystemExit("Seeded database failed its integrity check")
        counts = {table: connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for table in ("documents", "runs", "outputs")}
    finally:
        connection.close()
    for document_id in ids:
        directory = os.path.join(source, "documents", document_id)
        if not stat.S_ISDIR(os.lstat(directory).st_mode):
            raise SystemExit(f"Missing document directory: {document_id}")
        copy_tree(directory, os.path.join(out, "documents", document_id))
    os.chmod(os.path.join(out, "documents"), 0o700)
    return {"owner": owner, "expiresAt": expires_iso, "rows": counts, "documents": [{"id": row[0], "file": row[2]} for row in kept]}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", required=True, help="Local AmuseMe data directory (read-only)")
    parser.add_argument("--list", action="store_true", help="List finished active documents by owner and exit")
    parser.add_argument("--owner", help="User ID whose finished documents become the shared examples")
    parser.add_argument("--out", help="New, empty output directory")
    parser.add_argument("--only", action="append", default=[], metavar="DOCUMENT_ID", help="Keep only this document (repeatable)")
    parser.add_argument("--expires-days", type=int, default=30, help="Days the examples stay readable (default 30)")
    args = parser.parse_args()
    source = os.path.abspath(args.source)
    if args.list:
        return list_owners(source)
    if not args.owner or not args.out:
        parser.error("--owner and --out are required unless --list is given")
    if not 1 <= args.expires_days <= 365:
        parser.error("--expires-days must be between 1 and 365")
    seed(source, args.owner, os.path.abspath(args.out), args.expires_days, set(args.only))


if __name__ == "__main__":
    sys.exit(main())
