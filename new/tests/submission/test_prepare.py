import binascii
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/submission/prepare.py'
spec = importlib.util.spec_from_file_location('submission', SCRIPT)
preparation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preparation)
submission = preparation.reconstruction

FOUNDATION = {
    'dir/a.txt': (b'OLD_PRIVATE_MARKER same line\nCONTEXT_PRIVATE_MARKER\n', True),
    'same.txt': (b'unchanged\n', False),
    'icon.png': (b'\x89PNG\r\n\x1a\nOLD_PRIVATE_ICON\xff', False),
    '.gitignore': (b'data/\n', False),
}
EVENT = {
    'dir/a.txt': (b'NEW_VISIBLE_MARKER same line\nCONTEXT_PRIVATE_MARKER\n', False),
    'same.txt': FOUNDATION['same.txt'],
    'icon.png': (b'\x89PNG\r\n\x1a\nNEW_ICON\xfe\x00', False),
    'new.txt': (b'new file\n', True),
    '.gitignore': (b'data/\nqa/\n', False),
}
VIEWS = {
    'changed/dir/a.txt': EVENT['dir/a.txt'][0],
    'diffs/dir/a.txt.diff': b'''diff --git a/dir/a.txt b/dir/a.txt
old mode 100755
new mode 100644
--- a/dir/a.txt
+++ b/dir/a.txt
@@ -1,2 +1,2 @@
-OLD_PRIVATE_MARKER same line
+NEW_VISIBLE_MARKER same line
 CONTEXT_PRIVATE_MARKER
''',
    # A copied .gitignore would hide files under changed/ from Git, so it only gets a diff.
    'diffs/.gitignore.diff': b'''diff --git a/.gitignore b/.gitignore
--- a/.gitignore
+++ b/.gitignore
@@ -1 +1,2 @@
 data/
+qa/
''',
}


# Fixtures are written with pathlib and hashlib, not with the module under test.
def put(root, name, data, executable=False):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    path.chmod(0o755 if executable else 0o644)


def entry(name, data, executable=False):
    return {'path': name, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'executable': executable}


def tree_state(root):
    return {path.relative_to(root).as_posix(): (path.read_bytes(), bool(path.stat().st_mode & 0o111))
            for path in root.rglob('*') if path.is_file()}


def flip_last_byte(data):
    return data[:-1] + bytes([data[-1] ^ 1])


class SubmissionTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.base, self.tree = self.root / 'base', self.root / 'tree'
        for name, (data, executable) in FOUNDATION.items():
            put(self.base, name, data, executable)
        for name, (data, executable) in EVENT.items():
            put(self.tree, name, data, executable)
        self.manifest = self.root / 'manifest.json'
        self.write_manifest(FOUNDATION)
        self.bundle = self.prepare('bundle', ['new.txt'])
        self.candidate = self.bundle / 'candidate'
        self.archive = self.bundle / 'foundation.zip'
        self.output = self.root / 'result'

    def write_manifest(self, files):
        self.manifest.write_text(json.dumps({'files': [entry(name, *value) for name, value in files.items()]}))

    def prepare_args(self, output, new_file, manifest_sha256=None, deleted_file=()):
        sha256 = manifest_sha256 or hashlib.sha256(self.manifest.read_bytes()).hexdigest()
        return SimpleNamespace(baseline=str(self.base), manifest=str(self.manifest), manifest_sha256=sha256,
                               tree=str(self.tree), output=str(self.root / output), new_file=new_file,
                               deleted_file=list(deleted_file))

    def prepare(self, output, new_file):
        preparation.prepare(self.prepare_args(output, new_file))
        return self.root / output

    def reconstruct(self, bundle=None, output=None):
        bundle = bundle or self.bundle
        submission.reconstruct(SimpleNamespace(
            candidate=str(bundle / 'candidate'), archive=str(bundle / 'foundation.zip'),
            output=str(output or self.output)))

    def assertRejected(self, pattern):
        with self.assertRaisesRegex(ValueError, pattern):
            self.reconstruct()
        self.assertFalse(self.output.exists())

    def edit_json(self, name, change):
        path = self.candidate / name
        data = json.loads(path.read_text())
        change(data)
        path.write_text(json.dumps(data))

    def rewrite_archive(self, members, modes=None):
        self.archive.unlink()
        with zipfile.ZipFile(self.archive, 'x') as archive:
            for name, (data, executable) in sorted(members.items()):
                info = zipfile.ZipInfo(name)
                info.create_system = 3
                info.external_attr = ((modes or {}).get(name, 0o100755 if executable else 0o100644)) << 16
                archive.writestr(info, data)

    def test_round_trip_matches_the_event_tree(self):
        self.reconstruct()
        self.assertEqual(tree_state(self.output), EVENT)
        changes = (self.candidate / 'changes.json').read_text()
        self.assertNotIn('OLD_PRIVATE_MARKER', changes)
        self.assertNotIn('CONTEXT_PRIVATE_MARKER', changes)
        self.assertIn('NEW_VISIBLE_MARKER', changes)
        work = (self.candidate / 'NEW-WORK.md').read_text()
        for name in ('dir/a.txt', 'icon.png', 'new.txt'):
            self.assertIn(f'`{name}`', work)
        self.assertNotIn('same.txt', work)

    def test_deleted_foundation_file_must_be_named_and_stays_deleted(self):
        (self.tree / 'same.txt').unlink()
        with self.assertRaisesRegex(ValueError, r'missing or oversized file: same\.txt'):
            self.prepare('unnamed', ['new.txt'])
        bundle = self.root / 'deleted'
        preparation.prepare(self.prepare_args('deleted', ['new.txt'], deleted_file=['same.txt']))
        self.assertIn('`same.txt`', (bundle / 'candidate/NEW-WORK.md').read_text())
        self.reconstruct(bundle)
        self.assertEqual(tree_state(self.output), {name: value for name, value in EVENT.items() if name != 'same.txt'})

    def test_candidate_holds_only_generated_files(self):
        self.assertEqual(set(tree_state(self.candidate)), {
            'NEW-WORK.md', 'changes.json', 'foundation-manifest.json', 'reconstruct.py', 'submission.json',
            'new/new.txt', *VIEWS})

    def test_source_views_show_each_changed_text_file(self):
        state = tree_state(self.candidate)
        self.assertEqual({name: state[name] for name in VIEWS}, {name: (data, False) for name, data in VIEWS.items()})
        meta = json.loads((self.candidate / 'submission.json').read_text())
        self.assertEqual(meta['views'], [entry(name, VIEWS[name]) for name in sorted(VIEWS)])
        self.assertNotIn('views', json.dumps(meta['files']))
        work = (self.candidate / 'NEW-WORK.md').read_text()
        self.assertIn('- `dir/a.txt`: [full file](changed/dir/a.txt), [diff](diffs/dir/a.txt.diff)\n', work)
        self.assertIn('- `.gitignore`: [diff](diffs/.gitignore.diff)\n', work)
        self.assertIn('## Changed binary files\n\nThese have no readable view', work)
        self.assertIn('- `icon.png`: binary, no view\n', work)
        self.assertIn('\n- `icon.png`\n', work)

    @unittest.skipUnless(shutil.which('git'), 'git is not installed')
    def test_diffs_apply_to_the_foundation_with_git(self):
        applied = self.root / 'applied'
        shutil.copytree(self.base, applied)
        diffs = sorted(str(path) for path in (self.candidate / 'diffs').rglob('*.diff'))
        self.assertEqual(len(diffs), 2)
        # The ceiling keeps git apply from adopting a repository that happens to enclose the temp directory.
        subprocess.run(['git', 'apply', *diffs], cwd=applied, check=True, capture_output=True, stdin=subprocess.DEVNULL,
                       timeout=30, env={**os.environ, 'GIT_CEILING_DIRECTORIES': str(self.root)})
        expected = {name: value for name, value in EVENT.items() if name in FOUNDATION and name != 'icon.png'}
        self.assertEqual({name: value for name, value in tree_state(applied).items() if name != 'icon.png'}, expected)

    @unittest.skipUnless(shutil.which('git'), 'git is not installed')
    def test_a_fresh_clone_of_the_candidate_reconstructs(self):
        # Judges get the candidate through Git, so no ignore rule may drop one of its files, such as a .env* view.
        env_example = (b'KEY=\nMODEL=\n', False)
        put(self.base, '.env.example', b'KEY=\n')
        put(self.tree, '.env.example', *env_example)
        # A full copy of this file under changed/ would be a live ignore file there, hiding changed/.env.example.
        put(self.tree, '.gitignore', b'data/\n.env*\n')
        self.write_manifest({**FOUNDATION, '.env.example': (b'KEY=\n', False)})
        bundle = self.prepare('clone-bundle', ['new.txt'])
        home = self.root / 'home'
        home.mkdir()
        # A private HOME and no global or system config, so the user's own ignore rules and hooks stay out of it.
        env = {**os.environ, 'HOME': str(home), 'XDG_CONFIG_HOME': str(home), 'GIT_CONFIG_NOSYSTEM': '1',
               'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CEILING_DIRECTORIES': str(self.root)}

        def git(*args):
            subprocess.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', *args],
                           cwd=self.root, env=env, check=True, capture_output=True, stdin=subprocess.DEVNULL,
                           timeout=60)
        candidate, clone = bundle / 'candidate', self.root / 'clone'
        git('-C', str(candidate), 'init', '-q')
        git('-C', str(candidate), 'add', '-A')
        git('-C', str(candidate), 'commit', '-q', '-m', 'candidate')
        git('clone', '-q', str(candidate), str(clone / 'candidate'))
        shutil.copyfile(bundle / 'foundation.zip', clone / 'foundation.zip')

        def tracked(root):
            return {name: value for name, value in tree_state(root).items() if not name.startswith('.git/')}
        self.assertEqual(tracked(clone / 'candidate'), tracked(candidate))
        self.reconstruct(clone)
        self.assertEqual(tree_state(self.output),
                         {**EVENT, '.gitignore': (b'data/\n.env*\n', False), '.env.example': env_example})

    def test_diff_splits_lines_like_git_and_marks_a_missing_final_newline(self):
        diff = submission.unified_diff('x.txt', b'page\x0cbreak\nold', False, b'page\x0cbreak\nnew', False)
        self.assertEqual(diff.decode(), (
            'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,2 @@\n page\x0cbreak\n'
            '-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n'))

    def test_reconstruct_builds_without_reading_views(self):
        shutil.rmtree(self.candidate / 'changed')
        shutil.rmtree(self.candidate / 'diffs')
        with mock.patch.object(submission, 'check_views'):
            self.reconstruct()
        self.assertEqual(tree_state(self.output), EVENT)

    def test_tampered_view_is_rejected(self):
        for name in VIEWS:
            with self.subTest(name=name):
                path = self.candidate / name
                path.write_bytes(flip_last_byte(VIEWS[name]))
                self.assertRejected(f'hash, size or mode mismatch: {name}$')
                path.write_bytes(VIEWS[name])
        self.reconstruct()

    def test_view_must_match_reconstruction_not_just_its_record(self):
        forged = b'FORGED event version\n'
        put(self.candidate, 'changed/dir/a.txt', forged)

        def relabel(meta):
            meta['views'] = [entry(item['path'], forged) if item['path'] == 'changed/dir/a.txt' else item
                             for item in meta['views']]
        self.edit_json('submission.json', relabel)
        self.assertRejected(r'hash, size or mode mismatch: changed/dir/a\.txt$')

    def test_view_inventory_must_list_exactly_the_views(self):
        put(self.candidate, 'changed/same.txt', FOUNDATION['same.txt'][0])
        for label, change in (
            ('missing', lambda meta: meta['views'].pop()),
            ('extra', lambda meta: meta['views'].append(entry('changed/same.txt', FOUNDATION['same.txt'][0]))),
            ('absent', lambda meta: meta.pop('views')),
        ):
            with self.subTest(label):
                original = (self.candidate / 'submission.json').read_bytes()
                self.edit_json('submission.json', change)
                self.assertRejected('source view inventory mismatch|invalid file inventory')
                (self.candidate / 'submission.json').write_bytes(original)

    def test_missing_view_file(self):
        (self.candidate / 'diffs/dir/a.txt.diff').unlink()
        self.assertRejected(r'missing or oversized file: diffs/dir/a\.txt\.diff$')

    def test_a_large_file_rewritten_whole_reconstructs(self):
        # Its diff holds both versions, so it is twice the file's size and over the limit for one submitted file.
        old, new = b'o' * 63 + b'\n', b'n' * 63 + b'\n'
        lines = 4 * 1024 * 1024 // len(old)
        put(self.base, 'big.txt', old * lines)
        put(self.tree, 'big.txt', new * lines)
        self.write_manifest({**FOUNDATION, 'big.txt': (old * lines, False)})
        bundle = self.prepare('big-bundle', ['new.txt'])
        self.assertGreater((bundle / 'candidate/diffs/big.txt.diff').stat().st_size, submission.MAX_FILE)
        self.reconstruct(bundle)
        self.assertEqual(tree_state(self.output)['big.txt'], (new * lines, False))

    def test_prepare_refuses_a_candidate_reconstruct_would_refuse(self):
        files, views = [data for data, _ in EVENT.values()], list(VIEWS.values())
        limits = {
            'too many files': ('FILE_LIMITS', (len(files) - 1, 2 ** 20, 2 ** 20)),
            'too many file bytes': ('FILE_LIMITS', (99, 2 ** 20, sum(map(len, files)) - 1)),
            'too many views': ('VIEW_LIMITS', (len(views) - 1, 2 ** 20, 2 ** 20)),
            'view too large': ('VIEW_LIMITS', (99, max(map(len, views)) - 1, 2 ** 20)),
            'too many view bytes': ('VIEW_LIMITS', (99, 2 ** 20, sum(map(len, views)) - 1)),
        }
        for label, (name, limit) in limits.items():
            with self.subTest(label):
                prepared = self.prepare(f'unlimited, {label}', ['new.txt'])
                with mock.patch.object(submission, name, limit):
                    with self.assertRaisesRegex(ValueError, 'invalid file inventory|over the [0-9]+ byte limit'):
                        self.reconstruct(prepared)
                    with self.assertRaisesRegex(ValueError, 'invalid file inventory|over the [0-9]+ byte limit'):
                        self.prepare(f'limited, {label}', ['new.txt'])
                self.assertFalse((self.root / f'limited, {label}').exists())

    def test_changes_json_has_one_operation_per_line(self):
        text = (self.candidate / 'changes.json').read_text(encoding='utf-8')
        lines = [line.strip().rstrip(',') for line in text.splitlines()]
        for operation in json.loads(text)['dir/a.txt']['operations']:
            self.assertIn(json.dumps(operation, ensure_ascii=False), lines)
        sample = {'b.bin': {'bytes': 'AA==', 'executable': True}, 'a.txt': {'executable': False, 'operations': []},
                  'c\u00e9.txt': {'executable': False, 'operations': [['copy', 1], ['add', 'x\n']]}}
        self.assertEqual(json.loads(preparation.changes_json(sample)), sample)
        self.assertEqual(preparation.changes_json({}), '{}\n')

    def test_mode_only_change(self):
        original = b'UNCHANGED_PRIVATE_MARKER\n'
        ops = preparation.patch(original, original)
        self.assertEqual(submission.apply_patch(original, ops), original)
        self.assertNotIn('UNCHANGED_PRIVATE_MARKER', json.dumps(ops))
        put(self.base, 'mode.txt', original, False)
        put(self.tree, 'mode.txt', original, True)
        self.write_manifest({'mode.txt': (original, False)})
        bundle = self.prepare('mode-bundle', [])
        self.reconstruct(bundle, self.root / 'mode-result')
        self.assertEqual(tree_state(self.root / 'mode-result'), {'mode.txt': (original, True)})
        self.assertEqual((bundle / 'candidate/changed/mode.txt').read_bytes(), original)
        self.assertEqual((bundle / 'candidate/diffs/mode.txt.diff').read_bytes(),
                         b'diff --git a/mode.txt b/mode.txt\nold mode 100644\nnew mode 100755\n')

    def test_existing_target(self):
        self.output.mkdir()
        with self.assertRaisesRegex(ValueError, 'output already exists'):
            self.reconstruct()
        self.assertEqual(list(self.output.iterdir()), [])

    def test_resized_archive_member(self):
        self.rewrite_archive({**FOUNDATION, 'same.txt': (b'bad\n', False)})
        self.assertRejected('archive size mismatch')

    def test_same_size_archive_tamper_fails_its_hash(self):
        # icon.png is replaced whole, so only the archive's own hash check can see this.
        data, executable = FOUNDATION['icon.png']
        self.rewrite_archive({**FOUNDATION, 'icon.png': (flip_last_byte(data), executable)})
        self.assertRejected(r'hash, size or mode mismatch: icon\.png$')

    def test_traversal_archive(self):
        members = {**FOUNDATION, '../evil': (b'bad', False)}
        del members['dir/a.txt']
        self.rewrite_archive(members)
        self.assertRejected('unsafe path')
        self.assertFalse((self.root / 'evil').exists())

    def test_symlink_archive(self):
        self.rewrite_archive(FOUNDATION, {'dir/a.txt': 0o120777})
        self.assertRejected('invalid archive member')

    def test_encrypted_archive_member(self):
        self.rewrite_archive(FOUNDATION)
        data = bytearray(self.archive.read_bytes())
        for signature, flags in ((b'PK\x03\x04', 6), (b'PK\x01\x02', 8)):
            data[data.find(signature) + flags] |= 1
        self.archive.write_bytes(bytes(data))
        self.assertRejected('invalid archive member')

    def test_tampered_manifest_fails_its_hash(self):
        path = self.candidate / 'foundation-manifest.json'
        path.write_bytes(path.read_bytes() + b'\n')
        self.assertRejected('foundation manifest hash mismatch')

    def test_tampered_change_fails_its_hash(self):
        def tamper(changes):
            operations = changes['dir/a.txt']['operations']
            index = next(i for i, (op, _) in enumerate(operations) if op == 'add')
            operations[index][1] = operations[index][1].replace('NEW', 'WEN')
        self.edit_json('changes.json', tamper)
        self.assertRejected(r'hash, size or mode mismatch: dir/a\.txt$')

    def test_tampered_new_file_fails_its_hash(self):
        data, executable = EVENT['new.txt']
        put(self.candidate / 'new', 'new.txt', flip_last_byte(data), executable)
        self.assertRejected(r'hash, size or mode mismatch: new\.txt$')

    def test_final_check_covers_unchanged_files(self):
        def retarget(meta):
            [item] = [item for item in meta['files'] if item['path'] == 'same.txt']
            item.update(entry('same.txt', b'different\n'))
        self.edit_json('submission.json', retarget)
        self.assertRejected(r'hash, size or mode mismatch: same\.txt$')

    def test_safe_path_refuses_escapes(self):
        for name in ('', '/etc/passwd', '../x', 'a/../b', 'a//b', './a', 'a/.', 'a\\b', 'a/'):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'unsafe path'):
                submission.safe_path(name)
        self.assertEqual(submission.safe_path('a/b.txt').parts, ('a', 'b.txt'))

    def test_traversal_new_file_writes_nothing_outside(self):
        name, data = '../escape.txt', b'escape\n'
        put(self.candidate, 'escape.txt', data)  # what new/../escape.txt names

        def add(meta):
            meta['newFiles'].append(name)
            meta['files'].append(entry(name, data))
        self.edit_json('submission.json', add)
        self.assertRejected('unsafe path')
        self.assertFalse((self.root / 'escape.txt').exists())

    def test_symlinked_new_file(self):
        data, executable = EVENT['new.txt']
        put(self.root, 'outside.txt', data, executable)
        link = self.candidate / 'new/new.txt'
        link.unlink()
        link.symlink_to(self.root / 'outside.txt')
        self.assertRejected(r'symlink forbidden: new\.txt$')

    def test_change_for_a_path_outside_the_foundation(self):
        self.edit_json('changes.json', lambda changes: changes.update({'new.txt': changes['dir/a.txt']}))
        self.assertRejected('invalid change paths')

    def test_target_inventory_must_list_every_new_file(self):
        self.edit_json('submission.json', lambda meta: meta['newFiles'].remove('new.txt'))
        self.assertRejected('invalid target inventory')

    def test_reject_change_with_both_forms(self):
        self.edit_json('changes.json', lambda changes: changes['dir/a.txt'].update({'bytes': ''}))
        self.assertRejected('invalid change entry')

    def test_binary_change_must_be_strict_base64(self):
        def corrupt(changes):
            encoded = changes['icon.png']['bytes']
            changes['icon.png']['bytes'] = encoded[:4] + '!' + encoded[4:]
        self.edit_json('changes.json', corrupt)
        with self.assertRaises(binascii.Error):
            self.reconstruct()
        self.assertFalse(self.output.exists())

    def test_patch_operations_are_checked(self):
        old = b'one\ntwo\n'
        self.assertEqual(submission.apply_patch(old, [['copy', 1], ['skip', 1], ['add', 'three\n']]), b'one\nthree\n')
        for operations, message in (
            ([['copy', 1]], 'incomplete patch'),
            ([['copy', 3]], 'invalid patch span'),
            ([['skip', -1], ['copy', 3]], 'invalid patch span'),
            ([['copy', True], ['copy', 1]], 'invalid patch span'),
            ([['add', 7], ['copy', 2]], 'invalid patch addition'),
            ([['move', 1], ['copy', 2]], 'invalid patch operation'),
        ):
            with self.subTest(operations=operations), self.assertRaisesRegex(ValueError, message):
                submission.apply_patch(old, operations)

    def test_wrong_foundation_manifest_hash(self):
        with self.assertRaisesRegex(ValueError, 'foundation manifest hash mismatch'):
            preparation.prepare(self.prepare_args('other', [], manifest_sha256='0' * 64))
        self.assertFalse((self.root / 'other').exists())

    def test_reject_private_new_files(self):
        names = ('.env.local', '.codex/config.toml', 'src/.mcp.json', '.memsearch/index', 'secrets/token',
                 'credentials/key', 'data/app.db', 'qa/run.log', 'node_modules/x/index.js', 'skills/x/SKILL.md',
                 'src/__pycache__/m.pyc', 'same.txt')
        for index, name in enumerate(names):
            with self.subTest(name=name):
                if name not in EVENT:
                    put(self.tree, name, b'private\n')  # the file exists, so only the guard can refuse it
                with self.assertRaisesRegex(ValueError, f'forbidden new file: {name}'):
                    preparation.prepare(self.prepare_args(f'forbidden-{index}', [name]))
                self.assertFalse((self.root / f'forbidden-{index}').exists())

    def test_env_example_is_the_one_allowed_dotfile(self):
        put(self.tree, 'cli/.env.example', b'KEY=\n')
        bundle = self.prepare('example-bundle', ['cli/.env.example'])
        self.assertEqual((bundle / 'candidate/new/cli/.env.example').read_bytes(), b'KEY=\n')

    def test_duplicate_new_file(self):
        with self.assertRaisesRegex(ValueError, 'duplicate new file'):
            preparation.prepare(self.prepare_args('duplicate', ['new.txt', 'new.txt']))

    def test_cli_writes_utf8_without_relying_on_the_locale(self):
        put(self.tree, 'dir/a.txt', 'NEW_VISIBLE_MARKER caf\u00e9 line\nCONTEXT_PRIVATE_MARKER\n'.encode(), False)
        args = self.prepare_args('cli-bundle', ['new.txt'])
        flags = [f'--{name.replace("_", "-")}={getattr(args, name)}'
                 for name in ('baseline', 'manifest', 'manifest_sha256', 'tree', 'output')]
        # An open() that leans on the locale raises here instead of quietly writing that locale's bytes.
        strict = ['-X', 'warn_default_encoding', '-W', 'error::EncodingWarning']
        subprocess.run([sys.executable, '-I', *strict, str(SCRIPT), 'prepare', *flags, '--new-file', 'new.txt'],
                       check=True, capture_output=True, timeout=60)
        self.assertIn('caf\u00e9 line'.encode(), (self.root / 'cli-bundle/candidate/changes.json').read_bytes())

    def test_failed_prepare_leaves_no_output(self):
        with self.assertRaisesRegex(ValueError, r'missing or oversized file: missing\.txt'):
            preparation.prepare(self.prepare_args('partial', ['missing.txt']))
        self.assertFalse((self.root / 'partial').exists())


if __name__ == '__main__':
    unittest.main()
