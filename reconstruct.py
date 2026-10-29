#!/usr/bin/env python3
"""Prepare and reconstruct a submission against an independently supplied foundation."""
import argparse
import difflib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
import zipfile

MAX_TOTAL = 64 * 1024 * 1024
MAX_FILE = 8 * 1024 * 1024
MAX_FILES = 5000


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(name):
    p = PurePosixPath(name)
    if not name or name.startswith('/') or '\\' in name or any(x in ('', '.', '..') for x in name.split('/')) or p.is_absolute():
        raise ValueError(f'unsafe path: {name!r}')
    return p


def read_regular(root, name):
    parts = safe_path(name).parts
    path = root
    for part in parts:
        path = path / part
        if path.is_symlink():
            raise ValueError(f'symlink forbidden: {name}')
    if not path.is_file() or path.stat().st_size > MAX_FILE:
        raise ValueError(f'missing or oversized file: {name}')
    data = path.read_bytes()
    return data, bool(path.stat().st_mode & 0o111)


def record(path, data, executable):
    return {'path': path, 'sha256': digest(data), 'bytes': len(data), 'executable': executable}


def entries(manifest):
    files = manifest['files']
    if not isinstance(files, list) or len(files) > MAX_FILES:
        raise ValueError('invalid file inventory')
    result = {}
    total = 0
    for item in files:
        name = item['path']
        safe_path(name)
        if name in result or not isinstance(item['bytes'], int) or not 0 <= item['bytes'] <= MAX_FILE or type(item['executable']) is not bool:
            raise ValueError('invalid inventory entry')
        if len(item['sha256']) != 64 or any(c not in '0123456789abcdef' for c in item['sha256']):
            raise ValueError('invalid hash')
        total += item['bytes']
        result[name] = item
    if total > MAX_TOTAL:
        raise ValueError('inventory too large')
    return result


def verify(data, executable, item):
    if record(item['path'], data, executable) != {k: item[k] for k in ('path', 'sha256', 'bytes', 'executable')}:
        raise ValueError(f"hash, size or mode mismatch: {item['path']}")


def write_file(root, name, data, executable):
    path = root.joinpath(*safe_path(name).parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as f:
        f.write(data)
    path.chmod(0o755 if executable else 0o644)


def patch(old, new):
    # Changed files must be UTF-8 text; old lines never enter the submission.
    old.decode('utf-8')
    new.decode('utf-8')
    a, b = old.splitlines(keepends=True), new.splitlines(keepends=True)
    ops = []
    for tag, i, j, k, l in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag == 'equal':
            ops.append(['copy', j - i])
        else:
            if j > i:
                ops.append(['skip', j - i])
            if l > k:
                ops.append(['add', b''.join(b[k:l]).decode('utf-8')])
    return ops


def apply_patch(old, ops):
    lines = old.splitlines(keepends=True)
    pos = 0
    output = bytearray()
    for op, value in ops:
        if op in ('copy', 'skip'):
            if type(value) is not int or value < 0 or pos + value > len(lines):
                raise ValueError('invalid patch span')
            if op == 'copy':
                output.extend(b''.join(lines[pos:pos + value]))
            pos += value
        elif op == 'add':
            if not isinstance(value, str):
                raise ValueError('invalid patch addition')
            output.extend(value.encode('utf-8'))
        else:
            raise ValueError('invalid patch operation')
        if len(output) > MAX_FILE:
            raise ValueError('patched file too large')
    if pos != len(lines):
        raise ValueError('incomplete patch')
    return bytes(output)


def zip_baseline(root, items, out):
    with zipfile.ZipFile(out, 'x', compression=zipfile.ZIP_DEFLATED) as z:
        for name, item in sorted(items.items()):
            data, executable = read_regular(root, name)
            verify(data, executable, item)
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = ((stat.S_IFREG | (0o755 if executable else 0o644)) << 16)
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)


def extract_baseline(archive, root, expected):
    with zipfile.ZipFile(archive) as z:
        infos = z.infolist()
        if len(infos) != len(expected) or len(infos) > MAX_FILES:
            raise ValueError('archive member count mismatch')
        seen = set()
        total = 0
        for info in infos:
            name = info.filename
            safe_path(name)
            mode = info.external_attr >> 16
            if name in seen or name not in expected or not stat.S_ISREG(mode) or info.is_dir() or info.flag_bits & 1:
                raise ValueError('invalid archive member')
            seen.add(name)
            total += info.file_size
            if info.file_size > MAX_FILE or total > MAX_TOTAL or info.file_size != expected[name]['bytes']:
                raise ValueError('archive size mismatch')
            data = z.read(info)
            executable = bool(mode & 0o111)
            verify(data, executable, expected[name])
            write_file(root, name, data, executable)
        if seen != set(expected):
            raise ValueError('archive inventory mismatch')


def prepare(args):
    baseline, tree, out = map(lambda x: Path(x).resolve(), (args.baseline, args.tree, args.output))
    manifest_bytes = Path(args.manifest).read_bytes()
    if digest(manifest_bytes) != args.manifest_sha256:
        raise ValueError('foundation manifest hash mismatch')
    manifest = json.loads(manifest_bytes)
    original = entries(manifest)
    new_names = sorted(set(args.new_file))
    if len(new_names) != len(args.new_file):
        raise ValueError('duplicate new file')
    for name in new_names:
        safe_path(name)
        parts = safe_path(name).parts
        if name in original or any(part.startswith('.') and part != '.env.example' for part in parts) or any(part in ('qa', 'data', 'node_modules', 'skills', 'secrets', 'credentials', '__pycache__') for part in parts):
            raise ValueError(f'forbidden new file: {name}')
    if out.exists():
        raise ValueError('output already exists')
    out.mkdir(parents=True)
    try:
        candidate = out / 'candidate'
        candidate.mkdir()
        (candidate / '.gitignore').write_text('foundation.zip\n.env*\nbuild/\ndata/\nnode_modules/\n')
        zip_baseline(baseline, original, out / 'foundation.zip')
        changes = {}
        target = []
        for name, item in sorted(original.items()):
            before, old_mode = read_regular(baseline, name)
            after, mode = read_regular(tree, name)
            target.append(record(name, after, mode))
            if before != after or old_mode != mode:
                changes[name] = {'operations': patch(before, after), 'executable': mode}
        for name in new_names:
            data, mode = read_regular(tree, name)
            write_file(candidate / 'new', name, data, mode)
            target.append(record(name, data, mode))
        shutil.copyfile(Path(__file__), candidate / 'reconstruct.py')
        (candidate / 'foundation-manifest.json').write_bytes(manifest_bytes)
        (candidate / 'changes.json').write_text(json.dumps(changes, sort_keys=True, indent=2, ensure_ascii=False) + '\n')
        (candidate / 'submission.json').write_text(json.dumps({'foundationManifestSha256': digest(manifest_bytes), 'newFiles': new_names, 'files': sorted(target, key=lambda x: x['path'])}, sort_keys=True, indent=2) + '\n')
        work = '# New work for review\n\nChanges relative to the separately supplied mixed-origin foundation are listed below. This inventory records byte differences; it does not establish authorship or eligibility.\n\n## Changed files\n\n'
        work += ''.join(f'- `{name}`\n' for name in sorted(changes)) or '- None\n'
        work += '\n## New files\n\n'
        work += ''.join(f'- `{name}`\n' for name in new_names) or '- None\n'
        work += '\nRead `changes.json` for the added text and copy/skip operations. Deleted foundation lines and unchanged context are not included.\n'
        (candidate / 'NEW-WORK.md').write_text(work)
        (candidate / 'README.md').write_text('''# Submission reconstruction\n\nThe separately supplied foundation is a mixed-origin integration frozen October 28, 2026. It contains earlier source and event-era adaptations and is excluded from the new-work claim. It is not a pre-event revision. Only the changes and new files in this submission are candidates for event work; their provenance still requires review.\n\nObtain the foundation archive independently from its owner. Judge access is not verified. No public license grant for foundation source is implied. Reconstruct into a new directory with Python 3:\n\n```sh\npython3 reconstruct.py reconstruct --candidate . --archive /path/to/foundation.zip --output /path/to/new-build\n```\n\nInitialize Git inside the reconstructed build directory with `git init` before installing dependencies, so the normal preparation hook can be installed. Then follow the reconstructed application README for setup. Real processing requires separately configured services and can incur charges; the synthetic reader does not process uploads.\n''')
    except Exception:
        shutil.rmtree(out)
        raise


def reconstruct(args):
    candidate, output = Path(args.candidate).resolve(), Path(args.output).absolute()
    if output.exists() or output.is_symlink():
        raise ValueError('output already exists')
    meta = json.loads((candidate / 'submission.json').read_bytes())
    manifest_bytes = (candidate / 'foundation-manifest.json').read_bytes()
    if digest(manifest_bytes) != meta['foundationManifestSha256']:
        raise ValueError('foundation manifest hash mismatch')
    original = entries(json.loads(manifest_bytes))
    target = entries(meta)
    names = meta['newFiles']
    if not isinstance(names, list) or len(set(names)) != len(names) or set(names) & set(original) or set(target) != set(original) | set(names):
        raise ValueError('invalid target inventory')
    changes = json.loads((candidate / 'changes.json').read_bytes())
    if not set(changes) <= set(original):
        raise ValueError('invalid change paths')
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix='.submission-', dir=output.parent))
    try:
        extract_baseline(args.archive, temp, original)
        for name, change in changes.items():
            old, _ = read_regular(temp, name)
            result = apply_patch(old, change['operations'])
            verify(result, change['executable'], target[name])
            path = temp.joinpath(*safe_path(name).parts)
            path.unlink()
            write_file(temp, name, result, change['executable'])
        for name in names:
            data, mode = read_regular(candidate / 'new', name)
            verify(data, mode, target[name])
            write_file(temp, name, data, mode)
        for name, item in target.items():
            data, mode = read_regular(temp, name)
            verify(data, mode, item)
        output.mkdir()  # Exclusive creation prevents replacing an existing target.
        try:
            for child in temp.iterdir():
                os.rename(child, output / child.name)
        except Exception:
            shutil.rmtree(output)
            raise
    finally:
        if temp.exists():
            shutil.rmtree(temp)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('prepare')
    for name in ('baseline', 'manifest', 'manifest-sha256', 'tree', 'output'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--new-file', action='append', default=[])
    r = sub.add_parser('reconstruct')
    for name in ('candidate', 'archive', 'output'):
        r.add_argument('--' + name, required=True)
    args = parser.parse_args()
    (prepare if args.command == 'prepare' else reconstruct)(args)


if __name__ == '__main__':
    main()
