import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyNavigate, entriesByKey, entryIndexAt, globRegex, locationQuery, logTicks, matchNames,
  metricNames, niceTicks, parseLocation, resolveLayout, seriesPoints, smooth, splitGroups, valueAt,
} from "../../seaglass/static/layout.js";

test("patterns", () => {
  assert.ok(globRegex("loss/*").test("loss/policy/x"));
  assert.ok(globRegex("a?c").test("abc"));
  assert.ok(!globRegex("a?c").test("ac"));
  assert.ok(globRegex("a.b").test("a.b") && !globRegex("a.b").test("axb"));
  assert.ok(globRegex("(x)+[y]").test("(x)+[y]"));
  const names = ["loss", "acc", "loss/value", "lr"];
  // pattern order, then first logged; each once
  assert.deepEqual(matchNames(["l*", "acc", "loss"], names), ["loss", "loss/value", "lr", "acc"]);
  assert.deepEqual(matchNames(["*"], names), names);
  assert.deepEqual(matchNames(undefined, names), []);
});

test("split groups", () => {
  const groups = splitGroups(["loss/policy", "mean_return", "lr", "loss/value", "min_return", "max_return", "max_only", "a/b/c"]);
  assert.deepEqual(groups.map((g) => g.name), ["loss", "return", "lr", "max_only", "a/b"]);
  assert.deepEqual(groups[1].series.map((s) => s.name), ["max", "mean", "min"]);
  assert.deepEqual(groups[0].series.map((s) => s.key), ["loss/policy", "loss/value"]);
  assert.deepEqual(groups[4].series, [{ name: "c", key: "a/b/c" }]);
});

test("metrics as of a step", () => {
  const rows = [
    { step: 0, time: 1, loss: 3 },
    { step: 1, time: 2, loss: null, acc: 0.1 },
    { step: 2, time: 3, loss: 1 },
    { step: 1, time: 4, loss: 2 },
  ];
  assert.deepEqual(metricNames(rows), ["loss", "acc"]);
  assert.equal(valueAt(rows, "loss"), 1);
  assert.equal(valueAt(rows, "loss", 1), 2);
  assert.equal(valueAt(rows, "loss", 0), 3);
  assert.equal(valueAt(rows, "acc", 0), null);
  assert.deepEqual(seriesPoints(rows, "loss", 1), [[1, null], [1, 2], [2, 1]]);
});

test("smoothing keeps gaps", () => {
  const pts = [[0, 1], [1, 3], [2, null], [3, 5], [4, 7]];
  assert.equal(smooth(pts, 0), pts);
  assert.deepEqual(smooth(pts, 2), [[0, 1], [1, 2], [2, null], [3, 4], [4, 6]]);
});

test("ticks", () => {
  assert.deepEqual(niceTicks(0, 1, 4), [0, 0.25, 0.5, 0.75, 1]);
  const t = niceTicks(3, 3, 3);
  assert.ok(t[0] < 3 && t.at(-1) > 3);
  assert.deepEqual(logTicks(2, 30), [1, 10, 100]);
  assert.deepEqual(logTicks(2, 8), [1, 2, 5, 10]);
  const wide = logTicks(1e-6, 1e6);
  assert.ok(wide[0] <= 1e-6 && wide.at(-1) >= 1e6 && wide.length <= 7);
});

test("media entries by key and step", () => {
  const entries = [
    { key: "a", step: 5, file: "1" },
    { key: "b", step: 0, file: "2" },
    { key: "a", step: 1, file: "3" },
    { key: "a", step: 9, file: "4" },
  ];
  const byKey = entriesByKey(entries);
  assert.deepEqual([...byKey.keys()], ["a", "b"]);
  const a = byKey.get("a");
  assert.deepEqual(a.map((e) => e.step), [1, 5, 9]);
  assert.equal(entryIndexAt(a, null), 2);
  assert.equal(entryIndexAt(a, 6), 1);
  assert.equal(entryIndexAt(a, 0), 0);
  assert.equal(entryIndexAt([], 3), -1);
});

test("location in the address", () => {
  const loc = parseLocation("?tab=Values&step=40&genome=12&x=a%20b");
  assert.deepEqual(loc, { tab: "Values", step: 40, state: { genome: "12", x: "a b" } });
  assert.deepEqual(parseLocation("?step=abc"), { tab: null, step: null, state: {} });
  assert.equal(locationQuery(loc), "?tab=Values&step=40&genome=12&x=a+b");
  assert.equal(locationQuery({ tab: null, step: null, state: {} }), "");
  const next = applyNavigate(loc, { step: null, state: { genome: null, y: 3 } });
  assert.deepEqual(next, { tab: "Values", step: null, state: { x: "a b", y: "3" } });
  assert.deepEqual(applyNavigate(loc, {}), loc);
  assert.equal(applyNavigate(loc, { tab: null }).tab, null);
});

test("layouts", () => {
  const none = resolveLayout(null);
  assert.equal(none.usable, false);
  assert.equal(none.tabs[0].rows.length, 4);
  const future = resolveLayout({ contract: 2, tabs: [{ title: "x", rows: [] }] });
  assert.equal(future.usable, false);
  assert.match(future.note, /contract 2/);
  const noTabs = resolveLayout({ contract: 1, renderers: { "a/b": "r.js" }, summary: ["loss"] });
  assert.equal(noTabs.usable, true);
  assert.deepEqual(noTabs.renderers, { "a/b": "r.js" });
  // the default layout, its tiles showing the summary
  assert.deepEqual(noTabs.tabs[0].rows[0], [{ type: "tiles" }]);
  const own = resolveLayout({ contract: 1, tabs: [{ title: "T", panel: { type: "view", module: "v.js" } }] });
  assert.equal(own.tabs[0].panel.module, "v.js");
});
