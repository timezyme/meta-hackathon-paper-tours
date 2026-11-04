#!/usr/bin/env python3
"""Prepare a submission against an independently supplied foundation."""
import argparse
import base64
from collections.abc import Iterable
import difflib
import json
from pathlib import Path
import shutil
import stat
import sys
from typing import Any
from urllib.parse import quote
import zipfile

# Isolated Python mode omits the script directory from the import path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import reconstruct as reconstruction
from reconstruct import (
    DELETED, FileRecord, add_reconstruct_arguments, digest, entries, is_text, read_regular,
    reconstruct, record, safe_path, source_views, verify, write_file,
)

# New files may not live in, or be, any of these: private, generated or dependency data.
FORBIDDEN_PARTS = frozenset({'qa', 'data', 'node_modules', 'skills', 'secrets', 'credentials', '__pycache__'})
ALLOWED_DOTFILES = frozenset({'.env.example'})


def change(old: bytes, new: bytes, executable: bool) -> dict[str, Any]:
    # Text files become line operations; any other changed file is stored whole as base64.
    if is_text(old) and is_text(new):
        return {'operations': patch(old, new), 'executable': executable}
    return {'bytes': base64.b64encode(new).decode('ascii'), 'executable': executable}


def patch(old: bytes, new: bytes) -> list[list[str | int]]:
    """Describe new as copy and skip runs over old's lines plus added text; old's lines never appear."""
    a, b = old.splitlines(keepends=True), new.splitlines(keepends=True)
    operations = []
    for tag, a_start, a_end, b_start, b_end in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag == 'equal':
            operations.append(['copy', a_end - a_start])
            continue
        if a_end > a_start:
            operations.append(['skip', a_end - a_start])
        if b_end > b_start:
            operations.append(['add', b''.join(b[b_start:b_end]).decode('utf-8')])
    return operations


def changes_json(changes: dict[str, dict[str, Any]]) -> str:
    """Write one operation per line, so changes.json reads as a list of edits. Any JSON reader accepts it."""
    def dump(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False)

    entries = []
    for name, item in sorted(changes.items()):
        if item == DELETED:
            body = '"deleted": true'
        elif 'operations' in item:
            operations = ','.join(f'\n      {dump(operation)}' for operation in item['operations'])
            body = f'"executable": {dump(item["executable"])},\n    "operations": [{operations}\n    ]'
        else:
            body = f'"bytes": {dump(item["bytes"])},\n    "executable": {dump(item["executable"])}'
        entries.append(f'  {dump(name)}: {{\n    {body}\n  }}')
    return '{\n' + ',\n'.join(entries) + '\n}\n' if entries else '{}\n'


def bullets(lines: Iterable[str]) -> str:
    return ''.join(f'- {line}\n' for line in lines) or '- None\n'


def new_work(changes: dict[str, dict[str, Any]], new_names: list[str], views: dict[str, bytes]) -> str:
    changed, binary, deleted = [], [], []
    for name in sorted(changes):
        if changes[name] == DELETED:
            deleted.append(f'`{name}`')
            continue
        links = [f'[{label}]({quote(view)})' for label, view in (('full file', f'changed/{name}'),
                                                                 ('diff', f'diffs/{name}.diff')) if view in views]
        changed.append(f'`{name}`: {", ".join(links) or "binary, no view"}')
        binary += [] if links else [f'`{name}`']
    work = ('# New work for review\n\nChanges relative to the separately supplied mixed-origin foundation are listed '
            'below. This inventory records byte differences; it does not establish authorship or eligibility.\n\n'
            '## Changed files\n\nEach changed text file has its full event version under `changed/` and a unified '
            'diff against the foundation under `diffs/`. Both are for reading: `reconstruct.py` builds only from '
            '`changes.json` and `new/`, then checks that every view matches what it built. A changed `.gitignore` '
            'or `.gitattributes` has only a diff, because Git would apply a full copy to `changed/` itself.\n\n')
    work += bullets(changed)
    if binary:
        work += ('\n## Changed binary files\n\nThese have no readable view; `changes.json` carries each one whole '
                 'as base64.\n\n' + bullets(binary))
    if deleted:
        work += ('\n## Deleted foundation files\n\nThe event version no longer has these files; `changes.json` '
                 'marks each one `"deleted": true`.\n\n' + bullets(deleted))
    work += '\n## New files\n\n' + bullets(f'[`{name}`]({quote("new/" + name)})' for name in new_names)
    work += ('\n`changes.json` is what reconstruction applies: the added text and copy/skip operations on foundation '
             'lines, and changed binary files whole as base64. Unlike the diffs, it holds no deleted foundation lines '
             'or unchanged context.\n')
    return work


def is_forbidden(name: str) -> bool:
    parts = safe_path(name).parts
    return any((part.startswith('.') and part not in ALLOWED_DOTFILES) or part in FORBIDDEN_PARTS for part in parts)


def zip_baseline(root: Path, items: dict[str, FileRecord], out: Path) -> None:
    with zipfile.ZipFile(out, 'x', compression=zipfile.ZIP_DEFLATED) as z:
        for name, item in sorted(items.items()):
            data, executable = read_regular(root, name)
            verify(data, executable, item)
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = ((stat.S_IFREG | (0o755 if executable else 0o644)) << 16)
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)


def prepare(args: argparse.Namespace) -> None:
    baseline, tree, out = Path(args.baseline).resolve(), Path(args.tree).resolve(), Path(args.output).resolve()
    manifest_bytes = Path(args.manifest).read_bytes()
    if digest(manifest_bytes) != args.manifest_sha256:
        raise ValueError('foundation manifest hash mismatch')
    manifest = json.loads(manifest_bytes)
    original = entries(manifest['files'], reconstruction.FILE_LIMITS)
    new_names = sorted(set(args.new_file))
    if len(new_names) != len(args.new_file):
        raise ValueError('duplicate new file')
    for name in new_names:
        if name in original or is_forbidden(name):
            raise ValueError(f'forbidden new file: {name}')
    deleted_names = set(args.deleted_file)
    if len(deleted_names) != len(args.deleted_file):
        raise ValueError('duplicate deleted file')
    if not deleted_names <= set(original):
        raise ValueError('deleted file is not a foundation file')
    if out.exists():
        raise ValueError('output already exists')
    out.mkdir(parents=True)
    try:
        candidate = out / 'candidate'
        candidate.mkdir()
        zip_baseline(baseline, original, out / 'foundation.zip')
        changes = {}
        views = {}
        target = []
        for name in sorted(original):
            before, old_mode = read_regular(baseline, name)
            if name in deleted_names:
                path = tree.joinpath(*safe_path(name).parts)
                if path.exists() or path.is_symlink():
                    raise ValueError(f'deleted file still exists: {name}')
                changes[name] = dict(DELETED)
                continue
            after, mode = read_regular(tree, name)
            target.append(record(name, after, mode))
            if before != after or old_mode != mode:
                changes[name] = change(before, after, mode)
                views.update(source_views(name, before, old_mode, after, mode))
        for name in new_names:
            data, mode = read_regular(tree, name)
            write_file(candidate / 'new', name, data, mode)
            target.append(record(name, data, mode))
        view_records = [record(name, data, False) for name, data in sorted(views.items())]
        # The limits reconstruct.py applies, so prepare never writes a candidate that it would refuse.
        entries(target, reconstruction.FILE_LIMITS)
        entries(view_records, reconstruction.VIEW_LIMITS)
        for name, data in sorted(views.items()):
            write_file(candidate, name, data, False)
        shutil.copyfile(Path(__file__).with_name('reconstruct.py'), candidate / 'reconstruct.py')
        (candidate / 'foundation-manifest.json').write_bytes(manifest_bytes)
        (candidate / 'changes.json').write_text(changes_json(changes), encoding='utf-8')
        meta = {'foundationManifestSha256': digest(manifest_bytes), 'newFiles': new_names,
                'files': sorted(target, key=lambda x: x['path']),
                'views': view_records}
        (candidate / 'submission.json').write_text(json.dumps(meta, sort_keys=True, indent=2) + '\n', encoding='utf-8')
        (candidate / 'NEW-WORK.md').write_text(new_work(changes, new_names, views), encoding='utf-8')
    except Exception:
        shutil.rmtree(out)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description='Prepare or reconstruct a submission against its foundation.')
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('prepare', help='Build a candidate and foundation archive')
    p.add_argument('--baseline', type=Path, required=True, help='Immutable foundation tree')
    p.add_argument('--manifest', type=Path, required=True, help='Foundation manifest JSON file')
    p.add_argument('--manifest-sha256', required=True, help='Expected SHA-256 of the foundation manifest')
    p.add_argument('--tree', type=Path, required=True, help='Current application tree')
    p.add_argument('--output', type=Path, required=True, help='New directory for the archive and candidate')
    p.add_argument('--new-file', action='append', default=[], help='New relative file path to include; repeat as needed')
    p.add_argument('--deleted-file', action='append', default=[],
                   help='Foundation file path the application removed; repeat as needed')
    p.set_defaults(func=prepare)
    r = sub.add_parser('reconstruct', help='Verify the candidate and rebuild its tree')
    add_reconstruct_arguments(r)
    args = parser.parse_args()
    try:
        args.func(args)
    except (ValueError, OSError, KeyError, TypeError) as error:
        sys.exit(f'prepare: {error}')


if __name__ == '__main__':
    main()
