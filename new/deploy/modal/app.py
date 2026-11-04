"""AmuseMe judge deployment on Modal: one always-on container serving the guarded app.

Deploy from the repository root (see docs/runbooks/modal-deploy.md):

    AMUSEME_ORIGIN=https://<workspace>--amuseme-judges.modal.run \
    AMUSEME_EXAMPLES_OWNER_ID=<user id> \
    modal deploy --strategy recreate deploy/modal/app.py

SQLite and the process lock need a local POSIX filesystem, so the app runs on
container disk. Startup restores the volume snapshot to local disk; a
background thread and container exit write a consistent snapshot back
(SQLite online backups first, then document files, then the databases, then
removals the backed-up databases no longer need). A candidate whose backed-up
active documents were deleted before their files were copied is discarded, so
the previous complete snapshot stays. The thread also snapshots within seconds
of any provider ledger change. If Node exits on its own, the thread saves a
last snapshot and exits the container nonzero so Modal replaces it.
"""

import os
import pathlib
import shutil
import signal
import sqlite3
import subprocess
import tempfile
import threading
import time
from contextlib import closing

import modal

APP_NAME = "amuseme-judges"
VOLUME_NAME = "amuseme-judges-data"
SECRET_NAME = "amuseme-judges-secrets"
NODE_VERSION = "24.19.0"
PNPM_VERSION = "10.33.0"
PORT = 8000
APP_ROOT = "/opt/amuseme"
PYTHON_ENV = "/opt/amuseme-python"
VOLUME_ROOT = "/vol"
REMOTE_DATA = f"{VOLUME_ROOT}/amuseme"
LOCAL_DATA = "/srv/amuseme-data"
SNAPSHOT_SECONDS = 60
LEDGER_POLL_SECONDS = 2
DATABASES = ("application.sqlite", "auth.sqlite", "mastra.sqlite")
SECRET_NAME_PARTS = ("SECRET", "KEY", "TOKEN", "PASSWORD", "ACCESS_CODE")
TRANSIENT = ("uploads", "processing", "archives")
REPO = pathlib.Path(__file__).resolve().parents[2] if modal.is_local() else pathlib.Path(APP_ROOT)

IGNORE = [
    ".git", ".github", "node_modules", "**/node_modules", ".env", ".env.*", "data", "qa", ".mastra", "dist",
    "src/mastra/public", "prototype", "brand", "docs/plans", "docs/research", "docs/verification",
    ".agents", ".claude", ".codex", "skills", ".memsearch", ".audit", "**/__pycache__", "**/*.sqlite*", "**/.DS_Store",
]


def deploy_settings():
    if not modal.is_local():
        return {}
    missing = [name for name in ("AMUSEME_ORIGIN", "AMUSEME_EXAMPLES_OWNER_ID") if not os.environ.get(name)]
    if missing:
        raise SystemExit(f"Set {', '.join(missing)} before deploying")
    if not os.environ["AMUSEME_ORIGIN"].startswith("https://"):
        raise SystemExit("AMUSEME_ORIGIN must be the https:// Modal URL")
    return {
        "AMUSEME_ORIGIN": os.environ["AMUSEME_ORIGIN"],
        "AMUSEME_EXAMPLES_OWNER_ID": os.environ["AMUSEME_EXAMPLES_OWNER_ID"],
        "AMUSEME_UPLOADS_PER_USER": os.environ.get("AMUSEME_UPLOADS_PER_USER", "3"),
        "AMUSEME_BUDGET_ID": os.environ.get("AMUSEME_BUDGET_ID", "amuseme-modal-judges-2026-11"),
        "AMUSEME_PROCESSING_BUDGET_USD": os.environ.get("AMUSEME_PROCESSING_BUDGET_USD", "100"),
    }


image = (
    modal.Image.from_registry("python:3.14.5-slim-bookworm")
    .apt_install("ca-certificates", "curl", "xz-utils", "procps")
    .run_commands(
        f"curl -fsSLO https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-x64.tar.xz",
        f"curl -fsSL https://nodejs.org/dist/v{NODE_VERSION}/SHASUMS256.txt | grep ' node-v{NODE_VERSION}-linux-x64.tar.xz$' | sha256sum -c -",
        f"tar -xJf node-v{NODE_VERSION}-linux-x64.tar.xz -C /usr/local --strip-components=1 && rm node-v{NODE_VERSION}-linux-x64.tar.xz",
        f"npm install -g pnpm@{PNPM_VERSION}",
    )
    .add_local_file(REPO / "python/requirements.txt", "/opt/amuseme-requirements.txt", copy=True)
    .run_commands(
        f"python -m venv {PYTHON_ENV}",
        f"{PYTHON_ENV}/bin/pip install --no-cache-dir -r /opt/amuseme-requirements.txt",
        f"{PYTHON_ENV}/bin/python -I -c 'import pymupdf; print(pymupdf.VersionBind)'",
    )
    .add_local_dir(REPO, APP_ROOT, copy=True, ignore=IGNORE)
    .run_commands(f"cd {APP_ROOT} && pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild esbuild && pnpm build")
    .env({
        "AMUSEME_PORT": str(PORT), "AMUSEME_HOST": "0.0.0.0", "AMUSEME_DATA_DIR": LOCAL_DATA,
        "AMUSEME_PYTHON_BIN": f"{PYTHON_ENV}/bin/python", "AMUSEME_JUDGE_SIGN_IN": "true", "AMUSEME_PROCESSING_ENABLED": "true",
        "AMUSEME_TRUSTED_PROXY": "modal",
        "MASTRA_STUDIO_PATH": ".mastra/output/studio", "MASTRA_TELEMETRY_DISABLED": "true", "MASTRA_AGENT_SIGNALS": "false",
        "NODE_ENV": "production", **deploy_settings(),
    })
)

app = modal.App(APP_NAME, image=image)
volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=False)


def private_tree(root):
    os.chmod(root, 0o700)
    for directory, directories, files in os.walk(root):
        for name in directories:
            os.chmod(os.path.join(directory, name), 0o700)
        for name in files:
            os.chmod(os.path.join(directory, name), 0o600)


def restore():
    os.makedirs(LOCAL_DATA, mode=0o700, exist_ok=True)
    if os.path.isdir(REMOTE_DATA):
        shutil.copytree(REMOTE_DATA, LOCAL_DATA, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("*.tmp", "*-wal", "*-shm", "*-journal", ".amuseme-process.lock"))
    private_tree(LOCAL_DATA)


def sync_documents(local_root, remote_root):
    for directory, directories, files in os.walk(local_root):
        relative = os.path.relpath(directory, local_root)
        directories[:] = [name for name in directories if not name.startswith(".")]
        os.makedirs(os.path.join(remote_root, relative), exist_ok=True)
        for name in files:
            if name.startswith(".") or name.endswith(".tmp"):
                continue
            source, target = os.path.join(directory, name), os.path.join(remote_root, relative, name)
            info = os.stat(source)
            if os.path.exists(target) and os.stat(target).st_size == info.st_size and int(os.stat(target).st_mtime) == int(info.st_mtime):
                continue
            shutil.copy2(source, target + ".tmp")
            os.replace(target + ".tmp", target)


def remove_missing(local_root, remote_root, keep):
    if not os.path.isdir(remote_root):
        return
    for directory, directories, files in os.walk(remote_root, topdown=False):
        relative = os.path.relpath(directory, remote_root)
        if relative.split(os.sep)[0] in keep:
            continue
        for name in files:
            if not os.path.exists(os.path.join(local_root, relative, name)):
                os.remove(os.path.join(directory, name))
        if relative != "." and not os.path.exists(os.path.join(local_root, relative)):
            shutil.rmtree(directory, ignore_errors=True)


def backup(source, target):
    with closing(sqlite3.connect(f"file:{source}?mode=ro", uri=True, timeout=30)) as origin, closing(sqlite3.connect(target)) as copy:
        origin.backup(copy)


def active_documents(database):
    if not os.path.exists(database):
        return set()
    with closing(sqlite3.connect(f"file:{database}?mode=ro", uri=True)) as connection:
        return {row[0] for row in connection.execute("SELECT id FROM documents WHERE lifecycle = 'active'")}


def describe(error):
    message = f"{type(error).__name__}: {error}"
    for name, value in os.environ.items():
        if len(value) >= 8 and any(part in name.upper() for part in SECRET_NAME_PARTS):
            message = message.replace(value, "[redacted]")
    return message


def ledger_watermark():
    database = os.path.join(LOCAL_DATA, "application.sqlite")
    if not os.path.exists(database):
        return None
    with closing(sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=5)) as connection:
        return connection.execute(
            "SELECT (SELECT count(*) || ':' || ifnull(max(created_at), '') || ':' || ifnull(max(updated_at), '') FROM provider_attempts),"
            " (SELECT count(*) || ':' || total(reserved_microusd) || ':' || total(actual_microusd) FROM provider_charges)"
        ).fetchone()


class IncompleteSnapshot(Exception):
    pass


def snapshot():
    # The app writes document files before committing the rows that reference
    # them and removes files only after the row leaves 'active'. A document
    # active in the backups and still active after the copy kept its files
    # throughout, so they were copied. One that left 'active' in between may
    # have lost files before the copy, so that candidate is not promoted.
    os.makedirs(REMOTE_DATA, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="amuseme-snapshot-") as staging:
        staged = []
        for name in DATABASES:
            source = os.path.join(LOCAL_DATA, name)
            if os.path.exists(source):
                backup(source, os.path.join(staging, name))
                staged.append(name)
        sync_documents(os.path.join(LOCAL_DATA, "documents"), os.path.join(REMOTE_DATA, "documents"))
        keep = active_documents(os.path.join(staging, "application.sqlite"))
        left = keep - active_documents(os.path.join(LOCAL_DATA, "application.sqlite"))
        if left:
            raise IncompleteSnapshot(f"{len(left)} backed-up active document(s) were removed during the file copy")
        for name in staged:
            target = os.path.join(REMOTE_DATA, name)
            shutil.copyfile(os.path.join(staging, name), target + ".tmp")
            os.replace(target + ".tmp", target)
    remove_missing(os.path.join(LOCAL_DATA, "documents"), os.path.join(REMOTE_DATA, "documents"), keep)
    for name in TRANSIENT:
        shutil.rmtree(os.path.join(REMOTE_DATA, name), ignore_errors=True)
    volume.commit()


@app.cls(
    secrets=[modal.Secret.from_name(SECRET_NAME)],
    volumes={VOLUME_ROOT: volume},
    min_containers=1,
    max_containers=1,
    timeout=60 * 60,
    cpu=2.0,
    memory=4096,
)
@modal.concurrent(max_inputs=200)
class AmuseMe:
    @modal.enter()
    def start(self):
        restore()
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.server = subprocess.Popen(["node", "dist/server.mjs"], cwd=APP_ROOT, env=dict(os.environ))
        threading.Thread(target=self.snapshots, daemon=True).start()

    def snapshots(self):
        watermark, due = None, time.monotonic() + SNAPSHOT_SECONDS
        while not self.stopping.wait(LEDGER_POLL_SECONDS):
            code = self.server.poll()
            if code is not None:
                if not self.stopping.is_set():
                    self.replace_container(code)
                return
            try:
                current = ledger_watermark()
                if current == watermark and time.monotonic() < due:
                    continue
                with self.lock:
                    snapshot()
                watermark, due = current, time.monotonic() + SNAPSHOT_SECONDS
            except Exception as error:
                print(f"AmuseMe snapshot failed: {describe(error)}", flush=True)

    def replace_container(self, code):
        print(f"AmuseMe server exited with code {code}; saving a last snapshot and exiting the container", flush=True)
        with self.lock:
            try:
                snapshot()
            except Exception as error:
                print(f"AmuseMe snapshot failed: {describe(error)}", flush=True)
            os._exit(1)

    @modal.web_server(PORT, startup_timeout=300, label=APP_NAME)
    def web(self):
        pass

    @modal.exit()
    def stop(self):
        self.stopping.set()
        if self.server.poll() is None:
            self.server.send_signal(signal.SIGTERM)
            deadline = time.monotonic() + 15
            while self.server.poll() is None and time.monotonic() < deadline:
                time.sleep(0.2)
        with self.lock:
            snapshot()
