"""Offline checks for deploy/modal. Run: python3 -I -m unittest discover -s tests/deploy"""

import contextlib
import importlib.util
import io
import os
import pathlib
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest import mock

DEPLOY = pathlib.Path(__file__).resolve().parents[2] / "deploy/modal"


def fake_modal():
    class Image:
        def __init__(self):
            self.environment = {}

        def env(self, values):
            self.environment.update(values)
            return self

        def __getattr__(self, name):
            return lambda *args, **kwargs: self

    identity = lambda *args, **kwargs: (lambda value: value)
    return SimpleNamespace(
        is_local=lambda: False, Image=Image(), App=lambda name, **kwargs: SimpleNamespace(cls=identity),
        Volume=SimpleNamespace(from_name=lambda name, **kwargs: SimpleNamespace(commit=lambda: None)),
        Secret=SimpleNamespace(from_name=lambda name, **kwargs: name),
        concurrent=identity, enter=identity, exit=identity, web_server=identity,
    )


def load(name):
    spec = importlib.util.spec_from_file_location(f"deploy_{name}", DEPLOY / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    with mock.patch.dict(sys.modules, {"modal": fake_modal()}):
        spec.loader.exec_module(module)
    return module


def execute(path, *statements):
    connection = sqlite3.connect(path)
    try:
        with connection:
            for statement in statements:
                connection.execute(*statement) if isinstance(statement, tuple) else connection.execute(statement)
    finally:
        connection.close()


def rows(path, sql):
    connection = sqlite3.connect(path)
    try:
        return connection.execute(sql).fetchall()
    finally:
        connection.close()


class Snapshot(unittest.TestCase):
    def setUp(self):
        self.app = load("app")
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.local, self.remote = os.path.join(root.name, "local"), os.path.join(root.name, "vol", "amuseme")
        os.makedirs(os.path.join(self.local, "documents"))
        for name, value in (("LOCAL_DATA", self.local), ("REMOTE_DATA", self.remote)):
            patcher = mock.patch.object(self.app, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.database = os.path.join(self.local, "application.sqlite")
        execute(self.database, "CREATE TABLE documents (id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL)",
                "CREATE TABLE provider_attempts (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
                "CREATE TABLE provider_charges (attempt_id TEXT PRIMARY KEY, reserved_microusd INTEGER NOT NULL, actual_microusd INTEGER)")

    def admit(self, document_id):
        directory = os.path.join(self.local, "documents", document_id)
        os.makedirs(directory)
        pathlib.Path(directory, "source.pdf").write_bytes(b"%PDF-" + document_id.encode())
        execute(self.database, ("INSERT INTO documents VALUES (?, 'active')", (document_id,)))

    def purge(self, document_id):
        execute(self.database, ("UPDATE documents SET lifecycle = 'deleted' WHERE id = ?", (document_id,)))
        for name in os.listdir(os.path.join(self.local, "documents", document_id)):
            os.remove(os.path.join(self.local, "documents", document_id, name))
        os.rmdir(os.path.join(self.local, "documents", document_id))

    def assert_snapshot_consistent(self):
        active = rows(os.path.join(self.remote, "application.sqlite"), "SELECT id FROM documents WHERE lifecycle = 'active'")
        for (document_id,) in active:
            self.assertTrue(os.path.isfile(os.path.join(self.remote, "documents", document_id, "source.pdf")), document_id)

    def test_document_admitted_during_snapshot_is_never_referenced_without_its_files(self):
        self.admit("first")
        real = self.app.sync_documents

        def sync_then_admit(*args):
            real(*args)
            self.admit("raced")

        with mock.patch.object(self.app, "sync_documents", sync_then_admit):
            self.app.snapshot()
        self.assert_snapshot_consistent()
        self.app.snapshot()
        self.assert_snapshot_consistent()
        self.assertEqual(rows(os.path.join(self.remote, "application.sqlite"), "SELECT count(*) FROM documents"), [(2,)])

    def test_document_deleted_during_snapshot_keeps_files_referenced_by_the_snapshot(self):
        self.admit("kept")
        self.app.snapshot()
        real = self.app.remove_missing

        def delete_then_remove(*args):
            self.purge("kept")
            real(*args)

        with mock.patch.object(self.app, "remove_missing", delete_then_remove):
            self.app.snapshot()
        self.assert_snapshot_consistent()
        self.app.snapshot()
        self.assertFalse(os.path.exists(os.path.join(self.remote, "documents", "kept")))

    def test_document_deleted_before_its_files_are_copied_keeps_the_previous_snapshot(self):
        self.admit("first")
        self.app.snapshot()
        self.admit("uncopied")
        real = self.app.sync_documents

        def delete_then_sync(*args):
            self.purge("uncopied")
            real(*args)

        with mock.patch.object(self.app, "sync_documents", delete_then_sync), self.assertRaises(Exception) as raised:
            self.app.snapshot()
        snapshot = os.path.join(self.remote, "application.sqlite")
        documents = lambda: rows(snapshot, "SELECT id, lifecycle FROM documents ORDER BY id")
        self.assert_snapshot_consistent()
        self.assertEqual(documents(), [("first", "active")])
        self.assertIsInstance(raised.exception, self.app.IncompleteSnapshot)
        self.app.snapshot()
        self.assert_snapshot_consistent()
        self.assertEqual(documents(), [("first", "active"), ("uncopied", "deleted")])
        self.assertFalse(os.path.exists(os.path.join(self.remote, "documents", "uncopied")))

    def test_ledger_write_is_snapshotted_within_seconds(self):
        snapshots = threading.Event()
        instance = object.__new__(self.app.AmuseMe)
        instance.lock, instance.stopping = threading.Lock(), threading.Event()
        instance.server = SimpleNamespace(poll=lambda: None)
        with mock.patch.object(self.app, "snapshot", snapshots.set), mock.patch.object(self.app, "SNAPSHOT_SECONDS", 3600), \
                mock.patch.object(self.app, "LEDGER_POLL_SECONDS", 0.05, create=True):
            worker = threading.Thread(target=instance.snapshots, daemon=True)
            worker.start()
            time.sleep(0.2)
            snapshots.clear()
            time.sleep(0.2)
            self.assertFalse(snapshots.is_set())
            execute(self.database, "INSERT INTO provider_attempts VALUES ('a', 1, 1)", "INSERT INTO provider_charges VALUES ('a', 5, NULL)")
            try:
                self.assertTrue(snapshots.wait(2))
            finally:
                instance.stopping.set()
                worker.join(2)


class Environment(unittest.TestCase):
    def test_container_trusts_only_the_modal_proxy_for_client_addresses(self):
        environment = load("app").image.environment
        self.assertEqual(environment["AMUSEME_TRUSTED_PROXY"], "modal")
        self.assertEqual((environment["AMUSEME_HOST"], environment["NODE_ENV"]), ("0.0.0.0", "production"))


class Watcher(unittest.TestCase):
    def setUp(self):
        self.app = load("app")
        self.instance = object.__new__(self.app.AmuseMe)
        self.instance.lock, self.instance.stopping = threading.Lock(), threading.Event()
        self.snapshots, self.exits = [], []
        for name, value in (("LEDGER_POLL_SECONDS", 0.01), ("SNAPSHOT_SECONDS", 0), ("ledger_watermark", lambda: None),
                            ("snapshot", lambda: self.snapshots.append(time.monotonic()))):
            patcher = mock.patch.object(self.app, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = mock.patch.object(self.app.os, "_exit", self.exits.append)
        patcher.start()
        self.addCleanup(patcher.stop)

    def watch(self, seconds=2):
        output = io.StringIO()
        worker = threading.Thread(target=self.instance.snapshots, daemon=True)
        with contextlib.redirect_stdout(output):
            worker.start()
            worker.join(seconds)
        self.instance.stopping.set()
        worker.join(2)
        return output.getvalue()

    def test_node_exit_saves_a_final_snapshot_and_exits_the_container_nonzero(self):
        self.instance.server = SimpleNamespace(poll=lambda: 137)
        log = self.watch()
        self.assertEqual(len(self.snapshots), 1)
        self.assertEqual(self.exits, [1])
        self.assertIn("exited with code 137", log)

    def test_node_stopped_by_container_shutdown_does_not_exit_the_container(self):
        self.instance.server = SimpleNamespace(poll=lambda: 0)
        self.instance.stopping.set()
        self.watch(0.2)
        self.assertEqual((self.snapshots, self.exits), ([], []))

    def test_snapshot_failure_logs_its_message_without_secrets(self):
        self.instance.server = SimpleNamespace(poll=lambda: None)
        secret = "meta-fixture-key-0123456789"

        def fail():
            raise sqlite3.OperationalError(f"disk I/O error near {secret}")

        with mock.patch.object(self.app, "snapshot", fail), mock.patch.dict(os.environ, {"META_API_KEY": secret}):
            log = self.watch(0.2)
        self.assertIn("AmuseMe snapshot failed: OperationalError: disk I/O error near [redacted]", log)
        self.assertNotIn(secret, log)
        self.assertEqual(self.exits, [])


class Seed(unittest.TestCase):
    def setUp(self):
        self.seed = load("seed_examples")
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.root = root.name
        self.source = os.path.join(root.name, "source")
        os.makedirs(os.path.join(self.source, "documents", "doc-1"))
        pathlib.Path(self.source, "documents", "doc-1", "source.pdf").write_bytes(b"%PDF-")
        execute(os.path.join(self.source, "application.sqlite"),
                "CREATE TABLE documents (id TEXT PRIMARY KEY, owner_id TEXT, document_json TEXT, lifecycle TEXT, expires_at INTEGER, latest_run_id TEXT)",
                "CREATE TABLE runs (id TEXT PRIMARY KEY, document_id TEXT, state TEXT)",
                "CREATE TABLE outputs (revision_id TEXT PRIMARY KEY, document_id TEXT)",
                *(f"CREATE TABLE {table} (secret TEXT)" for table in self.seed.CLEARED_TABLES),
                "INSERT INTO documents VALUES ('doc-1', 'owner', '{\"originalFilename\":\"a.pdf\"}', 'active', 0, 'run-1')",
                "INSERT INTO documents VALUES ('doc-2', 'other', '{\"originalFilename\":\"b.pdf\"}', 'active', 0, 'run-2')",
                "INSERT INTO runs VALUES ('run-1', 'doc-1', 'succeeded')", "INSERT INTO runs VALUES ('run-2', 'doc-2', 'succeeded')",
                "INSERT INTO provider_charges VALUES ('private')")

    def run_seed(self, out, owner="owner", only=()):
        with contextlib.redirect_stdout(io.StringIO()):
            self.seed.seed(self.source, owner, out, 30, set(only))

    def test_failed_validation_leaves_no_unsanitized_database(self):
        for owner, only in (("owner", ("missing",)), ("nobody", ())):
            out = os.path.join(self.root, f"out-{owner}")
            with self.assertRaises(SystemExit):
                self.run_seed(out, owner, only)
            self.assertFalse(os.path.exists(os.path.join(out, "application.sqlite")))
            self.assertEqual(sorted(os.listdir(self.root)), ["source"])

    def test_successful_seed_moves_only_sanitized_data_into_place(self):
        out = os.path.join(self.root, "out")
        os.makedirs(out)
        self.run_seed(out)
        self.assertEqual(sorted(os.listdir(self.root)), ["out", "source"])
        self.assertEqual(os.stat(out).st_mode & 0o777, 0o700)
        database = os.path.join(out, "application.sqlite")
        self.assertEqual(rows(database, "SELECT id FROM documents"), [("doc-1",)])
        self.assertEqual(rows(database, "SELECT count(*) FROM provider_charges"), [(0,)])
        self.assertEqual(os.listdir(os.path.join(out, "documents")), ["doc-1"])


if __name__ == "__main__":
    unittest.main()
