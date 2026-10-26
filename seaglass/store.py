"""Runs on disk, in the layout of SPEC.md §10:

    <root>/<run id>/meta.json             the run's meta, replaced whole on each change
    <root>/<run id>/metrics.jsonl         one metrics row per line
    <root>/<run id>/media.jsonl           one media entry per line
    <root>/<run id>/files/<path>          the run's files
    <root>/<run id>/streams/<name>.jsonl  one stream row per line
    <root>/bundles/<hash>/<path>          each bundle's files

The store checks everything it's given against the spec and raises `Invalid`,
`NotFound`, `Conflict` or `TooLarge`, which the server turns into 400, 404, 409 and
413. One lock guards every write; reads go straight to the files.
"""

import hashlib
import json
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
from collections.abc import Iterable
from pathlib import Path
from typing import Any, Protocol

from seaglass.bundle import HASH, bundle_hash, valid_path

RUN_ID = re.compile(r"\d{8}-\d{6}-[0-9a-f]{4}")
PROJECT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}")
STREAM = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}")
TYPE = re.compile(r"[a-z0-9][a-z0-9_.-]*(/[a-z0-9][a-z0-9_.-]*)+")
STATUS = re.compile(r"[a-z][a-z0-9_-]{0,31}")
MAX_ACTIVITY = 500
MAX_ATTRS = 64 * 1024
MAX_TAGS = 32

# runs get a memorable name unless the client gives one
ADJECTIVES = [
    "amber",
    "brisk",
    "calm",
    "deft",
    "eager",
    "fallow",
    "gilded",
    "hardy",
    "idle",
    "jolly",
    "keen",
    "lucid",
    "mellow",
    "nimble",
    "olive",
    "patient",
    "quiet",
    "rustic",
    "sly",
    "tawny",
    "umber",
    "vivid",
    "wary",
    "young",
    "zesty",
]
NOUNS = [
    "badger",
    "crane",
    "dune",
    "ember",
    "finch",
    "grove",
    "heron",
    "ibis",
    "juniper",
    "kestrel",
    "lark",
    "maple",
    "newt",
    "otter",
    "pine",
    "quail",
    "reed",
    "sparrow",
    "thistle",
    "vole",
    "wren",
    "yarrow",
]


class Readable(Protocol):
    def read(self, n: int, /) -> bytes: ...


class Invalid(ValueError):
    """A request that breaks the spec (400)."""


class NotFound(KeyError):
    """No such run, file or bundle (404)."""

    def __str__(self) -> str:
        return str(self.args[0]) if self.args else "not found"


class Conflict(Exception):
    """A file that exists with other bytes (409)."""


class TooLarge(Exception):
    """A body over the server's limit (413)."""


def _check(ok: bool, message: str) -> None:
    if not ok:
        raise Invalid(message)


def _is_int(x: Any) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def _is_number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _given(body: dict[str, Any], key: str, default: Any) -> Any:
    """body[key], or the default if it's missing or null."""
    value = body.get(key)
    return default if value is None else value


def _check_rows(rows: Any, what: str) -> list[dict[str, Any]]:
    _check(isinstance(rows, list), f"{what} are sent as a JSON array")
    for row in rows:
        _check(isinstance(row, dict), f"each of the {what} is a JSON object")
        _check(_is_int(row.get("step")), f"each of the {what} has an integer step")
    return rows


def check_tags(tags: Any) -> list[str]:
    _check(isinstance(tags, list), "tags are a list of strings")
    _check(len(tags) <= MAX_TAGS, f"at most {MAX_TAGS} tags")
    for tag in tags:
        _check(
            isinstance(tag, str)
            and 0 < len(tag) <= 64
            and "," not in tag
            and tag == tag.strip(),
            f"{tag!r} isn't a tag: 1-64 characters, no commas or surrounding spaces",
        )
    return tags


class RunStore:
    def __init__(self, root: str | Path, max_file: int = 1 << 30):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.bundles = self.root / "bundles"
        self.max_file = max_file
        self.lock = threading.Lock()

    # ------------------------------------------------------------ helpers

    def _dir(self, run_id: str) -> Path:
        path = self.root / run_id
        if not RUN_ID.fullmatch(run_id) or not (path / "meta.json").is_file():
            raise NotFound(f"no run {run_id}")
        return path

    def _read_meta(self, run_dir: Path) -> dict[str, Any]:
        return json.loads((run_dir / "meta.json").read_text())

    def _write_meta(self, run_dir: Path, meta: dict[str, Any]) -> None:
        tmp = run_dir / "meta.json.tmp"
        tmp.write_text(json.dumps(meta))
        tmp.replace(run_dir / "meta.json")

    def _append(self, path: Path, rows: Iterable[dict[str, Any]]) -> None:
        path.parent.mkdir(exist_ok=True)
        with open(path, "a") as f:
            f.write("".join(json.dumps(row) + "\n" for row in rows))

    def _touch(
        self, run_dir: Path, now: float, steps: Iterable[int] = ()
    ) -> dict[str, Any]:
        """The run's meta after hearing from it: updated, running, and at the highest
        step it logged. Holding the lock; the caller writes it."""
        meta = self._read_meta(run_dir)
        meta["updated"] = now
        meta["status"] = "running"
        for step in steps:
            meta["step"] = step if meta["step"] is None else max(meta["step"], step)
        return meta

    # ------------------------------------------------------------ ingest

    def create(self, body: Any) -> dict[str, Any]:
        _check(isinstance(body, dict), "a run is created from a JSON object")
        project = _given(body, "project", "default")
        _check(
            isinstance(project, str) and bool(PROJECT.fullmatch(project)),
            f"{project!r} isn't a project name",
        )
        name = body.get("name")
        _check(
            name is None or (isinstance(name, str) and 0 < len(name) <= 200),
            "a run's name is a string of 1-200 characters",
        )
        config = _given(body, "config", {})
        _check(isinstance(config, dict), "config is a JSON object")
        provenance = _given(body, "provenance", {})
        _check(isinstance(provenance, dict), "provenance is a JSON object")
        tags = check_tags(_given(body, "tags", []))
        bundle = body.get("bundle")
        _check(
            bundle is None
            or (isinstance(bundle, str) and bool(HASH.fullmatch(bundle))),
            "bundle is a hash: 64 lowercase hex digits",
        )
        total = body.get("total")
        _check(total is None or _is_int(total), "total is an integer")

        with self.lock:
            now = time.time()
            stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(now))
            while (self.root / (run_id := f"{stamp}-{secrets.token_hex(2)}")).exists():
                pass
            if name is None:
                num = sum(1 for m in self.list() if m["project"] == project) + 1
                name = f"{secrets.choice(ADJECTIVES)}-{secrets.choice(NOUNS)}-{num}"
            meta = {
                "id": run_id,
                "project": project,
                "name": name,
                "created": now,
                "updated": now,
                "status": "running",
                "step": None,
                "total": total,
                "latest": {},
                "activity": None,
                "activity_since": None,
                "tags": tags,
                "provenance": provenance,
                "bundle": bundle,
                "config": config,
            }
            run_dir = self.root / run_id
            run_dir.mkdir()
            self._write_meta(run_dir, meta)
        return meta

    def log_metrics(self, run_id: str, rows: Any) -> None:
        run_dir = self._dir(run_id)
        for row in _check_rows(rows, "metrics rows"):
            for k, v in row.items():
                if k == "step":
                    continue
                _check(k != "time", "a metric can't be called time")
                _check(0 < len(k) <= 200, "metric names are 1-200 characters")
                _check(
                    v is None or _is_number(v), f"{k} is {v!r}, not a number or null"
                )
        with self.lock:
            now = time.time()
            self._append(
                run_dir / "metrics.jsonl", ({**row, "time": now} for row in rows)
            )
            meta = self._touch(run_dir, now, (row["step"] for row in rows))
            for row in rows:
                for k, v in row.items():
                    if k != "step" and v is not None:
                        meta["latest"][k] = v
            self._write_meta(run_dir, meta)

    def log_media(self, run_id: str, entries: Any) -> None:
        run_dir = self._dir(run_id)
        checked = []
        for entry in _check_rows(entries, "media entries"):
            key, file = entry.get("key"), entry.get("file")
            _check(
                isinstance(key, str) and 0 < len(key) <= 200,
                "a media entry's key is a string of 1-200 characters",
            )
            if not (isinstance(file, str) and valid_path(file)):
                raise Invalid(f"{file!r} isn't a file path")
            _check(
                (run_dir / "files" / file).is_file(),
                f"no file {file}: upload it before the entry naming it",
            )
            out = {"key": key, "step": entry["step"], "file": file}
            if (t := entry.get("type")) is not None:
                _check(
                    isinstance(t, str) and bool(TYPE.fullmatch(t)),
                    f"{t!r} isn't a type: <namespace>/<name>, lowercase",
                )
                out["type"] = t
            if (attrs := entry.get("attrs")) is not None:
                _check(isinstance(attrs, dict), "attrs is a JSON object")
                _check(len(json.dumps(attrs)) <= MAX_ATTRS, "attrs is at most 64 KiB")
                out["attrs"] = attrs
            checked.append(out)
        with self.lock:
            now = time.time()
            self._append(run_dir / "media.jsonl", ({**e, "time": now} for e in checked))
            meta = self._touch(run_dir, now, (e["step"] for e in checked))
            self._write_meta(run_dir, meta)

    def append_stream(self, run_id: str, name: str, rows: Any) -> None:
        run_dir = self._dir(run_id)
        _check(bool(STREAM.fullmatch(name)), f"{name!r} isn't a stream name")
        _check_rows(rows, "stream rows")
        with self.lock:
            now = time.time()
            self._append(
                run_dir / "streams" / f"{name}.jsonl",
                ({**row, "time": now} for row in rows),
            )
            meta = self._touch(run_dir, now, (row["step"] for row in rows))
            self._write_meta(run_dir, meta)

    def put_file(self, run_id: str, path: str, body: Readable, size: int) -> bool:
        """Store `size` bytes read from `body` as the run's file `path`; whether it's
        new (False if it was there already, with the same bytes)."""
        run_dir = self._dir(run_id)
        _check(valid_path(path), f"{path!r} isn't a file path")
        if size > self.max_file:
            raise TooLarge(f"files are at most {self.max_file} bytes here")
        target = run_dir / "files" / path
        target.parent.mkdir(parents=True, exist_ok=True)
        # written aside and moved into place, so a reader never sees half a file
        fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".upload-")
        digest = hashlib.sha256()
        try:
            with os.fdopen(fd, "wb") as f:
                left = size
                while left:
                    chunk = body.read(min(left, 1 << 20))
                    if not chunk:
                        raise Invalid("the body ended before Content-Length")
                    digest.update(chunk)
                    f.write(chunk)
                    left -= len(chunk)
            with self.lock:
                if target.exists():
                    if _sha256(target) != digest.hexdigest():
                        raise Conflict(f"{path} exists with other bytes")
                    return False
                os.replace(tmp, target)
                meta = self._read_meta(run_dir)
                meta["updated"] = time.time()
                self._write_meta(run_dir, meta)
                return True
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def set_activity(self, run_id: str, body: Any) -> None:
        run_dir = self._dir(run_id)
        _check(isinstance(body, dict) and "activity" in body, "{activity} is needed")
        activity = body["activity"]
        _check(
            activity is None
            or (isinstance(activity, str) and len(activity) <= MAX_ACTIVITY),
            f"activity is null or a string of at most {MAX_ACTIVITY} characters",
        )
        with self.lock:
            now = time.time()
            meta = self._touch(run_dir, now)
            if meta.get("activity") != activity:
                meta["activity"] = activity
                meta["activity_since"] = now if activity is not None else None
            self._write_meta(run_dir, meta)

    def finish(self, run_id: str, body: Any) -> None:
        run_dir = self._dir(run_id)
        _check(isinstance(body, dict), "finish takes a JSON object")
        status = body.get("status", "finished")
        _check(
            isinstance(status, str)
            and bool(STATUS.fullmatch(status))
            and status != "running",
            f"{status!r} isn't a status a run can finish with",
        )
        with self.lock:
            meta = self._read_meta(run_dir)
            meta["status"] = status
            meta["updated"] = time.time()
            meta["activity"] = None
            meta["activity_since"] = None
            self._write_meta(run_dir, meta)

    # ------------------------------------------------------------ reads

    def list(self) -> list[dict[str, Any]]:
        runs = []
        for run_dir in self.root.iterdir():
            if not RUN_ID.fullmatch(run_dir.name):
                continue
            try:
                meta = self._read_meta(run_dir)
            except (OSError, ValueError):
                continue
            meta.pop("config", None)
            runs.append(meta)
        return sorted(runs, key=lambda m: m["created"], reverse=True)

    def get(self, run_id: str) -> dict[str, Any]:
        return self._read_meta(self._dir(run_id))

    def _read_jsonl(self, path: Path, since: int) -> dict[str, Any]:
        """Rows from `since` on, and how many there are."""
        if not path.exists():
            return {"rows": [], "next": 0}
        with open(path) as f:
            lines = f.readlines()
        # a line still being written has no newline yet; leave it for the next read
        if lines and not lines[-1].endswith("\n"):
            lines.pop()
        return {
            "rows": [json.loads(line) for line in lines[max(since, 0) :]],
            "next": len(lines),
        }

    def metrics(self, run_id: str, since: int = 0) -> dict[str, Any]:
        return self._read_jsonl(self._dir(run_id) / "metrics.jsonl", since)

    def media(self, run_id: str, since: int = 0) -> dict[str, Any]:
        return self._read_jsonl(self._dir(run_id) / "media.jsonl", since)

    def stream(self, run_id: str, name: str, since: int = 0) -> dict[str, Any]:
        run_dir = self._dir(run_id)
        _check(bool(STREAM.fullmatch(name)), f"{name!r} isn't a stream name")
        return self._read_jsonl(run_dir / "streams" / f"{name}.jsonl", since)

    def file_path(self, run_id: str, path: str) -> Path:
        run_dir = self._dir(run_id)
        target = run_dir / "files" / path
        if not valid_path(path) or not target.is_file():
            raise NotFound(f"no file {path}")
        return target

    # ------------------------------------------------------------ bundles

    def bundle(self, hash: str) -> dict[str, Any]:
        """The bundle's hash and files ({path, size}), if the server has it."""
        root = self.bundles / hash
        if not HASH.fullmatch(hash) or not root.is_dir():
            raise NotFound(f"no bundle {hash}")
        files = [
            {"path": p.relative_to(root).as_posix(), "size": p.stat().st_size}
            for p in sorted(root.rglob("*"))
            if p.is_file()
        ]
        return {"hash": hash, "files": files}

    def put_bundle(self, hash: str, files: dict[str, bytes]) -> bool:
        """Store a bundle; whether it's new."""
        _check(bool(HASH.fullmatch(hash)), f"{hash!r} isn't a bundle hash")
        for path in files:
            _check(valid_path(path), f"{path!r} isn't a bundle path")
        _check("layout.json" in files, "a bundle has a layout.json")
        try:
            layout = json.loads(files["layout.json"])
        except ValueError as e:
            raise Invalid(f"layout.json isn't JSON ({e})") from e
        _check(
            isinstance(layout, dict) and _is_int(layout.get("contract")),
            "layout.json is a JSON object with an integer contract",
        )
        actual = bundle_hash(files)
        _check(actual == hash, f"the files hash to {actual}, not {hash}")
        target = self.bundles / hash
        if target.is_dir():
            return False
        self.bundles.mkdir(exist_ok=True)
        # written aside and renamed into place: bundles/<hash> existing means it's whole
        tmp = Path(tempfile.mkdtemp(dir=self.bundles, prefix=".upload-"))
        try:
            for path, data in files.items():
                (tmp / path).parent.mkdir(parents=True, exist_ok=True)
                (tmp / path).write_bytes(data)
            with self.lock:
                if target.is_dir():
                    return False
                tmp.rename(target)
                return True
        finally:
            if tmp.exists():
                shutil.rmtree(tmp)

    def bundle_path(self, hash: str, path: str) -> Path:
        target = self.bundles / hash / path
        if not HASH.fullmatch(hash) or not valid_path(path) or not target.is_file():
            raise NotFound(f"no file {path} in bundle {hash}")
        return target


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()
