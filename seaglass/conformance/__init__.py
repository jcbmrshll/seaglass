"""The conformance suite (SPEC.md §9): request/response cases, run against any server.

    seaglass conformance http://localhost:8008

Each case in cases/*.json is a list of exchanges. Values a server picks (ids, names,
times) are matched by kind, and captured to use in later requests.
"""

import base64
import http.client
import json
import re
import secrets
from dataclasses import dataclass, field
from importlib import resources
from typing import Any
from urllib.parse import urlparse

from seaglass.bundle import bundle_hash

TYPES = {
    "string": lambda v: isinstance(v, str),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
}
VAR = re.compile(r"\{\{([A-Za-z0-9_.]+)\}\}")


def load_cases() -> list[dict[str, Any]]:
    """Every case, in file order."""
    cases = []
    for path in sorted(
        resources.files(__package__).joinpath("cases").iterdir(), key=lambda p: p.name
    ):
        if path.name.endswith(".json"):
            for case in json.loads(path.read_text()):
                cases.append({**case, "file": path.name})
    return cases


# ---------------------------------------------------------------- matching


def _short(v: Any) -> str:
    text = json.dumps(v)
    return text if len(text) <= 80 else text[:77] + "..."


def _is_matcher(v: Any) -> bool:
    return isinstance(v, dict) and bool(v) and all(k.startswith("$") for k in v)


def match(
    expected: Any, actual: Any, vars: dict[str, Any], where: str = "$", exact=False
) -> list[str]:
    """Why `actual` doesn't match `expected` (SPEC.md §9), or [] if it does. Captures
    go into `vars`."""
    if _is_matcher(expected):
        return _matcher(expected, actual, vars, where, exact)
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return [f"{where}: expected an object, got {_short(actual)}"]
        errors = []
        for k, v in expected.items():
            if _is_matcher(v) and v.get("$absent"):
                if k in actual:
                    errors.append(f"{where}.{k}: should be absent")
                continue
            if k not in actual:
                errors.append(f"{where}.{k}: missing")
                continue
            errors += match(v, actual[k], vars, f"{where}.{k}", exact)
        if exact:
            extra = sorted(set(actual) - set(expected))
            if extra:
                errors.append(f"{where}: unexpected keys {extra}")
        return errors
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            return [f"{where}: expected {_short(expected)}, got {_short(actual)}"]
        return [
            e
            for i, (x, y) in enumerate(zip(expected, actual))
            for e in match(x, y, vars, f"{where}[{i}]", exact)
        ]
    if isinstance(expected, bool) != isinstance(actual, bool) or expected != actual:
        return [f"{where}: expected {_short(expected)}, got {_short(actual)}"]
    return []


def _matcher(
    m: dict[str, Any], actual: Any, vars: dict[str, Any], where: str, exact: bool
) -> list[str]:
    errors = []
    if "$type" in m and not TYPES[m["$type"]](actual):
        errors.append(f"{where}: expected a {m['$type']}, got {_short(actual)}")
    if "$regex" in m and not (
        isinstance(actual, str) and re.search(m["$regex"], actual)
    ):
        errors.append(f"{where}: {_short(actual)} doesn't match /{m['$regex']}/")
    if "$var" in m:
        want = vars.get(m["$var"])
        if want != actual:
            errors.append(f"{where}: expected {_short(want)}, got {_short(actual)}")
    if "$gte" in m:
        bound = vars.get(m["$gte"]) if isinstance(m["$gte"], str) else m["$gte"]
        number = TYPES["number"]
        if not (number(actual) and number(bound) and float(actual) >= float(bound)):  # type: ignore[arg-type]
            errors.append(
                f"{where}: expected a number >= {bound}, got {_short(actual)}"
            )
    if "$exact" in m:
        errors += match(m["$exact"], actual, vars, where, exact=True)
    if "$contains" in m:
        if not isinstance(actual, list):
            errors.append(f"{where}: expected an array, got {_short(actual)}")
        else:
            for want in m["$contains"]:
                # captures only count from the element that matched
                for a in actual:
                    trial = dict(vars)
                    if not match(want, a, trial, where, exact):
                        vars.update(trial)
                        break
                else:
                    errors.append(f"{where}: no element matches {_short(want)}")
    if "$capture" in m and not errors:
        vars[m["$capture"]] = actual
    return errors


# ---------------------------------------------------------------- requests


def substitute(value: Any, vars: dict[str, Any]) -> Any:
    """`value` with {{name}} replaced by captured values: a string that is just
    {{name}} becomes the value itself, and anywhere else it's spliced in as text."""
    if isinstance(value, str):
        whole = VAR.fullmatch(value)
        if whole:
            return vars[whole.group(1)]
        return VAR.sub(lambda m: str(vars[m.group(1)]), value)
    if isinstance(value, dict):
        return {k: substitute(v, vars) for k, v in value.items()}
    if isinstance(value, list):
        return [substitute(v, vars) for v in value]
    return value


@dataclass
class Response:
    status: int
    headers: dict[str, str]
    body: bytes = field(repr=False)


def send(base: str, request: dict[str, Any], vars: dict[str, Any]) -> Response:
    url = urlparse(base)
    conn_cls = (
        http.client.HTTPSConnection
        if url.scheme == "https"
        else http.client.HTTPConnection
    )
    conn = conn_cls(url.netloc, timeout=30)
    headers = {
        k: str(substitute(v, vars)) for k, v in request.get("headers", {}).items()
    }
    body = None
    if "json" in request:
        body = json.dumps(substitute(request["json"], vars)).encode()
        headers.setdefault("Content-Type", "application/json")
    elif "text" in request:
        body = substitute(request["text"], vars).encode()
    elif "base64" in request:
        body = base64.b64decode(request["base64"])
    path = url.path.rstrip("/") + substitute(request["path"], vars)
    try:
        conn.request(request["method"], path, body=body, headers=headers)
        resp = conn.getresponse()
        return Response(
            resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read()
        )
    finally:
        conn.close()


def check(expected: dict[str, Any], resp: Response, vars: dict[str, Any]) -> list[str]:
    errors = []
    status = expected.get("status")
    allowed = status if isinstance(status, list) else [status]
    if status is not None and resp.status not in allowed:
        errors.append(f"status {resp.status}, expected {status}: {resp.body[:200]!r}")
        return errors
    for name, want in expected.get("headers", {}).items():
        got = resp.headers.get(name.lower())
        if got is None:
            errors.append(f"header {name}: missing")
        else:
            errors += match(want, got, vars, f"header {name}")
    if "json" in expected:
        try:
            body = json.loads(resp.body)
        except ValueError:
            return errors + [f"body isn't JSON: {resp.body[:200]!r}"]
        errors += match(substitute(expected["json"], vars), body, vars)
    if "text" in expected and resp.body.decode(errors="replace") != substitute(
        expected["text"], vars
    ):
        errors.append(f"body {resp.body[:200]!r}, expected {expected['text']!r}")
    if "base64" in expected and resp.body != base64.b64decode(expected["base64"]):
        errors.append("body differs from the expected bytes")
    return errors


def setup(case: dict[str, Any]) -> dict[str, Any]:
    """The variables a case starts with: a fresh {{nonce}}, and for each bundle in its
    setup, <name>.hash and <name>.files (base64), computed as SPEC.md §6.2 says."""
    vars: dict[str, Any] = {"nonce": secrets.token_hex(8)}
    for name, files in case.get("setup", {}).get("bundles", {}).items():
        data = {p: substitute(text, vars).encode() for p, text in files.items()}
        vars[f"{name}.hash"] = bundle_hash(data)
        vars[f"{name}.files"] = {
            p: base64.b64encode(b).decode() for p, b in data.items()
        }
    return vars


def run_case(base: str, case: dict[str, Any]) -> list[str]:
    """Why the case failed, or [] if it passed."""
    vars = setup(case)
    for i, step in enumerate(case["steps"]):
        req = step["request"]
        try:
            resp = send(base, req, vars)
        except (OSError, http.client.HTTPException) as e:
            return [f"step {i + 1} ({req['method']} {req['path']}): {e}"]
        errors = check(step["response"], resp, vars)
        if errors:
            return [
                f"step {i + 1} ({req['method']} {req['path']}): {e}" for e in errors
            ]
    return []


def run_suite(base: str, pattern: str | None = None, verbose: bool = False) -> bool:
    """Run every case (whose name contains `pattern`) against the server at `base`,
    printing what failed; whether everything passed."""
    cases = [c for c in load_cases() if not pattern or pattern in c["name"]]
    failed = 0
    for case in cases:
        errors = run_case(base, case)
        if errors:
            failed += 1
            print(f"FAIL {case['file']}: {case['name']}")
            for e in errors:
                print(f"     {e}")
        elif verbose:
            print(f"ok   {case['file']}: {case['name']}")
    print(f"{len(cases) - failed} of {len(cases)} cases passed")
    return failed == 0
