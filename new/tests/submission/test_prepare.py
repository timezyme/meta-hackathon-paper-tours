import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/submission/prepare.py'
spec = importlib.util.spec_from_file_location('submission', SCRIPT)
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


class SubmissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.base = self.root / 'base'
        self.tree = self.root / 'tree'
        self.base.mkdir()
        self.tree.mkdir()
        s.write_file(self.base, 'dir/a.txt', b'OLD_PRIVATE_MARKER same line\nCONTEXT_PRIVATE_MARKER\n', True)
        s.write_file(self.tree, 'dir/a.txt', b'NEW_VISIBLE_MARKER same line\nCONTEXT_PRIVATE_MARKER\n', False)
        s.write_file(self.tree, 'new.txt', b'new file\n', True)
        item = s.record('dir/a.txt', b'OLD_PRIVATE_MARKER same line\nCONTEXT_PRIVATE_MARKER\n', True)
        self.manifest = self.root / 'manifest.json'
        self.manifest.write_text(json.dumps({'files': [item]}))
        self.bundle = self.root / 'bundle'
        s.prepare(SimpleNamespace(baseline=str(self.base), manifest=str(self.manifest), manifest_sha256=hashlib.sha256(self.manifest.read_bytes()).hexdigest(), tree=str(self.tree), output=str(self.bundle), new_file=['new.txt']))
        self.args = SimpleNamespace(candidate=str(self.bundle / 'candidate'), archive=str(self.bundle / 'foundation.zip'), output=str(self.root / 'result'))

    def tearDown(self):
        self.tmp.cleanup()

    def test_round_trip_bytes_modes_and_no_old_lines(self):
        s.reconstruct(self.args)
        self.assertEqual(s.read_regular(Path(self.args.output), 'dir/a.txt'), (b'NEW_VISIBLE_MARKER same line\nCONTEXT_PRIVATE_MARKER\n', False))
        self.assertEqual(s.read_regular(Path(self.args.output), 'new.txt'), (b'new file\n', True))
        changes = (self.bundle / 'candidate/changes.json').read_text()
        self.assertNotIn('OLD_PRIVATE_MARKER', changes)
        self.assertNotIn('CONTEXT_PRIVATE_MARKER', changes)
        self.assertIn('NEW_VISIBLE_MARKER', changes)
        self.assertIn('dir/a.txt', (self.bundle / 'candidate/NEW-WORK.md').read_text())
        self.assertIn('new.txt', (self.bundle / 'candidate/NEW-WORK.md').read_text())

    def test_existing_target(self):
        Path(self.args.output).mkdir()
        with self.assertRaises(ValueError):
            s.reconstruct(self.args)
        self.assertEqual(list(Path(self.args.output).iterdir()), [])

    def test_tampered_archive(self):
        with zipfile.ZipFile(self.args.archive, 'w') as z:
            i = zipfile.ZipInfo('dir/a.txt')
            i.create_system = 3
            i.external_attr = (0o100755 << 16)
            z.writestr(i, b'bad\nunchanged\n')
        with self.assertRaises(ValueError):
            s.reconstruct(self.args)
        self.assertFalse(Path(self.args.output).exists())

    def test_traversal_archive(self):
        with zipfile.ZipFile(self.args.archive, 'w') as z:
            z.writestr('../evil', b'bad')
        with self.assertRaises(ValueError):
            s.reconstruct(self.args)
        self.assertFalse((self.root / 'evil').exists())

    def test_wrong_baseline_manifest(self):
        args = SimpleNamespace(baseline=str(self.base), manifest=str(self.manifest), manifest_sha256='0' * 64, tree=str(self.tree), output=str(self.root / 'other'), new_file=[])
        with self.assertRaises(ValueError):
            s.prepare(args)
        self.assertFalse((self.root / 'other').exists())

    def test_mode_only_change(self):
        original = b'UNCHANGED_PRIVATE_MARKER\n'
        ops = s.patch(original, original)
        self.assertEqual(s.apply_patch(original, ops), original)
        self.assertNotIn('UNCHANGED_PRIVATE_MARKER', json.dumps(ops))
        s.write_file(self.base, 'mode.txt', original, False)
        s.write_file(self.tree, 'mode.txt', original, True)
        manifest = {'files': [s.record('mode.txt', original, False)]}
        self.manifest.write_text(json.dumps(manifest))
        out = self.root / 'mode-bundle'
        s.prepare(SimpleNamespace(baseline=str(self.base), manifest=str(self.manifest), manifest_sha256=s.digest(self.manifest.read_bytes()), tree=str(self.tree), output=str(out), new_file=[]))
        result = self.root / 'mode-result'
        s.reconstruct(SimpleNamespace(candidate=str(out / 'candidate'), archive=str(out / 'foundation.zip'), output=str(result)))
        self.assertEqual(s.read_regular(result, 'mode.txt'), (original, True))

    def test_reject_private_new_files(self):
        for name in ('.env.local', '.codex/config.toml', 'src/.mcp.json', '.memsearch/index', 'secrets/token'):
            with self.subTest(name=name):
                args = SimpleNamespace(baseline=str(self.base), manifest=str(self.manifest), manifest_sha256=s.digest(self.manifest.read_bytes()), tree=str(self.tree), output=str(self.root / 'forbidden'), new_file=[name])
                with self.assertRaises(ValueError):
                    s.prepare(args)
                self.assertFalse((self.root / 'forbidden').exists())

    def test_symlink_archive(self):
        with zipfile.ZipFile(self.args.archive, 'w') as z:
            i = zipfile.ZipInfo('dir/a.txt')
            i.create_system = 3
            i.external_attr = (0o120777 << 16)
            z.writestr(i, b'OLD_PRIVATE_MARKER same line\nCONTEXT_PRIVATE_MARKER\n')
        with self.assertRaises(ValueError):
            s.reconstruct(self.args)


if __name__ == '__main__':
    unittest.main()
