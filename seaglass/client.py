"""Send a training run's metrics and data to a seaglass server.

    monitor = Monitor(project="gridworld", views="views/")
    monitor.start(config={"lr": 3e-4}, total=300)
    monitor.activity("collecting episodes")
    monitor.log(step, {"loss": 0.41, "episode": Arrays("gridworld/episode", grid=g)})
    monitor.finish()

What `log` takes, by value:

    a number (python, numpy or jax scalar)   a metric
    Arrays(type, **arrays)                   arrays, as an .npz file and a media entry
    Data(value, type=...) or a dict          JSON, as a .json file and a media entry
    File(data, suffix, type=...)             any bytes, as a file and a media entry
    Row(**fields)                            a row of the stream named by its key

Runs only send data: drawing it is the frontend's job, with the renderers of the
project's bundle (`views`). Everything but `start` happens on a background thread,
so the training loop never waits on copies off the device or the network, and
logging never raises: if the server is down the run keeps training, says so once,
and drops what it can't send. A heartbeat resends the run's activity every
`heartbeat` seconds, so a frontend can tell a busy run from a dead one.
"""

import atexit
import base64
import io
import json
import math
import os
import platform
import queue
import re
import secrets
import socket
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from numbers import Number
from pathlib import Path
from typing import Any, Self
from urllib.parse import quote

import numpy as np

from seaglass.bundle import bundle_hash, problems, read_bundle

DEFAULT_URL = "http://localhost:8008"
HEARTBEAT_S = 30.0
# how long a run that ends without finish() waits for what it logged to be sent
EXIT_FLUSH_S = 10.0


def _log(message: str) -> None:
    print(f"seaglass: {message}", file=sys.stderr)


class Arrays:
    """Named arrays (numpy, jax, or anything np.asarray takes), sent as an .npz file
    and drawn by the bundle's renderer for `type`, e.g.
    Arrays("gridworld/episode", grid=grids, agent=positions).

    Arrays are kept as they are, but for 64-bit integers, which become int32 when
    every value fits (browsers read int64 as BigInt). Strings and objects can't be
    sent."""

    def __init__(
        self,
        type: str | None = None,
        /,
        *,
        attrs: dict[str, Any] | None = None,
        **arrays: Any,
    ):
        self.type = type
        self.attrs = attrs
        # copied off the device on the sender thread, not here
        self.arrays = arrays

    def encode(self) -> bytes:
        out = {}
        for name, value in self.arrays.items():
            a = np.asarray(value)
            wide = a.dtype.kind in "iu" and a.dtype.itemsize == 8
            if wide and (not a.size or (a.min() >= -(2**31) and a.max() < 2**31)):
                a = a.astype(np.int32)
            if a.dtype.kind not in "biuf":
                raise TypeError(f"{name} is {a.dtype}, not numbers")
            out[name] = np.ascontiguousarray(a, dtype=a.dtype.newbyteorder("<"))
        buf = io.BytesIO()
        np.savez_compressed(buf, **out)  # pyright: ignore[reportArgumentType]
        return buf.getvalue()


class Data:
    """A JSON value, sent as a .json file, drawn by the renderer for `type` or shown
    as it is."""

    def __init__(
        self,
        value: Any,
        /,
        type: str | None = None,
        attrs: dict[str, Any] | None = None,
    ):
        self.value = value
        self.type = type
        self.attrs = attrs

    def encode(self) -> bytes:
        return _dumps(self.value).encode()


class File:
    """Bytes the run made itself, e.g. File(png, ".png"), sent as a file with that
    suffix."""

    def __init__(
        self,
        data: bytes,
        /,
        suffix: str,
        type: str | None = None,
        attrs: dict[str, Any] | None = None,
    ):
        if not re.fullmatch(r"\.[A-Za-z0-9]{1,10}", suffix):
            raise ValueError(f"{suffix!r} isn't a file suffix like '.png'")
        self.data = data
        self.suffix = suffix
        self.type = type
        self.attrs = attrs

    def encode(self) -> bytes:
        return self.data


class Row:
    """A row of the run's stream named by the key it's logged under, e.g.
    log(step, {"members": Row(ids=ids, fitness=fitness)}). Arrays become lists."""

    def __init__(self, **fields: Any):
        self.fields = fields


def _plain(value: Any) -> Any:
    """`value` as JSON can have it: arrays as lists, non-finite numbers as null."""
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    if hasattr(value, "__array__") or isinstance(value, np.generic):
        return _plain(np.asarray(value).tolist())
    # config can hold functions and classes; name them rather than repr
    return getattr(value, "__name__", None) or str(value)


def _dumps(value: Any) -> str:
    return json.dumps(_plain(value), allow_nan=False)


def to_number(value: Any) -> float | None:
    """A plain float for scalars (python, numpy or jax), None for anything else."""
    if isinstance(value, (bool, Number)):
        return float(value)  # type: ignore[arg-type]
    if getattr(value, "shape", None) == () and hasattr(value, "item"):
        item = value.item()
        return float(item) if isinstance(item, (bool, Number)) else None  # type: ignore[arg-type]
    return None


def _safe(key: str) -> str:
    """A media key as a file path segment."""
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", key).lstrip(".")[:100] or "media"


def _git(*args: str) -> str | None:
    try:
        out = subprocess.run(
            ["git", *args], capture_output=True, text=True, timeout=5, check=True
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout.strip()


def provenance() -> dict[str, Any]:
    """Where this run comes from: its git commit, branch and whether the checkout
    has changes, the host, the command line and the working directory."""
    commit = _git("rev-parse", "HEAD")
    git = None
    if commit:
        status = _git("status", "--porcelain")
        git = {
            "commit": commit,
            "branch": _git("rev-parse", "--abbrev-ref", "HEAD"),
            "dirty": bool(status),
        }
    return {
        "git": git,
        "host": socket.gethostname(),
        "argv": list(sys.argv),
        "cwd": os.getcwd(),
        "python": platform.python_version(),
    }


class Monitor:
    """A run's connection to the server.

    Args:
        url: the server; else $SEAGLASS_URL, else http://localhost:8008
        project: the project the run belongs to
        name: the run's name; the server makes one up if None
        views: the project's bundle, a directory with a layout.json and the modules
            it names, which the run's pages are drawn with
        tags: labels for the run, as well as those in $SEAGLASS_TAGS (comma-separated)
        heartbeat: seconds between heartbeats
    """

    def __init__(
        self,
        url: str | None = None,
        project: str = "default",
        name: str | None = None,
        views: str | Path | None = None,
        tags: list[str] | None = None,
        heartbeat: float = HEARTBEAT_S,
    ):
        self.url = (url or os.environ.get("SEAGLASS_URL") or DEFAULT_URL).rstrip("/")
        self.project = project
        self.name = name
        env_tags = os.environ.get("SEAGLASS_TAGS", "").split(",")
        self.tags = list(dict.fromkeys([*(tags or []), *(t.strip() for t in env_tags)]))
        self.tags = [t for t in self.tags if t]
        self.bundle = read_bundle(views) if views is not None else None
        for problem in problems(self.bundle) if self.bundle else []:
            _log(f"views: {problem}")
        self.bundle_hash = bundle_hash(self.bundle) if self.bundle else None
        self.heartbeat_s = heartbeat
        self.run_id: str | None = None
        self._failing = False
        self._rejected: set[str] = set()
        self._dropped: set[str] = set()
        # (kind, payload) for the sender thread, in order
        self._queue: queue.Queue[tuple[str, Any]] = queue.Queue()
        self._sender: threading.Thread | None = None
        self._activity: str | None = None
        self._stop_heartbeat: threading.Event | None = None
        self._finished = False

    # ------------------------------------------------------------ http

    def _request(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        content_type: str = "application/json",
        timeout: float = 30,
        quiet_404: bool = False,
    ) -> Any:
        """The JSON response, or None if the request failed (said once per reason)."""
        req = urllib.request.Request(
            self.url + path,
            data=body,
            headers={"Content-Type": content_type} if body is not None else {},
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                result = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if not (quiet_404 and e.code == 404):
                # the server is up but refused this; say why, once per reason
                reason = f"{path.split('?')[0]}: {e.code} {e.read().decode(errors='replace')}"
                if reason not in self._rejected:
                    self._rejected.add(reason)
                    _log(f"rejected {reason}")
            return None
        except (urllib.error.URLError, OSError, ValueError) as e:
            if not self._failing:
                _log(f"can't reach {self.url} ({e})")
            self._failing = True
            return None
        if self._failing:
            _log(f"reconnected to {self.url}")
            self._failing = False
        return result

    def _post(self, path: str, obj: Any) -> Any:
        return self._request("POST", path, _dumps(obj).encode())

    # ------------------------------------------------------------ start

    def start(self, config: dict[str, Any] | None = None, total: int | None = None):
        """Create the run on the server, after uploading the bundle if the server
        doesn't have it. Calling it again continues the same run."""
        if self.run_id is not None:
            self._start_heartbeat()
            return self
        if self.bundle_hash and not self._upload_bundle():
            _log("the run's views didn't upload; its pages use the default layout")
        meta = self._post(
            "/api/runs",
            {
                "project": self.project,
                "name": self.name,
                "config": config or {},
                "tags": self.tags,
                "provenance": provenance(),
                "bundle": self.bundle_hash,
                "total": total,
            },
        )
        if meta is None:
            _log("logging is off for this run")
            return self
        self.run_id = meta["id"]
        print(f"seaglass: {self.url}/run/{self.run_id}", file=sys.stderr)
        self._start_heartbeat()
        atexit.register(self._at_exit)
        return self

    def _upload_bundle(self) -> bool:
        assert self.bundle is not None
        path = f"/api/bundles/{self.bundle_hash}"
        if self._request("GET", path, quiet_404=True) is not None:
            return True
        files = {p: base64.b64encode(b).decode() for p, b in self.bundle.items()}
        return (
            self._request("PUT", path, json.dumps({"files": files}).encode())
            is not None
        )

    # ------------------------------------------------------------ sending

    def _enqueue(self, kind: str, payload: Any) -> None:
        if self._sender is None:
            self._sender = threading.Thread(target=self._send, daemon=True)
            self._sender.start()
        self._queue.put((kind, payload))

    def _send(self) -> None:
        """The sender thread: takes what's queued, in order, batching metrics rows,
        media entries and stream rows that were queued together."""
        while True:
            batch = [self._queue.get()]
            while True:
                try:
                    batch.append(self._queue.get_nowait())
                except queue.Empty:
                    break
            try:
                self._send_batch(batch)
            finally:
                for _ in batch:
                    self._queue.task_done()

    def _send_batch(self, batch: list[tuple[str, Any]]) -> None:
        run = f"/api/runs/{self.run_id}"
        metrics: list[dict[str, Any]] = []
        media: list[dict[str, Any]] = []
        streams: dict[str, list[dict[str, Any]]] = {}

        def flush() -> None:
            if metrics:
                self._post(f"{run}/metrics", metrics)
            if media:
                self._post(f"{run}/media", media)
            for name, rows in streams.items():
                self._post(f"{run}/streams/{quote(name)}", rows)
            metrics.clear()
            media.clear()
            streams.clear()

        for kind, payload in batch:
            try:
                if kind == "log":
                    step, data = payload
                    self._encode(step, data, metrics, media, streams)
                    continue
                # what comes after a log may depend on it being there (finish)
                flush()
                if kind == "activity":
                    self._post(f"{run}/activity", {"activity": payload})
                elif kind == "finish":
                    self._post(f"{run}/finish", {"status": payload})
            except Exception as e:  # noqa: BLE001 - logging must never stop training
                _log(f"dropped a log ({type(e).__name__}: {e})")
        flush()

    def _encode(
        self,
        step: int,
        data: dict[str, Any],
        metrics: list[dict[str, Any]],
        media: list[dict[str, Any]],
        streams: dict[str, list[dict[str, Any]]],
    ) -> None:
        row: dict[str, Any] = {}
        for key, value in data.items():
            try:
                number = to_number(value)
                if number is not None:
                    row[key] = number if math.isfinite(number) else None
                elif isinstance(value, Row):
                    fields = _plain(value.fields)
                    streams.setdefault(key, []).append({**fields, "step": step})
                else:
                    if isinstance(value, dict):
                        value = Data(value)
                    if not isinstance(value, (Arrays, Data, File)):
                        if key not in self._dropped:
                            self._dropped.add(key)
                            _log(f"can't log {key}, a {type(value).__name__}; dropped")
                        continue
                    entry = self._upload(key, step, value)
                    if entry:
                        media.append(entry)
            except Exception as e:  # noqa: BLE001 - one bad value loses itself only
                _log(f"dropped {key} at step {step} ({type(e).__name__}: {e})")
        if row:
            metrics.append({"step": step, **row})

    def _upload(
        self, key: str, step: int, value: "Arrays | Data | File"
    ) -> dict[str, Any] | None:
        if isinstance(value, Arrays):
            suffix = ".npz"
        elif isinstance(value, Data):
            suffix = ".json"
        else:
            suffix = value.suffix
        path = f"{_safe(key)}/{step}-{secrets.token_hex(2)}{suffix}"
        body = value.encode()
        done = self._request(
            "PUT",
            f"/api/runs/{self.run_id}/files/{quote(path)}",
            body,
            content_type="application/octet-stream",
            timeout=120,
        )
        if done is None:
            return None
        entry: dict[str, Any] = {"key": key, "step": step, "file": path}
        if value.type is not None:
            entry["type"] = value.type
        if value.attrs is not None:
            entry["attrs"] = _plain(value.attrs)
        return entry

    # ------------------------------------------------------------ heartbeat

    def _start_heartbeat(self) -> None:
        if self._stop_heartbeat is not None and not self._stop_heartbeat.is_set():
            return
        stop = self._stop_heartbeat = threading.Event()
        threading.Thread(target=self._heartbeat, args=(stop,), daemon=True).start()

    def _heartbeat(self, stop: threading.Event) -> None:
        while not stop.wait(self.heartbeat_s):
            # anything already queued tells the server the run is alive when it's sent
            if self._queue.empty():
                self._enqueue("activity", self._activity)

    # ------------------------------------------------------------ the API

    def activity(self, text: str | None) -> None:
        """Say what the run is doing now, e.g. "epoch 3: evaluating"; None clears it."""
        self._activity = text
        if self.run_id is not None:
            self._enqueue("activity", text)

    def log(self, step: int, data: dict[str, Any]) -> None:
        """Queue values for one step (see the module's docstring); they're sent in the
        background. Values of other kinds are dropped, with a word the first time."""
        if self.run_id is not None:
            self._enqueue("log", (int(step), dict(data)))

    def flush(self, timeout: float | None = None) -> bool:
        """Wait until everything logged so far has been sent (or for `timeout`
        seconds); whether it all was."""
        if timeout is None:
            self._queue.join()
            return True
        done = threading.Event()

        def join() -> None:
            self._queue.join()
            done.set()

        threading.Thread(target=join, daemon=True).start()
        return done.wait(timeout)

    def finish(self, status: str = "finished") -> None:
        """Mark the run finished (or e.g. "crashed") once everything logged is sent."""
        if self.run_id is None:
            return
        if self._stop_heartbeat is not None:
            self._stop_heartbeat.set()
        self._activity = None
        self._finished = True
        self._enqueue("finish", status)
        self.flush()

    def _at_exit(self) -> None:
        # a script that ends without finish(): send what it logged, but don't hang
        unsent = not self._finished and self.run_id is not None
        if unsent and not self.flush(EXIT_FLUSH_S):
            _log("exited before everything logged was sent")

    def __enter__(self) -> Self:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self.run_id is None or self._finished:
            return
        if exc_type is None:
            self.finish()
        elif issubclass(exc_type, KeyboardInterrupt):
            self.finish("interrupted")
        else:
            self.finish("crashed")
