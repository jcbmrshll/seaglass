import { test } from "node:test";
import assert from "node:assert/strict";
import { activity, ago, duration, fmt, fmtTick, progress, status, withUnit } from "../../seaglass/static/format.js";
import { formatArray } from "../../seaglass/static/generic.js";

test("numbers", () => {
  assert.equal(fmt(null), "–");
  assert.equal(fmt(NaN), "–");
  assert.equal(fmt(3), "3");
  assert.equal(fmt(0.123456), "0.123");
  assert.equal(fmt(12.345), "12.35");
  assert.equal(fmt(123.45), "123.5");
  assert.equal(fmt(12345), "12.3K");
  assert.equal(fmtTick(0.30000000000000004), "0.3");
});

test("times and statuses", () => {
  assert.equal(ago(100, 130), "30s ago");
  assert.equal(ago(0, 7200), "2h ago");
  assert.equal(duration(59), "59s");
  assert.equal(duration(125), "2m 5s");
  assert.equal(duration(3 * 86400 + 7200), "3d 2h");
  const run = { status: "running", updated: 1000, activity: "eval", activity_since: 990, step: 4, total: 10 };
  assert.equal(status(run, 1100), "running");
  assert.equal(status(run, 1200), "stale");
  assert.equal(status({ ...run, status: "finished" }, 9999), "finished");
  assert.equal(activity(run, 1000), "eval · 10s");
  assert.equal(activity({ ...run, status: "finished" }, 1000), "");
  assert.equal(progress(run), "4 / 10");
  assert.equal(progress({ ...run, total: null }), "step 4");
  assert.equal(progress({ ...run, step: null }), "");
});

test("array previews", () => {
  assert.equal(formatArray({ shape: [], data: [2.5] }), "2.5");
  assert.equal(formatArray({ shape: [2, 2], data: Int32Array.from([1, 2, 3, 4]) }), "[[1, 2],\n [3, 4]]");
  assert.equal(formatArray({ shape: [3], data: BigInt64Array.from([1n, 2n, 3n]) }), "[1, 2, 3]");
  assert.equal(formatArray({ shape: [5], data: Float32Array.from([1, 2, 3, 4, 5]) }, 2), "[1, 2, …]");
});

test("units", () => {
  assert.equal(withUnit("0.41", "nats"), "0.41 nats");
  assert.equal(withUnit("12", "%"), "12%");
  assert.equal(withUnit("0.41", null), "0.41");
  // no value, no unit
  assert.equal(withUnit("–", "s"), "–");
});
