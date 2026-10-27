import io
import json
import time

import numpy as np
import pytest

from seaglass import Arrays, Data, File, Monitor, Row
from seaglass.client import _safe, to_number

from .conftest import Server


def started(server: Server, **kwargs) -> Monitor:
    m = Monitor(server.url, project="test", **kwargs)
    m.start({"lr": 0.1, "fn": len, "arr": np.arange(3)}, total=9)
    assert m.run_id
    return m


def test_start_records_the_run(server: Server, monkeypatch):
    monkeypatch.setenv("SEAGLASS_TAGS", "sweep, b,,sweep")
    m = started(server, tags=["a"], name="named")
    meta = server.get(f"/api/runs/{m.run_id}")
    assert meta["project"] == "test" and meta["name"] == "named" and meta["total"] == 9
    assert meta["tags"] == ["a", "sweep", "b"]
    assert meta["notes"] is None
    # functions are named, arrays are lists
    assert meta["config"] == {"lr": 0.1, "fn": "len", "arr": [0, 1, 2]}
    prov = meta["provenance"]
    assert set(prov) >= {"git", "host", "argv", "cwd", "python"}
    assert prov["git"] is None or set(prov["git"]) == {"commit", "branch", "dirty"}
    m.finish()


def test_notes_are_passed_or_from_the_environment(server: Server, monkeypatch, capsys):
    monkeypatch.setenv("SEAGLASS_NOTES", "from the launcher")
    m = started(server)
    assert server.get(f"/api/runs/{m.run_id}")["notes"] == "from the launcher"
    m.finish()
    m = started(server, notes="from the script")
    assert server.get(f"/api/runs/{m.run_id}")["notes"] == "from the script"
    m.finish()
    # notes too long for the server are cut, rather than the run not starting
    m = started(server, notes="x" * 20000)
    assert server.get(f"/api/runs/{m.run_id}")["notes"] == "x" * 10000
    assert "notes cut" in capsys.readouterr().err
    m.finish()


def test_url_from_the_environment(server: Server, monkeypatch):
    monkeypatch.setenv("SEAGLASS_URL", server.url + "/")
    m = Monitor(project="env")
    assert m.url == server.url
    m.start()
    assert server.get(f"/api/runs/{m.run_id}")["project"] == "env"
    m.finish()


def test_log_sends_each_kind(server: Server):
    m = started(server)
    png = b"\x89PNG\r\n\x1a\nfake"
    for step in range(3):
        m.log(
            step,
            {
                "loss": np.float32(1 / (step + 1)),
                "bad": float("nan"),
                "flag": True,
                "zero_d": np.array(2.5),
                "ep": Arrays(
                    "t/ep",
                    attrs={"seed": np.int64(7)},
                    x=np.arange(4),
                    h=np.ones(2, np.float16),
                ),
                "cfg": {"step": step, "inf": float("inf")},
                "data": Data([1, 2], type="t/list"),
                "img": File(png, ".png"),
                "members": Row(ids=np.arange(2), fit=[0.5, float("nan")]),
            },
        )
    m.finish()
    run = m.run_id
    assert run is not None
    rows = server.get(f"/api/runs/{run}/metrics")["rows"]
    assert [r["step"] for r in rows] == [0, 1, 2]
    assert rows[1]["loss"] == pytest.approx(0.5) and rows[1]["bad"] is None
    assert rows[0]["flag"] == 1.0 and rows[0]["zero_d"] == 2.5
    media = server.get(f"/api/runs/{run}/media")["rows"]
    assert {e["key"] for e in media} == {"ep", "cfg", "data", "img"}
    ep = next(e for e in media if e["key"] == "ep")
    assert ep["type"] == "t/ep" and ep["attrs"] == {"seed": 7}
    assert ep["file"].startswith("ep/0-") and ep["file"].endswith(".npz")
    arrays = np.load(server.root / run / "files" / ep["file"])
    # int64 that fits is sent as int32 (browsers read int64 as BigInt); the rest as is
    assert arrays["x"].dtype == np.int32 and arrays["h"].dtype == np.float16
    cfg = next(e for e in media if e["key"] == "cfg" and e["step"] == 2)
    assert "type" not in cfg
    assert json.loads((server.root / run / "files" / cfg["file"]).read_text()) == {
        "step": 2,
        "inf": None,
    }
    img = next(e for e in media if e["key"] == "img")
    assert img["file"].endswith(".png")
    assert (server.root / run / "files" / img["file"]).read_bytes() == png
    stream = server.get(f"/api/runs/{run}/streams/members")["rows"]
    assert stream[0]["ids"] == [0, 1] and stream[0]["fit"] == [0.5, None]
    assert server.get(f"/api/runs/{run}")["status"] == "finished"


def test_metrics_are_batched(server: Server):
    m = started(server)
    posts = []
    real = m._post
    m._post = lambda path, obj: posts.append(path) or real(path, obj)  # type: ignore[method-assign]
    # hold the sender back so the logs queue up together
    m._enqueue("activity", "busy")
    for step in range(50):
        m.log(step, {"x": step})
    m.flush()
    metric_posts = [p for p in posts if p.endswith("/metrics")]
    assert len(metric_posts) < 50
    assert server.get(f"/api/runs/{m.run_id}/metrics")["next"] == 50
    m.finish()


def test_values_it_cant_send_are_dropped_with_a_word(server: Server, capsys):
    m = started(server)
    m.log(0, {"thing": object(), "strings": Arrays(s=np.array(["a"])), "ok": 1})
    m.log(1, {"thing": object()})
    m.finish()
    err = capsys.readouterr().err
    assert err.count("can't log thing") == 1
    assert "strings" in err
    assert server.get(f"/api/runs/{m.run_id}/metrics")["rows"][0]["ok"] == 1


def test_logging_never_raises_when_the_server_is_down(capsys):
    m = Monitor("http://127.0.0.1:9", project="x")
    m.start()
    assert m.run_id is None
    m.log(0, {"x": 1})
    m.activity("a")
    m.finish()
    err = capsys.readouterr().err
    assert err.count("can't reach") == 1 and "logging is off" in err


def test_a_server_that_goes_away_is_reported_once(server: Server, capsys):
    m = started(server)
    m.url = "http://127.0.0.1:9"
    for step in range(3):
        m.log(step, {"x": step, "a": Arrays(x=np.zeros(1))})
    m.flush()
    m.url = server.url
    m.log(3, {"x": 3})
    m.finish()
    err = capsys.readouterr().err
    assert err.count("can't reach") == 1 and "reconnected" in err
    assert [r["step"] for r in server.get(f"/api/runs/{m.run_id}/metrics")["rows"]] == [
        3
    ]


def test_rejections_are_reported_once_per_reason(server: Server, capsys):
    m = started(server)
    m.log(0, {"a": Data(1, type="Not A Type")})
    m.log(1, {"a": Data(1, type="Not A Type")})
    m.finish()
    assert capsys.readouterr().err.count("rejected") == 1


def test_heartbeat_keeps_the_run_fresh(server: Server):
    m = started(server, heartbeat=0.05)
    m.activity("waiting")
    m.flush()
    first = server.get(f"/api/runs/{m.run_id}")
    time.sleep(0.4)
    later = server.get(f"/api/runs/{m.run_id}")
    assert later["updated"] > first["updated"]
    assert later["activity"] == "waiting"
    assert later["activity_since"] == first["activity_since"]
    m.finish()
    assert server.get(f"/api/runs/{m.run_id}")["activity"] is None


def test_context_manager_records_how_the_run_ended(server: Server):
    with pytest.raises(ZeroDivisionError), Monitor(server.url) as m:
        m.start()
        m.log(0, {"x": 1})
        _ = 1 / 0
    meta = server.get(f"/api/runs/{m.run_id}")
    assert meta["status"] == "crashed" and meta["step"] == 0
    with Monitor(server.url) as m2:
        m2.start()
    assert server.get(f"/api/runs/{m2.run_id}")["status"] == "finished"


def test_start_again_continues_the_run(server: Server):
    m = started(server)
    run = m.run_id
    m.finish()
    m.start()
    m.log(5, {"x": 1})
    m.flush()
    assert m.run_id == run
    assert server.get(f"/api/runs/{run}")["status"] == "running"
    m.finish()


def test_helpers():
    assert to_number(np.int64(3)) == 3.0
    assert to_number(np.array([1, 2])) is None
    assert to_number(np.array("x")) is None
    assert to_number("1") is None
    assert _safe("loss/policy eval") == "loss_policy_eval"
    assert _safe("..") == "media" or _safe("..") == "_"
    with pytest.raises(ValueError):
        File(b"", "png")
    assert Arrays(x=np.array([2**40], np.int64)).encode()[:2] == b"PK"
    loaded = np.load(io.BytesIO(Arrays(x=np.array([2**40], np.int64)).encode()))
    assert loaded["x"].dtype == np.int64


def test_arrays_keep_their_shapes():
    a = Arrays(
        agent=np.int32(1),
        done=np.bool_(True),
        f=np.float32(0.5),
        n=3,
        big=np.int64(2**40),
        v=np.arange(3),
        m=np.ones((2, 3), ">f4").T,
    )
    with np.load(io.BytesIO(a.encode())) as z:
        got = {k: z[k] for k in z.files}
    assert {k: v.shape for k, v in got.items()} == {
        "agent": (),
        "done": (),
        "f": (),
        "n": (),
        "big": (),
        "v": (3,),
        "m": (3, 2),
    }
    assert {k: v.dtype.str for k, v in got.items()} == {
        "agent": "<i4",
        "done": "|b1",
        "f": "<f4",
        "n": "<i4",
        "big": "<i8",
        "v": "<i4",
        "m": "<f4",
    }
    assert got["agent"].item() == 1 and got["done"].item() is True
    assert got["n"].item() == 3 and got["big"].item() == 2**40
    assert not np.isfortran(got["m"]) and (got["m"] == 1).all()
