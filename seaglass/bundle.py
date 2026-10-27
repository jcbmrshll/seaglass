"""Bundles: a project's views, a directory of ES modules plus a layout.json, stored by
content hash (SPEC.md §6)."""

import hashlib
import json
import posixpath
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


# import/export ... from "x", import "x", import("x")
_IMPORT = re.compile(
    r"""(?:\bimport|\bexport)\s*(?:[\w*{}\s,$]+?\s*from\s*)?["']([^"']+)["']"""
    r"""|\bimport\s*\(\s*["']([^"']+)["']\s*\)"""
)


def problems(files: dict[str, bytes]) -> list[str]:
    """What breaks the module contract (SPEC.md §7.1, §8) in a bundle, as far as can
    be seen without running it: a layout.json that isn't one, fields that moved to the
    run, modules it names that aren't there, and imports that aren't relative paths
    inside the bundle."""
    out = []
    try:
        layout = json.loads(files["layout.json"])
    except (KeyError, ValueError) as e:
        return [f"layout.json is missing or isn't JSON ({e})"]
    if not isinstance(layout, dict) or not isinstance(layout.get("contract"), int):
        return ["layout.json needs an integer contract"]
    for field in ("summary", "descriptions"):
        if field in layout:
            out.append(
                f"layout.json's {field} is no longer read: say what metrics are, and "
                "which are the run's headline numbers, with monitor.describe()"
            )
    named = list((layout.get("renderers") or {}).values())
    for tab in layout.get("tabs") or []:
        panels = [tab.get("panel")] + [p for row in tab.get("rows") or [] for p in row]
        named += [p["module"] for p in panels if isinstance(p, dict) and "module" in p]
    for module in named:
        if module not in files:
            out.append(f"layout.json names {module}, which isn't in the bundle")
    for path, data in files.items():
        if not path.endswith((".js", ".mjs")):
            continue
        for m in _IMPORT.finditer(data.decode(errors="replace")):
            spec = m.group(1) or m.group(2)
            target = posixpath.normpath(posixpath.join(posixpath.dirname(path), spec))
            if not spec.startswith(("./", "../")):
                out.append(
                    f"{path} imports {spec!r}: modules import only ./ or ../ paths"
                )
            elif target.startswith("../") or target not in files:
                out.append(f"{path} imports {spec!r}, which isn't in the bundle")
    return out
