import http.client
import json
from urllib.parse import urlparse

import pytest

from seaglass.bundle import bundle_hash

from .conftest import Server


def run_id(server: Server, **body) -> str:
    status, meta = server.post("/api/runs", body)
    assert status == 201
    return meta["id"]


def test_info_and_cors(server: Server):
    status, headers, body = server.request("GET", "/api")
    assert status == 200
    assert headers["Access-Control-Allow-Origin"] == "*"
    assert json.loads(body)["protocol"] == 1


def test_a_run_round_trip(server: Server):
    run = run_id(server, project="p", tags=["a"], config={"lr": 1})
    assert server.post(f"/api/runs/{run}/metrics", [{"step": 1, "loss": 0.5}]) == (
        200,
        {"ok": True},
    )
    status, _, _ = server.request(
        "PUT", f"/api/runs/{run}/files/ep/1.npz", b"PK\x05\x06"
    )
    assert status == 201
    assert (
        server.post(
            f"/api/runs/{run}/media", [{"key": "ep", "step": 1, "file": "ep/1.npz"}]
        )[0]
        == 200
    )
    assert server.post(f"/api/runs/{run}/streams/s", [{"step": 2, "x": [1]}])[0] == 200
    assert server.post(f"/api/runs/{run}/activity", {"activity": "eval"})[0] == 200
    assert server.post(f"/api/runs/{run}/notes", {"notes": "why"}) == (
        200,
        {"ok": True},
    )
    assert server.post(f"/api/runs/{run}/conclusions", {"conclusions": "it"}) == (
        200,
        {"ok": True},
    )
    assert server.post(
        f"/api/runs/{run}/declared", {"declared": {"loss": {"log": True}}}
    ) == (200, {"ok": True})
    meta = server.get(f"/api/runs/{run}")
    assert meta["step"] == 2 and meta["latest"] == {"loss": 0.5}
    assert meta["activity"] == "eval" and meta["config"] == {"lr": 1}
    assert meta["notes"] == "why" and meta["declared"] == {"loss": {"log": True}}
    assert meta["conclusions"] == "it"
    assert server.get(f"/api/runs/{run}/metrics?since=0")["next"] == 1
    assert server.get(f"/api/runs/{run}/media")["rows"][0]["file"] == "ep/1.npz"
    assert server.get(f"/api/runs/{run}/streams/s")["rows"][0]["x"] == [1]
    assert server.post(f"/api/runs/{run}/finish", {})[0] == 200
    assert server.get("/api/runs")[0]["status"] == "finished"


def test_nan_tokens_are_stored_as_null(server: Server):
    run = run_id(server)
    body = b'[{"step": 0, "loss": NaN, "x": Infinity}]'
    status, _, _ = server.request(
        "POST", f"/api/runs/{run}/metrics", body, {"Content-Type": "application/json"}
    )
    assert status == 200
    assert server.get(f"/api/runs/{run}/metrics")["rows"][0]["loss"] is None


def test_errors_are_json(server: Server):
    for method, path in [
        ("GET", "/api/runs/nope"),
        ("GET", "/nothing"),
        ("POST", "/api/x"),
    ]:
        status, headers, body = server.request(
            method, path, b"{}" if method == "POST" else None
        )
        assert status == 404
        assert headers["Content-Type"] == "application/json"
        assert "error" in json.loads(body)
    status, _, body = server.request(
        "POST", "/api/runs", b"{oops", {"Content-Type": "application/json"}
    )
    assert status == 400 and "error" in json.loads(body)
    status, _, _ = server.request("GET", "/api/runs/x/metrics?since=abc")
    assert status in (400, 404)


def test_frontend_routes(server: Server):
    for path in ["/", "/run/20990101-000000-0000", "/projects", "/project/gridworld"]:
        status, headers, body = server.request("GET", path)
        assert status == 200 and headers["Content-Type"] == "text/html"
        assert b"/static/app.js" in body
    status, headers, _ = server.request("GET", "/static/app.js")
    assert status == 200 and headers["Content-Type"] == "text/javascript"


@pytest.mark.parametrize(
    "path",
    [
        "/static/../server.py",
        "/static/%2e%2e/server.py",
        "/static/..%2fserver.py",
        "/api/runs/{run}/files/..%2fmeta.json",
        "/api/runs/{run}/files/%2e%2e/meta.json",
        "/bundles/{hash}/..%2f..%2f{run}%2fmeta.json",
    ],
)
def test_no_escaping_the_root(server: Server, path: str):
    run = run_id(server)
    files = {"layout.json": b'{"contract": 1}'}
    hash = bundle_hash(files)
    server.store.put_bundle(hash, files)
    # sent as is: urllib would normalize the dots away
    url = urlparse(server.url)
    conn = http.client.HTTPConnection(url.netloc)
    conn.request("GET", path.format(run=run, hash=hash))
    resp = conn.getresponse()
    body = resp.read()
    assert resp.status in (400, 404), body
    assert b"import" not in body and b'"id"' not in body


def test_bundle_upload(server: Server):
    import base64

    files = {
        "layout.json": b'{"contract": 1}',
        "a.js": b"export function render() {}\n",
    }
    hash = bundle_hash(files)
    status, _, _ = server.request("GET", f"/api/bundles/{hash}")
    assert status == 404
    body = json.dumps(
        {"files": {p: base64.b64encode(b).decode() for p, b in files.items()}}
    )

    def put():
        return server.request("PUT", f"/api/bundles/{hash}", body.encode())

    assert put()[0] == 201
    assert put()[0] == 200
    status, headers, data = server.request("GET", f"/bundles/{hash}/a.js")
    assert status == 200 and data == files["a.js"]
    assert headers["Content-Type"] == "text/javascript"
    assert headers["Access-Control-Allow-Origin"] == "*"
    assert "immutable" in headers["Cache-Control"]


def test_too_large_bodies_are_refused(server: Server):
    server.store.max_file = 10
    run = run_id(server)
    status, _, body = server.request("PUT", f"/api/runs/{run}/files/big.bin", b"x" * 11)
    assert status == 413 and "error" in json.loads(body)
    # and the server is still answering
    assert server.get("/api")["protocol"] == 1


def test_files_stream_back_with_their_type(server: Server):
    run = run_id(server)
    data = bytes(range(256)) * 4096
    status, _, _ = server.request("PUT", f"/api/runs/{run}/files/x/blob.bin", data)
    assert status == 201
    status, headers, body = server.request("GET", f"/api/runs/{run}/files/x/blob.bin")
    assert status == 200 and body == data
    assert headers["Content-Type"] == "application/octet-stream"


def test_keep_alive_survives_errors(server: Server):
    # a refused request's body mustn't be taken for the next request
    url = urlparse(server.url)
    conn = http.client.HTTPConnection(url.netloc)
    conn.request(
        "POST", "/api/runs/20990101-000000-0000/metrics", body=b'[{"step": 0}]'
    )
    resp = conn.getresponse()
    resp.read()
    assert resp.status == 404
    try:
        conn.request("GET", "/api")
        resp = conn.getresponse()
        assert resp.status == 200
    except (ConnectionError, http.client.HTTPException):
        # closing the connection instead is fine too
        pass
