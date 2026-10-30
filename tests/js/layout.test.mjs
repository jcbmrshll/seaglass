import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyNavigate, bestValue, chartLog, chartNotes, clip, declared, declaredList, describe, entriesByKey, entryIndexAt, globCapture, globRegex, headlines,
  locationQuery, logTicks, matchNames, mediaColumns, metricNames, niceTicks, parseLocation, rangedSeries, resolveLayout, seriesPoints, smooth, splitGroups,
  stepOf, stepRange, tileNames, valueAt,
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

test("pattern captures", () => {
  assert.equal(globCapture("*_avg_outcome", "random_avg_outcome"), "random");
  assert.equal(globCapture("*_avg_outcome", "loss"), null);
  // the first * takes as much as it can
  assert.equal(globCapture("*_*", "a_b_c"), "a_b");
  assert.equal(globCapture("eval/?/*", "eval/x/return"), "return");
  // no *, or an empty match: the whole name
  assert.equal(globCapture("loss", "loss"), "loss");
  assert.equal(globCapture("*avg_outcome", "avg_outcome"), "avg_outcome");
  assert.equal(globCapture("a.b*", "axbc"), null);
});

test("named split groups", () => {
  const names = ["loss", "random_avg_outcome", "loss/policy", "greedy_avg_outcome", "mean_return", "max_return", "lr", "best"];
  const groups = splitGroups(names, { avg_outcome: "*_avg_outcome", other: ["lr", "*_avg_outcome"] });
  // a group lands where its first metric does; the rest fall through to the usual rules
  assert.deepEqual(groups.map((g) => g.name), ["loss", "avg_outcome", "return", "other", "best"]);
  // series named by what * matched, in the order matched; the first listed group wins
  assert.deepEqual(groups[1].series, [{ name: "random", key: "random_avg_outcome" }, { name: "greedy", key: "greedy_avg_outcome" }]);
  // a pattern with no *: the whole name
  assert.deepEqual(groups[3].series, [{ name: "lr", key: "lr" }]);
  assert.deepEqual(groups[0].series.map((s) => s.name), ["loss", "policy"]);
  // the panel's own pattern order decides where the group goes
  const first = splitGroups(matchNames(["*_avg_outcome", "*"], names), { avg_outcome: "*_avg_outcome" });
  assert.deepEqual(first.map((g) => g.name), ["avg_outcome", "loss", "return", "lr", "best"]);
  // groups that aren't an object, and patterns that aren't strings, are ignored
  assert.deepEqual(splitGroups(["a_x"], ["*_x"]), [{ name: "a_x", series: [{ name: "a_x", key: "a_x" }] }]);
  assert.deepEqual(splitGroups(["a_x"], { g: [1, null] }), [{ name: "a_x", series: [{ name: "a_x", key: "a_x" }] }]);
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

test("step ranges", () => {
  const pts = [[0, 1], [5, 2], [10, 3], [15, 4]];
  assert.equal(clip(pts), pts);
  assert.deepEqual(clip(pts, 5, 10), [[5, 2], [10, 3]]);
  assert.deepEqual(clip(pts, null, 5), [[0, 1], [5, 2]]);
  assert.deepEqual(clip(pts, 11), [[15, 4]]);
  assert.equal(stepOf("12"), 12);
  assert.equal(stepOf(" -3 "), -3);
  assert.equal(stepOf(""), null);
  assert.equal(stepOf("1.5"), null);
  assert.equal(stepOf(null), null);
  assert.equal(stepRange(null, null), null);
  assert.deepEqual(stepRange(9, 2), [2, 9]);
  assert.deepEqual(stepRange(null, 4), [null, 4]);
});

test("a ranged series is smoothed before it's cut", () => {
  const pts = [[0, 0], [1, 10], [2, 20], [3, 30]];
  assert.deepEqual(rangedSeries(pts, 0), { points: pts, raw: null });
  assert.deepEqual(rangedSeries(pts, 0, 2), { points: [[2, 20], [3, 30]], raw: null });
  // step 2's average is over steps 1 and 2, though step 1 is cut
  assert.deepEqual(rangedSeries(pts, 2, 2), { points: [[2, 15], [3, 25]], raw: [[2, 20], [3, 30]] });
  assert.deepEqual(rangedSeries(pts, 2, 5, 9), { points: [], raw: [] });
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
  // replace is about history, not part of the location
  assert.deepEqual(applyNavigate(loc, { state: { genome: "13" }, replace: true }), { ...loc, state: { ...loc.state, genome: "13" } });
});

test("layouts", () => {
  const none = resolveLayout(null);
  assert.equal(none.usable, false);
  assert.equal(none.tabs[0].rows.length, 4);
  const future = resolveLayout({ contract: 2, tabs: [{ title: "x", rows: [] }] });
  assert.equal(future.usable, false);
  assert.match(future.note, /contract 2/);
  const noTabs = resolveLayout({ contract: 1, renderers: { "a/b": "r.js" } });
  assert.equal(noTabs.usable, true);
  assert.deepEqual(noTabs.renderers, { "a/b": "r.js" });
  // the default layout, its tiles the run's headline metrics
  assert.deepEqual(noTabs.tabs[0].rows[0], [{ type: "tiles" }]);
  const own = resolveLayout({ contract: 1, tabs: [{ title: "T", panel: { type: "view", module: "v.js" } }] });
  assert.equal(own.tabs[0].panel.module, "v.js");
});

test("media columns", () => {
  assert.equal(mediaColumns({ type: "media", keys: ["*"] }), null);
  assert.equal(mediaColumns({ columns: 1 }), 1);
  assert.equal(mediaColumns({ columns: 3 }), 3);
  // anything but an integer >= 1 is the frontend's choice
  for (const columns of [0, -2, 1.5, "2", null, true, NaN, Infinity]) assert.equal(mediaColumns({ columns }), null);
  assert.equal(mediaColumns(undefined), null);
});

test("declarations", () => {
  const list = declaredList({
    "loss/*": { description: "per-head loss", log: true },
    loss: { description: "the total", unit: "nats", better: "lower", headline: true },
    "*_return": { description: "a return", better: "higher", headline: true },
    lr: 3,
    blank: { description: " ", unit: 4, better: "up" },
    "*": { description: "anything", log: false },
  });
  // in the order declared; a declaration that isn't an object declares nothing
  assert.deepEqual(list.map(([p]) => p), ["loss/*", "loss", "*_return", "blank", "*"]);
  for (const bad of [null, "x", ["a"], 3]) assert.deepEqual(declaredList(bad), []);
  // each field from the first declaration that matches and has it
  assert.equal(describe(list, "loss/policy"), "per-head loss");
  assert.equal(describe(list, "loss"), "the total");
  assert.equal(describe(list, "lr"), "anything");
  assert.equal(declared(list, "loss/policy", "log"), true);
  assert.equal(declared(list, "loss", "log"), false);
  assert.equal(declared(list, "loss/policy", "unit"), null);
  // a field of the wrong type, or blank, or a better that's neither, isn't there
  assert.equal(describe(list, "blank"), "anything");
  assert.equal(declared(list, "blank", "unit"), null);
  assert.equal(declared(list, "blank", "better"), null);
  assert.equal(describe([], "loss"), null);
  assert.equal(describe(declaredList({ "loss/*": { description: "x" } }), "loss"), null);
  // lists join, the first to win: a project's runs, newest first
  const newer = declaredList({ loss: { description: "renamed" } });
  assert.equal(describe([...newer, ...list], "loss"), "renamed");
  assert.equal(declared([...newer, ...list], "loss", "unit"), "nats");
});

test("headlines and tiles", () => {
  const list = declaredList({ min_return: { headline: false }, "*_return": { headline: true }, loss: { headline: true }, lr: {} });
  const names = ["lr", "loss", "max_return", "min_return", "mean_return"];
  // in the order declared, then logged; one declared not a headline first isn't
  assert.deepEqual(headlines(list, names), ["max_return", "mean_return", "loss"]);
  // a later declaration doesn't undo an earlier one
  assert.deepEqual(headlines(declaredList({ "*_return": { headline: true }, min_return: { headline: false } }), names), ["max_return", "min_return", "mean_return"]);
  assert.deepEqual(headlines([], names), []);
  // tiles: the panel's own, else the headlines, else the first six logged
  assert.deepEqual(tileNames({ type: "tiles", metrics: ["lr"] }, list, names), ["lr"]);
  assert.deepEqual(tileNames({ type: "tiles" }, list, names), ["max_return", "mean_return", "loss"]);
  const many = ["a", "b", "c", "d", "e", "f", "g"];
  assert.deepEqual(tileNames({ type: "tiles" }, [], many), many.slice(0, 6));
});

test("log axes", () => {
  const list = declaredList({ "loss/*": { log: true }, lr: { log: true } });
  // as the panel says, else when everything charted is declared log
  assert.equal(chartLog({}, list, ["loss/a", "loss/b"]), true);
  assert.equal(chartLog({}, list, ["loss/a", "acc"]), false);
  assert.equal(chartLog({ log: false }, list, ["lr"]), false);
  assert.equal(chartLog({ log: true }, [], ["acc"]), true);
  assert.equal(chartLog(null, list, []), false);
});

test("the best value", () => {
  const list = declaredList({ loss: { better: "lower" }, "*_return": { better: "higher" } });
  assert.equal(bestValue(list, "loss", [0.3, null, 0.1, undefined, 0.2]), 0.1);
  assert.equal(bestValue(list, "mean_return", [1, 3, 2]), 3);
  assert.equal(bestValue(list, "acc", [1, 3, 2]), null);
  assert.equal(bestValue(list, "loss", [null]), null);
});

test("a chart's notes", () => {
  const texts = { loss: "the TD loss, by head", "loss/policy": "the policy head's", "*_return": "return per episode", lr: "the learning rate" };
  const list = declaredList(Object.fromEntries(Object.entries(texts).map(([p, description]) => [p, { description }])));
  const one = (key) => ({ name: key, series: [{ name: key, key }] });
  // one metric: its description, about the whole card
  assert.deepEqual(chartNotes(list, one("lr")), [{ names: [], text: "the learning rate" }]);
  assert.deepEqual(chartNotes(list, one("epsilon")), []);
  // a group: its name's description, then its series'
  const loss = { name: "loss", series: [{ name: "policy", key: "loss/policy" }, { name: "value", key: "loss/value" }] };
  assert.deepEqual(chartNotes(list, loss), [{ names: [], text: "the TD loss, by head" }, { names: ["policy"], text: "the policy head's" }]);
  // series that share a description are listed together, and when they all do, it's the card's
  const ret = { name: "return", series: ["max", "mean", "min"].map((s) => ({ name: s, key: `${s}_return` })) };
  assert.deepEqual(chartNotes(list, ret), [{ names: [], text: "return per episode" }]);
  const some = { name: "", series: [{ name: "a_return", key: "a_return" }, { name: "lr", key: "lr" }, { name: "b_return", key: "b_return" }] };
  assert.deepEqual(chartNotes(list, some), [{ names: ["a_return", "b_return"], text: "return per episode" }, { names: ["lr"], text: "the learning rate" }]);
  // a series named like the card isn't described twice
  const mixed = { name: "loss", series: [{ name: "loss", key: "loss" }, { name: "policy", key: "loss/policy" }] };
  assert.deepEqual(chartNotes(list, mixed), [{ names: ["loss"], text: "the TD loss, by head" }, { names: ["policy"], text: "the policy head's" }]);
});
