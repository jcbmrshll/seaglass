import json
import threading
import urllib.error
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from seaglass.server import make_server
from seaglass.store import RunStore


@dataclass
class Server:
    url: str
    root: Path
    store: RunStore

    def get(self, path: str) -> Any:
        with urllib.request.urlopen(self.url + path, timeout=10) as resp:
            return json.loads(resp.read())

    def request(
        self, method: str, path: str, body: bytes | None = None, headers=None
    ) -> tuple[int, dict[str, str], bytes]:
        req = urllib.request.Request(
            self.url + path, data=body, method=method, headers=headers or {}
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def post(self, path: str, obj: Any) -> tuple[int, Any]:
        status, _, body = self.request(
            "POST", path, json.dumps(obj).encode(), {"Content-Type": "application/json"}
        )
        return status, json.loads(body)


@pytest.fixture
def server(tmp_path: Path) -> Iterator[Server]:
    """A seaglass server on a free port, storing runs under a fresh directory."""
    srv = make_server("127.0.0.1", 0, tmp_path / "runs")
    thread = threading.Thread(target=srv.serve_forever, args=(0.05,), daemon=True)
    thread.start()
    store = srv.RequestHandlerClass.store  # type: ignore[attr-defined]
    yield Server(f"http://127.0.0.1:{srv.server_address[1]}", tmp_path / "runs", store)
    srv.shutdown()
    srv.server_close()


@pytest.fixture(autouse=True)
def _no_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # the client reads these; tests set them when they mean to
    monkeypatch.delenv("SEAGLASS_URL", raising=False)
    monkeypatch.delenv("SEAGLASS_TAGS", raising=False)
