import json
import threading
from http import HTTPStatus

import pytest

from seaglass.cli import main
from seaglass.conformance import load_cases, match, run_case, run_suite, substitute
from seaglass.server import Handler, make_server

from .conftest import Server

CASES = load_cases()


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_python_server_passes(server: Server, case):
    assert run_case(server.url, case) == []


def test_suite_twice_against_one_server(server: Server, capsys):
    # the cases only add runs, so they can run against a server that has others
    assert run_suite(server.url)
    assert run_suite(server.url)
    assert main(["conformance", server.url, "-k", "metrics"]) == 0
    assert "of 3 cases passed" in capsys.readouterr().out.splitlines()[-1]


def test_a_broken_server_fails(tmp_path, capsys):
    class Broken(Handler):
        # forgets that a finished run that logs is running again
        def _post(self):
            if self.path.endswith("/metrics"):
                parts = self.path.split("/")
                self.store.log_metrics(parts[3], self._body_json())
                self.store.finish(parts[3], {"status": "finished"})
                self._json({"ok": True})
            else:
                super()._post()

    srv = make_server("127.0.0.1", 0, tmp_path)
    store = srv.RequestHandlerClass.store  # pyright: ignore[reportFunctionMemberAccess]
    srv.RequestHandlerClass = type("B", (Broken,), {"store": store})
    threading.Thread(target=srv.serve_forever, args=(0.05,), daemon=True).start()
    try:
        assert not run_suite(f"http://127.0.0.1:{srv.server_address[1]}")
        out = capsys.readouterr().out
        assert "FAIL" in out and "running" in out
    finally:
        srv.shutdown()
        srv.server_close()


def test_matcher():
    vars = {"id": "x", "t0": 5}
    assert match({"a": 1}, {"a": 1, "b": 2}, vars) == []
    assert match({"$exact": {"a": 1}}, {"a": 1, "b": 2}, vars)
    assert match({"$exact": {"a": {"b": 1}}}, {"a": {"b": 1, "c": 2}}, vars)
    assert match([1, 2], [1, 2, 3], vars)
    assert match(1, True, vars) and match(True, 1, vars)
    assert match({"$type": "integer"}, 1.5, vars)
    assert match({"$type": "number"}, True, vars)
    assert match({"$regex": "^a"}, "abc", vars) == []
    assert match({"$var": "id"}, "x", vars) == [] and match({"$var": "id"}, "y", vars)
    assert match({"$gte": "t0"}, 5, vars) == [] and match({"$gte": "t0"}, 4, vars)
    assert match({"k": {"$absent": True}}, {"k": None}, vars)
    assert match({"k": {"$absent": True}}, {}, vars) == []
    assert match({"$contains": [{"id": 2}]}, [{"id": 1}, {"id": 2}], vars) == []
    assert match({"$contains": [{"id": 3}]}, [{"id": 1}], vars)
    assert (
        match({"$capture": "got", "$type": "string"}, "v", vars) == []
        and vars["got"] == "v"
    )
    # a failed condition captures nothing
    assert match({"$capture": "no", "$type": "string"}, 1, vars) and "no" not in vars


def test_substitute():
    vars = {"run": "r1", "files": {"a": "b"}}
    assert substitute("/api/runs/{{run}}/x", vars) == "/api/runs/r1/x"
    assert substitute({"f": "{{files}}", "l": ["{{run}}-{{run}}"]}, vars) == {
        "f": {"a": "b"},
        "l": ["r1-r1"],
    }


def test_cases_are_well_formed():
    names = [c["name"] for c in CASES]
    assert len(names) == len(set(names))
    for case in CASES:
        for step in case["steps"]:
            assert set(step) <= {"request", "response"}
            assert step["request"]["method"] in ("GET", "POST", "PUT")
            assert isinstance(step["response"]["status"], (int, list))
            assert (
                HTTPStatus(step["response"]["status"])
                if isinstance(step["response"]["status"], int)
                else True
            )
    json.dumps(CASES)
