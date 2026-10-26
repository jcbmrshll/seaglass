import io
import json
from pathlib import Path

import pytest

from seaglass.bundle import bundle_hash
from seaglass.store import RUN_ID, Conflict, Invalid, NotFound, RunStore, TooLarge


@pytest.fixture
def store(tmp_path: Path) -> RunStore:
    return RunStore(tmp_path)


def put(store: RunStore, run_id: str, path: str, data: bytes) -> bool:
    return store.put_file(run_id, path, io.BytesIO(data), len(data))


def test_create_defaults(store: RunStore):
    meta = store.create({})
    assert RUN_ID.fullmatch(meta["id"])
    assert meta["project"] == "default"
    assert meta["status"] == "running"
    assert meta["step"] is None and meta["latest"] == {} and meta["tags"] == []
    assert meta["name"].endswith("-1")
    # the next run of the project is numbered after it
    assert store.create({})["name"].endswith("-2")
    assert store.get(meta["id"]) == meta


@pytest.mark.parametrize(
    "body",
    [
        [],
        {"project": "a b"},
        {"project": ".hidden"},
        {"name": ""},
        {"tags": "a"},
        {"tags": ["a,b"]},
        {"tags": ["x"] * 33},
        {"bundle": "ABC"},
        {"total": True},
        {"config": 3},
        {"provenance": []},
    ],
)
def test_create_invalid(store: RunStore, body):
    with pytest.raises(Invalid):
        store.create(body)


def test_metrics_update_meta(store: RunStore):
    run = store.create({})["id"]
    store.log_metrics(
        run, [{"step": 4, "loss": 2.0, "acc": None}, {"step": 2, "loss": 1}]
    )
    meta = store.get(run)
    assert meta["step"] == 4
    assert meta["latest"] == {"loss": 1}
    rows = store.metrics(run)["rows"]
    assert [r["step"] for r in rows] == [4, 2]
    assert all("time" in r for r in rows)


@pytest.mark.parametrize(
    "rows",
    [
        {"step": 0},
        [{"loss": 1}],
        [{"step": "0", "loss": 1}],
        [{"step": 0, "loss": "1"}],
        [{"step": 0, "loss": True}],
        [{"step": 0, "time": 1}],
        [{"step": 0, "": 1}],
    ],
)
def test_metrics_invalid(store: RunStore, rows):
    run = store.create({})["id"]
    with pytest.raises(Invalid):
        store.log_metrics(run, rows)
    assert store.metrics(run) == {"rows": [], "next": 0}


def test_incremental_reads_skip_a_partial_line(store: RunStore):
    run = store.create({})["id"]
    store.log_metrics(run, [{"step": 0, "x": 1}, {"step": 1, "x": 2}])
    assert store.metrics(run, since=1)["rows"][0]["step"] == 1
    assert store.metrics(run, since=5) == {"rows": [], "next": 2}
    # a writer half way through a line
    with open(store.root / run / "metrics.jsonl", "a") as f:
        f.write('{"step": 2, "x"')
    assert store.metrics(run)["next"] == 2


def test_files_are_immutable(store: RunStore):
    run = store.create({})["id"]
    assert put(store, run, "a/b.json", b"{}") is True
    assert put(store, run, "a/b.json", b"{}") is False
    with pytest.raises(Conflict):
        put(store, run, "a/b.json", b"[]")
    assert store.file_path(run, "a/b.json").read_bytes() == b"{}"
    # nothing half-written is left behind
    assert [p.name for p in (store.root / run / "files" / "a").iterdir()] == ["b.json"]


@pytest.mark.parametrize(
    "path", ["../meta.json", "a/../b", ".x", "a//b", "a b", "", "x" * 256]
)
def test_bad_file_paths(store: RunStore, path):
    run = store.create({})["id"]
    with pytest.raises(Invalid):
        put(store, run, path, b"x")
    with pytest.raises(NotFound):
        store.file_path(run, path)


def test_file_size_limit(tmp_path: Path):
    store = RunStore(tmp_path, max_file=3)
    run = store.create({})["id"]
    with pytest.raises(TooLarge):
        put(store, run, "big", b"1234")


def test_media_needs_its_file(store: RunStore):
    run = store.create({})["id"]
    with pytest.raises(Invalid, match="upload it before"):
        store.log_media(run, [{"key": "k", "step": 0, "file": "x.npz"}])
    put(store, run, "x.npz", b"PK")
    store.log_media(
        run,
        [{"key": "k", "step": 3, "file": "x.npz", "type": "p/t", "attrs": {"a": 1}}],
    )
    (entry,) = store.media(run)["rows"]
    assert entry["type"] == "p/t" and entry["attrs"] == {"a": 1} and "time" in entry
    assert store.get(run)["step"] == 3
    with pytest.raises(Invalid):
        store.log_media(run, [{"key": "k", "step": 0, "file": "x.npz", "type": "T"}])
    with pytest.raises(Invalid):
        big = {"x": "y" * 70_000}
        store.log_media(run, [{"key": "k", "step": 0, "file": "x.npz", "attrs": big}])


def test_streams(store: RunStore):
    run = store.create({})["id"]
    assert store.stream(run, "members") == {"rows": [], "next": 0}
    store.append_stream(run, "members", [{"step": 1, "ids": [1], "time": 0}])
    (row,) = store.stream(run, "members")["rows"]
    assert row["ids"] == [1] and row["time"] > 0
    with pytest.raises(Invalid):
        store.append_stream(run, "../x", [{"step": 1}])
    with pytest.raises(Invalid):
        store.append_stream(run, "members", [{"ids": []}])


def test_activity_and_finish(store: RunStore):
    run = store.create({})["id"]
    store.set_activity(run, {"activity": "a"})
    since = store.get(run)["activity_since"]
    store.set_activity(run, {"activity": "a"})
    assert store.get(run)["activity_since"] == since
    store.finish(run, {"status": "crashed"})
    meta = store.get(run)
    assert meta["status"] == "crashed" and meta["activity"] is None
    # logging continues a finished run
    store.log_metrics(run, [{"step": 9, "x": 1}])
    assert store.get(run)["status"] == "running"
    for bad in [{"status": "running"}, {"status": "Bad"}, []]:
        with pytest.raises(Invalid):
            store.finish(run, bad)
    with pytest.raises(Invalid):
        store.set_activity(run, {"activity": "x" * 501})


def test_list_skips_what_isnt_a_run(store: RunStore):
    a = store.create({"config": {"big": 1}})["id"]
    (store.root / "notes").mkdir()
    (store.root / "20990101-000000-dead").mkdir()  # no meta.json
    store.put_bundle(*_bundle({"layout.json": b'{"contract": 1}'}))
    runs = store.list()
    assert [r["id"] for r in runs] == [a]
    assert "config" not in runs[0]
    with pytest.raises(NotFound):
        store.get("20990101-000000-dead")


def _bundle(files: dict[str, bytes]) -> tuple[str, dict[str, bytes]]:
    return bundle_hash(files), files


def test_bundles_are_stored_once_by_hash(store: RunStore):
    files = {"layout.json": b'{"contract": 1}', "v/m.js": b"export const a = 1;\n"}
    hash, files = _bundle(files)
    with pytest.raises(NotFound):
        store.bundle(hash)
    assert store.put_bundle(hash, files) is True
    assert store.put_bundle(hash, files) is False
    assert store.bundle(hash) == {
        "hash": hash,
        "files": [{"path": "layout.json", "size": 15}, {"path": "v/m.js", "size": 20}],
    }
    assert store.bundle_path(hash, "v/m.js").read_bytes() == files["v/m.js"]
    # no temporary directories left
    assert [p.name for p in store.bundles.iterdir()] == [hash]


@pytest.mark.parametrize(
    "files",
    [
        {"m.js": b""},
        {"layout.json": b"nope"},
        {"layout.json": b"[]"},
        {"layout.json": b'{"contract": "1"}'},
        {"layout.json": b'{"contract": 1}', "../x": b""},
    ],
)
def test_bad_bundles(store: RunStore, files):
    with pytest.raises(Invalid):
        store.put_bundle(bundle_hash(files), files)


def test_bundle_hash_must_match(store: RunStore):
    with pytest.raises(Invalid, match="hash to"):
        store.put_bundle("0" * 64, {"layout.json": b'{"contract": 1}'})


def test_meta_on_disk_is_the_layout_of_the_spec(store: RunStore):
    run = store.create({"project": "p"})["id"]
    store.log_metrics(run, [{"step": 0, "x": 1}])
    put(store, run, "f.json", b"1")
    store.log_media(run, [{"key": "k", "step": 0, "file": "f.json"}])
    store.append_stream(run, "s", [{"step": 0}])
    run_dir = store.root / run
    assert json.loads((run_dir / "meta.json").read_text())["project"] == "p"
    assert sorted(p.relative_to(run_dir).as_posix() for p in run_dir.rglob("*")) == [
        "files",
        "files/f.json",
        "media.jsonl",
        "meta.json",
        "metrics.jsonl",
        "streams",
        "streams/s.jsonl",
    ]
