import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SLOTS, assignSlots, compareValues, configColumns, configText, flattenConfig, parseSort, runMatches, sortBy,
} from "../../seaglass/static/compare.js";

test("configs flatten to one level", () => {
  assert.deepEqual(flattenConfig({ lr: 1, opt: { name: "adam", betas: [0.9, 0.99] }, empty: {} }), {
    lr: 1, "opt.name": "adam", "opt.betas": [0.9, 0.99], empty: {},
  });
  assert.deepEqual(flattenConfig(undefined), {});
});

test("config columns are the keys that differ", () => {
  const a = { lr: 1, seed: 0, env: "grid" };
  const b = { lr: 2, seed: 0, env: "grid", extra: true };
  assert.deepEqual(configColumns([a, b]), ["lr", "extra"]);
  assert.deepEqual(configColumns([a]), ["lr", "seed", "env"]);
  assert.deepEqual(configColumns([]), []);
  assert.deepEqual(configColumns([{ x: [1, 2] }, { x: [1, 2] }]), []);
  assert.equal(configText([1, 2]), "1, 2");
  assert.equal(configText(null), "–");
  assert.equal(configText({ a: 1 }), '{"a":1}');
});

test("sorting puts missing values last", () => {
  assert.deepEqual(parseSort("-loss"), { key: "loss", desc: true });
  assert.deepEqual(parseSort("name"), { key: "name", desc: false });
  assert.deepEqual(parseSort(null), { key: "created", desc: true });
  const xs = [3, null, "b", 1, NaN, "a10", "a9"];
  assert.deepEqual(sortBy(xs, (x) => x), [1, 3, "a9", "a10", "b", null, NaN]);
  assert.deepEqual(sortBy(xs, (x) => x, true).slice(0, 5), ["b", "a10", "a9", 3, 1]);
  assert.ok(compareValues(null, 1, true) > 0);
});

test("colour slots follow the run", () => {
  let slots = assignSlots(new Map(), ["a", "b", "c"]);
  assert.deepEqual([...slots], [["a", 0], ["b", 1], ["c", 2]]);
  // hiding b frees its slot without repainting c; a new run takes it
  slots = assignSlots(slots, ["a", "c", "d"]);
  assert.deepEqual([...slots], [["a", 0], ["c", 2], ["d", 1]]);
  // past the slots there are, they repeat
  const many = assignSlots(new Map(), Array.from({ length: SLOTS + 2 }, (_, i) => `r${i}`));
  assert.equal(new Set(many.values()).size, SLOTS);
});

test("runs match a filter on name, id, tags, notes and conclusions", () => {
  const run = { name: "amber-heron-3", id: "20260101-000000-abcd", tags: ["baseline-v2"], notes: "Does warmup help?" };
  assert.ok(runMatches(run, ""));
  assert.ok(runMatches(run, "heron baseline"));
  assert.ok(runMatches(run, "ABCD"));
  assert.ok(!runMatches(run, "heron baseline-v3"));
  assert.ok(runMatches(run, "warmup heron"));
  assert.ok(runMatches({ ...run, notes: null }, "heron"));
  assert.ok(runMatches({ ...run, conclusions: "It plateaus at 0.3" }, "plateaus warmup"));
  assert.ok(!runMatches({ ...run, conclusions: null }, "plateaus"));
});
