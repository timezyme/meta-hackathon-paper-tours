#!/usr/bin/env python3
"""Reconstruct and verify a submission using its supplied foundation archive."""
import argparse
import base64
from dataclasses import dataclass
import difflib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import tempfile
from typing import Any
import zipfile

MAX_TOTAL = 64 * 1024 * 1024
MAX_FILE = 8 * 1024 * 1024
MAX_FILES = 5000
# Inventory limits: files, bytes in one file, bytes in all. A diff holds both versions of a file and a marker on
# every line, so the readable views get room for that growth.
FILE_LIMITS = (MAX_FILES, MAX_FILE, MAX_TOTAL)
VIEW_LIMITS = (2 * MAX_FILES, 4 * MAX_FILE, 4 * MAX_TOTAL)
# A full copy of one of these would change how Git treats the changed/ folder itself, so it gets only a diff.
GIT_CONTROL_FILES = frozenset({'.gitignore', '.gitattributes'})
# The change entry for a foundation file that the event version no longer has.
DELETED = {'deleted': True}

@dataclass(frozen=True)
class FileRecord:
    path: str
    sha256: str
    bytes: int
    executable: bool


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_path(name: str) -> PurePosixPath:
    parts = name.split('/')
    if not name or name.startswith('/') or '\\' in name or any(part in ('', '.', '..') for part in parts):
        raise ValueError(f'unsafe path: {name!r}')
    return PurePosixPath(name)


def read_regular(root: Path, name: str, max_size: int = MAX_FILE) -> tuple[bytes, bool]:
    parts = safe_path(name).parts
    path = root
    for part in parts:
        path = path / part
        if path.is_symlink():
            raise ValueError(f'symlink forbidden: {name}')
    if not path.is_file() or path.stat().st_size > max_size:
        raise ValueError(f'missing or oversized file: {name}')
    data = path.read_bytes()
    return data, bool(path.stat().st_mode & 0o111)


def record(path: str, data: bytes, executable: bool) -> dict[str, Any]:
    return {'path': path, 'sha256': digest(data), 'bytes': len(data), 'executable': executable}


def entries(files: Any, limits: tuple[int, int, int]) -> dict[str, FileRecord]:
    max_files, max_file, max_total = limits
    if not isinstance(files, list) or len(files) > max_files:
        raise ValueError('invalid file inventory')
    result = {}
    total = 0
    for item in files:
        name = item['path']
        safe_path(name)
        size, executable = item['bytes'], item['executable']
        if name in result or not isinstance(size, int) or size < 0 or type(executable) is not bool:
            raise ValueError('invalid inventory entry')
        if size > max_file:
            raise ValueError(f'file over the {max_file} byte limit: {name}')
        if len(item['sha256']) != 64 or any(c not in '0123456789abcdef' for c in item['sha256']):
            raise ValueError('invalid hash')
        total += item['bytes']
        result[name] = FileRecord(name, item['sha256'], size, executable)
    if total > max_total:
        raise ValueError(f'inventory over the {max_total} byte limit')
    return result


def verify(data: bytes, executable: bool, item: FileRecord) -> None:
    if (digest(data), len(data), executable) != (item.sha256, item.bytes, item.executable):
        raise ValueError(f"hash, size or mode mismatch: {item.path}")


def write_file(root: Path, name: str, data: bytes, executable: bool) -> None:
    path = root.joinpath(*safe_path(name).parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as f:
        f.write(data)
    path.chmod(0o755 if executable else 0o644)


def is_text(data: bytes) -> bool:
    try:
        data.decode('utf-8')
        return True
    except UnicodeDecodeError:
        return False


def changed_bytes(old: bytes, item: dict[str, Any]) -> bytes:
    if set(item) == {'operations', 'executable'}:
        return apply_patch(old, item['operations'])
    if set(item) == {'bytes', 'executable'} and isinstance(item['bytes'], str):
        return base64.b64decode(item['bytes'], validate=True)
    raise ValueError('invalid change entry')


def apply_patch(old: bytes, ops: list[list[str | int]]) -> bytes:
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


def text_lines(data: bytes) -> list[str]:
    # Split on newlines only, as Git does; str.splitlines also splits on form feeds and Unicode separators.
    lines = data.decode('utf-8').split('\n')
    return [line + '\n' for line in lines[:-1]] + ([lines[-1]] if lines[-1] else [])


def git_mode(executable: bool) -> str:
    return '100755' if executable else '100644'


def unified_diff(name: str, old: bytes, old_executable: bool, new: bytes, executable: bool) -> bytes:
    out = [f'diff --git a/{name} b/{name}\n']
    if old_executable != executable:
        out += [f'old mode {git_mode(old_executable)}\n', f'new mode {git_mode(executable)}\n']
    for line in difflib.unified_diff(text_lines(old), text_lines(new), f'a/{name}', f'b/{name}'):
        out.append(line if line.endswith('\n') else line + '\n\\ No newline at end of file\n')
    return ''.join(out).encode('utf-8')


def source_views(name: str, old: bytes, old_executable: bool, new: bytes, executable: bool) -> dict[str, bytes]:
    # Readable copies of a changed text file. Reconstruction never builds from them; it only checks them.
    if not (is_text(old) and is_text(new)):
        return {}
    views = {f'diffs/{name}.diff': unified_diff(name, old, old_executable, new, executable)}
    if PurePosixPath(name).name not in GIT_CONTROL_FILES:
        views[f'changed/{name}'] = new
    return views


def check_views(candidate: Path, inventory: dict[str, FileRecord], expected: dict[str, bytes]) -> None:
    if set(inventory) != set(expected):
        raise ValueError('source view inventory mismatch')
    for name, data in sorted(expected.items()):
        verify(data, False, inventory[name])
        actual, executable = read_regular(candidate, name, VIEW_LIMITS[1])
        verify(actual, executable, inventory[name])


def extract_baseline(archive: Path, root: Path, expected: dict[str, FileRecord]) -> None:
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
            if info.file_size > MAX_FILE or total > MAX_TOTAL or info.file_size != expected[name].bytes:
                raise ValueError('archive size mismatch')
            data = z.read(info)
            executable = bool(mode & 0o111)
            verify(data, executable, expected[name])
            write_file(root, name, data, executable)
        if seen != set(expected):
            raise ValueError('archive inventory mismatch')


def reconstruct(args: argparse.Namespace) -> None:
    candidate, output = Path(args.candidate).resolve(), Path(args.output).absolute()
    if output.exists() or output.is_symlink():
        raise ValueError('output already exists')
    meta = json.loads((candidate / 'submission.json').read_bytes())
    manifest_bytes = (candidate / 'foundation-manifest.json').read_bytes()
    if digest(manifest_bytes) != meta['foundationManifestSha256']:
        raise ValueError('foundation manifest hash mismatch')
    original = entries(json.loads(manifest_bytes)['files'], FILE_LIMITS)
    target = entries(meta['files'], FILE_LIMITS)
    view_inventory = entries(meta.get('views'), VIEW_LIMITS)
    changes = json.loads((candidate / 'changes.json').read_bytes())
    if not set(changes) <= set(original):
        raise ValueError('invalid change paths')
    deleted = {name for name, item in changes.items() if item == DELETED}
    names = meta['newFiles']
    if (not isinstance(names, list) or len(set(names)) != len(names) or set(names) & set(original)
            or set(target) != (set(original) - deleted) | set(names)):
        raise ValueError('invalid target inventory')
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix='.submission-', dir=output.parent))
    try:
        extract_baseline(args.archive, temp, original)
        views = {}
        for name, item in changes.items():
            old, old_executable = read_regular(temp, name)
            if name in deleted:
                path = temp.joinpath(*safe_path(name).parts)
                path.unlink()
                for parent in path.parents:
                    if parent == temp or any(parent.iterdir()):
                        break
                    parent.rmdir()
                continue
            result = changed_bytes(old, item)
            verify(result, item['executable'], target[name])
            views.update(source_views(name, old, old_executable, result, item['executable']))
            path = temp.joinpath(*safe_path(name).parts)
            path.unlink()
            write_file(temp, name, result, item['executable'])
        for name in names:
            data, mode = read_regular(candidate / 'new', name)
            verify(data, mode, target[name])
            write_file(temp, name, data, mode)
        for name, item in target.items():
            data, mode = read_regular(temp, name)
            verify(data, mode, item)
        check_views(candidate, view_inventory, views)
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


def add_reconstruct_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument('--candidate', type=Path, required=True, help='Candidate directory to verify and reconstruct')
    parser.add_argument('--archive', type=Path, required=True, help='Foundation ZIP archive')
    parser.add_argument('--output', type=Path, required=True, help='New directory for the reconstructed tree')
    parser.set_defaults(func=reconstruct)


def main() -> None:
    parser = argparse.ArgumentParser(description='Reconstruct and verify a submission from its foundation archive.')
    sub = parser.add_subparsers(dest='command', required=True)
    r = sub.add_parser('reconstruct', help='Verify the candidate and rebuild its tree')
    add_reconstruct_arguments(r)
    args = parser.parse_args()
    try:
        args.func(args)
    except (ValueError, OSError, KeyError, TypeError) as error:
        sys.exit(f'reconstruct: {error}')


if __name__ == '__main__':
    main()
