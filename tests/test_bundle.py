import hashlib
from pathlib import Path

import pytest

from seaglass import Monitor
from seaglass.bundle import bundle_hash, problems, read_bundle

from .conftest import Server


def test_hash_follows_the_spec():
    files = {"layout.json": b"{}", "a.js": b"x", "B.js": b"", "v/é.js": b"yz"}
    # sorted bytewise: "B.js" < "a.js" < "layout.json" < "v/é.js"
    expected = hashlib.sha256(
        b"B.js\x000\x00"
        + b"a.js\x001\x00x"
        + b"layout.json\x002\x00{}"
        + "v/é.js".encode()
        + b"\x002\x00yz"
    ).hexdigest()
    assert bundle_hash(files) == expected
    # renaming a file changes it, as does its content
    assert bundle_hash({**files, "a.js": b"y"}) != expected


def write(root: Path, files: dict[str, str]) -> Path:
    for path, text in files.items():
        (root / path).parent.mkdir(parents=True, exist_ok=True)
        (root / path).write_text(text)
    return root


def test_read_bundle_skips_dotfiles(tmp_path: Path):
    write(
        tmp_path,
        {
            "layout.json": "{}",
            "a.js": "",
            ".git/x": "",
            "sub/.DS_Store": "",
            "sub/b.js": "",
        },
    )
    assert sorted(read_bundle(tmp_path)) == ["a.js", "layout.json", "sub/b.js"]
    with pytest.raises(FileNotFoundError):
        read_bundle(tmp_path / "sub")


def test_problems():
    good = {
        "layout.json": b'{"contract": 1, "renderers": {"p/t": "r.js"}, "tabs": [{"title": "t", "panel": {"type": "view", "module": "v/view.js"}}]}',
        "r.js": b'import { h } from "./dom.js";\nexport { x } from "./v/view.js";\nexport function render() {}',
        "dom.js": b"export const h = 1;",
        "v/view.js": b'import { h } from "../dom.js";\nconst m = await import("./lazy.js");\nexport const x = 1;',
        "v/lazy.js": b"",
    }
    assert problems(good) == []
    bad = {
        **good,
        "layout.json": b'{"contract": 1, "renderers": {"p/t": "gone.js"}}',
        "r.js": b'import x from "lodash";\nimport "/abs.js";\nimport y from "./nope.js";\nimport z from "../../out.js";',
    }
    found = problems(bad)
    assert any("gone.js" in p for p in found)
    assert any("'lodash'" in p for p in found)
    assert any("'/abs.js'" in p for p in found)
    assert any("'./nope.js'" in p for p in found)
    assert any("'../../out.js'" in p for p in found)
    assert problems({"x.js": b""}) and problems({"layout.json": b"[]"})
    # what a metric is moved from the layout to the run
    for field in (b'"summary": ["loss"]', b'"descriptions": {"loss": "the TD loss"}'):
        layout = b'{"contract": 1, ' + field + b"}"
        assert any(
            "monitor.describe()" in p for p in problems({**good, "layout.json": layout})
        )


def test_example_bundle_is_clean():
    views = Path(__file__).parents[1] / "examples" / "gridworld" / "views"
    assert problems(read_bundle(views)) == []


def test_upload_once_then_dedupe(server: Server, tmp_path: Path):
    views = write(
        tmp_path / "views",
        {"layout.json": '{"contract": 1}', "r.js": "export function render() {}"},
    )
    calls = []

    def counting(m: Monitor) -> Monitor:
        real = m._request
        m._request = lambda method, path, *a, **k: (
            calls.append((method, path)) or real(method, path, *a, **k)
        )  # type: ignore[method-assign]
        return m

    first = counting(Monitor(server.url, views=views))
    first.start()
    hash = first.bundle_hash
    assert ("PUT", f"/api/bundles/{hash}") in calls
    assert server.get(f"/api/runs/{first.run_id}")["bundle"] == hash
    calls.clear()
    second = counting(Monitor(server.url, views=views))
    second.start()
    assert second.bundle_hash == hash
    assert ("GET", f"/api/bundles/{hash}") in calls
    assert not any(method == "PUT" for method, _ in calls)
    assert server.get(f"/api/runs/{second.run_id}")["bundle"] == hash
    # one copy on the server
    assert [p.name for p in (server.root / "bundles").iterdir()] == [hash]
    # an edit is a new bundle; the old runs keep theirs
    (views / "r.js").write_text("export function render() { /* v2 */ }")
    third = Monitor(server.url, views=views)
    third.start()
    assert third.bundle_hash != hash
    assert server.get(f"/api/runs/{first.run_id}")["bundle"] == hash
    assert len(list((server.root / "bundles").iterdir())) == 2
    for m in (first, second, third):
        m.finish()


def test_a_run_starts_even_if_its_bundle_cant_upload(
    server: Server, tmp_path: Path, capsys
):
    views = write(tmp_path / "views", {"layout.json": '{"contract": 1}'})
    m = Monitor(server.url, views=views)
    real = m._request
    m._request = lambda method, path, *a, **k: (
        None if method == "PUT" else real(method, path, *a, **k)
    )  # type: ignore[method-assign]
    m.start()
    assert m.run_id is not None
    assert "didn't upload" in capsys.readouterr().err
    assert server.get(f"/api/runs/{m.run_id}")["bundle"] == m.bundle_hash
    m.finish()


def test_monitor_warns_about_a_bundle_that_breaks_the_contract(tmp_path: Path, capsys):
    views = write(
        tmp_path / "views",
        {"layout.json": '{"contract": 1}', "a.js": 'import "react";'},
    )
    Monitor("http://127.0.0.1:9", views=views)
    assert "'react'" in capsys.readouterr().err
