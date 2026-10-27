import sys
from pathlib import Path

import numpy as np

from .conftest import Server

EXAMPLE = Path(__file__).parents[1] / "examples" / "gridworld"


def test_gridworld_logs_a_run_with_its_views(server: Server, monkeypatch, capsys):
    sys.path.insert(0, str(EXAMPLE))
    try:
        import train  # pyright: ignore[reportMissingImports]
    finally:
        sys.path.remove(str(EXAMPLE))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "train.py",
            "--url",
            server.url,
            "--epochs",
            "12",
            "--episodes",
            "4",
            "--delay",
            "0",
        ],
    )
    train.main()
    (run,) = server.get("/api/runs")
    assert run["project"] == "gridworld" and run["status"] == "finished"
    assert run["step"] == 11 and run["total"] == 11
    assert {"mean_return", "success", "td_error"} <= set(run["latest"])
    # the run says what it logs: every metric and media key it logged is described
    declared = run["declared"]
    assert declared["success"]["headline"] and declared["td_error"]["log"]
    assert "within 60 steps" in declared["success"]["description"]
    err = capsys.readouterr().err
    assert "without a description" not in err and "never logged" not in err
    bundle = server.get(f"/api/bundles/{run['bundle']}")
    assert {f["path"] for f in bundle["files"]} >= {
        "layout.json",
        "episode.js",
        "values.js",
        "grid.js",
        "dom.js",
        "style.css",
    }
    media = server.get(f"/api/runs/{run['id']}/media")["rows"]
    episodes = [e for e in media if e["type"] == "gridworld/episode"]
    assert [e["step"] for e in episodes] == [0, 10, 11]
    arrays = np.load(server.root / run["id"] / "files" / episodes[0]["file"])
    assert arrays["walls"].dtype == np.bool_ and arrays["path"].shape[1] == 2
    assert arrays["rewards"].shape[0] == arrays["path"].shape[0] - 1
