"""Bundles: a project's views, a directory of ES modules plus a layout.json, stored by
content hash (SPEC.md §6)."""

import hashlib
import re
from pathlib import Path

HASH = re.compile(r"[0-9a-f]{64}")
_SEGMENT = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9_.-]*")


def valid_path(path: str) -> bool:
    """Whether `path` is a valid file path in a run or bundle: '/'-separated segments,
    none starting with '.', at most 255 characters."""
    if not 0 < len(path) <= 255:
        return False
    return all(_SEGMENT.fullmatch(s) for s in path.split("/"))


def bundle_hash(files: dict[str, bytes]) -> str:
    """The bundle's hash: SHA-256 over its files sorted by path, each as its path, a
    zero byte, its size in decimal, a zero byte and its bytes."""
    h = hashlib.sha256()
    for path in sorted(files, key=lambda p: p.encode()):
        data = files[path]
        h.update(path.encode() + b"\0" + str(len(data)).encode() + b"\0")
        h.update(data)
    return h.hexdigest()


def read_bundle(directory: str | Path) -> dict[str, bytes]:
    """The files of the bundle in `directory`: every regular file under it, except
    those with a path segment starting with '.'."""
    root = Path(directory)
    if not (root / "layout.json").is_file():
        raise FileNotFoundError(f"{root} has no layout.json, so it isn't a bundle")
    files = {}
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root).as_posix()
        if not path.is_file() or any(s.startswith(".") for s in rel.split("/")):
            continue
        if not valid_path(rel):
            raise ValueError(f"{rel!r} isn't a valid bundle path (SPEC.md §2)")
        files[rel] = path.read_bytes()
    return files
