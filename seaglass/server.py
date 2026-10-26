"""The seaglass server: the HTTP API of SPEC.md over a `RunStore`, and the basic
frontend (seaglass/static).

    seaglass serve --dir runs --host 127.0.0.1 --port 8008

Stdlib only: the server stores what runs send and serves it back, and never reads
arrays or draws anything.
"""

import base64
import binascii
import json
import shutil
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from seaglass import __version__
from seaglass.store import Conflict, Invalid, NotFound, RunStore, TooLarge

STATIC_DIR = Path(__file__).parent / "static"
MAX_JSON = 16 << 20
MAX_BUNDLE = 32 << 20

CONTENT_TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".html": "text/html",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".wasm": "application/wasm",
    ".txt": "text/plain",
}


def content_type(path: Path) -> str:
    return CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")


def _json_loads(data: bytes) -> Any:
    # NaN and infinities aren't JSON; a client that sends them anyway gets null
    try:
        return json.loads(data, parse_constant=lambda _: None)
    except ValueError as e:
        raise Invalid(f"the body isn't JSON ({e})") from e


def _since(query: dict[str, list[str]]) -> int:
    try:
        return int(query.get("since", ["0"])[0])
    except ValueError:
        raise Invalid("since is an integer") from None


class Handler(BaseHTTPRequestHandler):
    store: RunStore
    server_version = f"seaglass/{__version__}"
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        # a line per request is noise beside a training run
        pass

    # ------------------------------------------------------------ responses

    def _head(self, status: int, content_type: str, length: int, cache: bool) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header(
            "Cache-Control",
            "public, max-age=31536000, immutable" if cache else "no-cache",
        )
        if self.command == "GET":
            self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self._head(status, content_type, len(body), cache=False)
        self.wfile.write(body)

    def _json(self, obj: Any, status: int = HTTPStatus.OK) -> None:
        self._send(status, json.dumps(obj).encode(), "application/json")

    def _error(self, status: int, message: str) -> None:
        self._json({"error": message}, status)

    def _file(self, path: Path, cache: bool = False) -> None:
        with open(path, "rb") as f:
            size = path.stat().st_size
            self._head(HTTPStatus.OK, content_type(path), size, cache)
            shutil.copyfileobj(f, self.wfile)

    # ------------------------------------------------------------ requests

    def _length(self, limit: int) -> int:
        try:
            length = int(self.headers["Content-Length"])
        except (TypeError, ValueError):
            raise Invalid("requests with a body need a Content-Length") from None
        if length > limit:
            raise TooLarge(f"bodies here are at most {limit} bytes")
        self._consumed = True
        return length

    def _body_json(self, limit: int = MAX_JSON) -> Any:
        return _json_loads(self.rfile.read(self._length(limit)))

    def _route(self) -> tuple[list[str], dict[str, list[str]]]:
        url = urlparse(self.path)
        parts = [unquote(p) for p in url.path.split("/") if p]
        return parts, parse_qs(url.query)

    def _handle(self, fn) -> None:
        self._consumed = False
        try:
            try:
                fn()
            except (NotFound, Invalid, Conflict, TooLarge):
                # a body left unread would be taken for the next request
                if (
                    not self._consumed
                    and self.headers.get("Content-Length", "0") != "0"
                ):
                    self.close_connection = True
                raise
        except NotFound as e:
            self._error(HTTPStatus.NOT_FOUND, str(e))
        except Invalid as e:
            self._error(HTTPStatus.BAD_REQUEST, str(e))
        except Conflict as e:
            self._error(HTTPStatus.CONFLICT, str(e))
        except TooLarge as e:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, str(e))
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        self._handle(self._get)

    def do_POST(self):
        self._handle(self._post)

    def do_PUT(self):
        self._handle(self._put)

    def _get(self) -> None:
        parts, query = self._route()
        store = self.store
        match parts:
            case ["api"]:
                self._json({"protocol": 1, "server": f"seaglass/{__version__}"})
            case ["api", "runs"]:
                self._json(store.list())
            case ["api", "runs", run_id]:
                self._json(store.get(run_id))
            case ["api", "runs", run_id, "metrics"]:
                self._json(store.metrics(run_id, _since(query)))
            case ["api", "runs", run_id, "media"]:
                self._json(store.media(run_id, _since(query)))
            case ["api", "runs", run_id, "streams", name]:
                self._json(store.stream(run_id, name, _since(query)))
            case ["api", "runs", run_id, "files", *path] if path:
                self._file(store.file_path(run_id, "/".join(path)), cache=True)
            case ["api", "bundles", hash]:
                self._json(store.bundle(hash))
            case ["bundles", hash, *path] if path:
                self._file(store.bundle_path(hash, "/".join(path)), cache=True)
            case [] | ["run", _]:
                # the frontend routes in the browser, so every page is index.html
                self._file(STATIC_DIR / "index.html")
            case ["static", *path] if (
                path
                and not any(p.startswith(".") for p in path)
                and (STATIC_DIR.joinpath(*path)).is_file()
            ):
                self._file(STATIC_DIR.joinpath(*path))
            case _:
                raise NotFound("not found")

    def _post(self) -> None:
        parts, _ = self._route()
        store = self.store
        match parts:
            case ["api", "runs"]:
                self._json(store.create(self._body_json()), HTTPStatus.CREATED)
                return
            case ["api", "runs", run_id, "metrics"]:
                store.log_metrics(run_id, self._body_json())
            case ["api", "runs", run_id, "media"]:
                store.log_media(run_id, self._body_json())
            case ["api", "runs", run_id, "streams", name]:
                store.append_stream(run_id, name, self._body_json())
            case ["api", "runs", run_id, "activity"]:
                store.set_activity(run_id, self._body_json())
            case ["api", "runs", run_id, "finish"]:
                store.finish(run_id, self._body_json())
            case _:
                raise NotFound("not found")
        self._json({"ok": True})

    def _put(self) -> None:
        parts, _ = self._route()
        store = self.store
        match parts:
            case ["api", "runs", run_id, "files", *path] if path:
                path = "/".join(path)
                store.get(run_id)
                size = self._length(store.max_file)
                created = store.put_file(run_id, path, self.rfile, size)
                status = HTTPStatus.CREATED if created else HTTPStatus.OK
                self._json({"path": path, "size": size}, status)
            case ["api", "bundles", hash]:
                body = self._body_json(MAX_BUNDLE)
                files = body.get("files") if isinstance(body, dict) else None
                if not isinstance(files, dict):
                    raise Invalid("a bundle is uploaded as {files: {path: base64}}")
                try:
                    decoded = {
                        p: base64.b64decode(b, validate=True) for p, b in files.items()
                    }
                except (binascii.Error, TypeError) as e:
                    raise Invalid(f"a bundle file isn't base64 ({e})") from e
                created = store.put_bundle(hash, decoded)
                status = HTTPStatus.CREATED if created else HTTPStatus.OK
                self._json(store.bundle(hash), status)
            case _:
                raise NotFound("not found")


def make_server(host: str, port: int, root: str | Path) -> ThreadingHTTPServer:
    """The server, storing runs under `root` (port 0 picks a free one)."""
    handler = type("Handler", (Handler,), {"store": RunStore(root)})
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server
