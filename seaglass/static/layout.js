// The layout schema (SPEC.md §8) and the logic the run page draws it with, kept free
// of the DOM so it can be tested without a browser.

export const CONTRACT = 1;
const DEFAULT_TILES = 6;

export const DEFAULT_TABS = [
  {
    title: "Run",
    rows: [
      [{ type: "tiles", metrics: ["*"], max: DEFAULT_TILES }],
      [{ type: "media", keys: ["*"] }],
      [{ type: "chart", metrics: ["*"], split: true }],
      [{ type: "config" }],
    ],
  },
];

// The layout to draw a run with: its bundle's, or the default (§8.5) when it has none,
// or one this frontend can't run. `note` says why the default is used, if it is.
export function resolveLayout(layout) {
  if (!layout) return { renderers: {}, summary: [], tabs: DEFAULT_TABS, usable: false, note: null };
  if (layout.contract !== CONTRACT) {
    return { renderers: {}, summary: [], tabs: DEFAULT_TABS, usable: false, note: `its views target contract ${layout.contract}, and this page runs contract ${CONTRACT}` };
  }
  const summary = Array.isArray(layout.summary) ? layout.summary : [];
  let tabs = Array.isArray(layout.tabs) && layout.tabs.length ? layout.tabs : null;
  if (!tabs) {
    // the default layout, its tiles showing the summary
    tabs = DEFAULT_TABS.map((t) => ({
      ...t,
      rows: t.rows.map((row) => row.map((p) => (p.type === "tiles" && summary.length ? { type: "tiles" } : p))),
    }));
  }
  return { renderers: layout.renderers ?? {}, summary, tabs, usable: true, note: null };
}

// ---------------------------------------------------------------- patterns

const regexCache = new Map();

// a pattern as a RegExp: * any run of characters, ? any one, anything else itself
export function globRegex(pattern) {
  let re = regexCache.get(pattern);
  if (!re) {
    const body = [...pattern].map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\/]/g, "\\$&"))).join("");
    re = new RegExp(`^${body}$`, "s");
    regexCache.set(pattern, re);
  }
  return re;
}

// the names (in the order first logged) matched by patterns: in pattern order, each
// name once
export function matchNames(patterns, names) {
  const out = [];
  const seen = new Set();
  for (const p of patterns ?? []) {
    const re = globRegex(p);
    for (const n of names) {
      if (!seen.has(n) && re.test(n)) {
        seen.add(n);
        out.push(n);
      }
    }
  }
  return out;
}

// metrics into charts for a split chart panel (§8.4): "a/b" keys under "a" as series
// "b"; min_X, mean_X and max_X (two or more of them) under X; the rest alone
export function splitGroups(names) {
  const groups = new Map();
  const add = (group, series, key) => {
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ name: series, key });
  };
  const set = new Set(names);
  for (const key of names) {
    const slash = key.lastIndexOf("/");
    const stat = key.match(/^(min|mean|max)_(.+)$/s);
    if (slash > 0) add(key.slice(0, slash), key.slice(slash + 1), key);
    else if (stat && ["min", "mean", "max"].filter((s) => set.has(`${s}_${stat[2]}`)).length > 1) add(stat[2], stat[1], key);
    else add(key, key, key);
  }
  const rank = { max: 0, mean: 1, min: 2 };
  return [...groups].map(([name, series]) => ({
    name,
    // max, mean, min first, then the rest as they came (sort is stable)
    series: series.sort((a, b) => (rank[a.name] ?? 3) - (rank[b.name] ?? 3)),
  }));
}

// ---------------------------------------------------------------- metrics

// every metric name, in the order first logged
export function metricNames(rows) {
  const names = [];
  const seen = new Set(["step", "time"]);
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        names.push(k);
      }
    }
  }
  return names;
}

// a metric's last non-null value at or before step (null: the latest)
export function valueAt(rows, key, step = null) {
  let best = null, bestStep = -Infinity;
  for (const r of rows) {
    const v = r[key];
    if (v == null || (step != null && r.step > step)) continue;
    // rows come in log order; a later row for the same step wins
    if (r.step >= bestStep) {
      best = v;
      bestStep = r.step;
    }
  }
  return best;
}

// [step, value] points of a metric, from step `from` on, in step order
export function seriesPoints(rows, key, from = -Infinity) {
  const pts = [];
  for (const r of rows) if (key in r && r.step >= from) pts.push([r.step, r[key]]);
  return pts.sort((a, b) => a[0] - b[0]);
}

// a trailing moving average over `window` points, skipping nulls (which stay gaps)
export function smooth(points, window) {
  if (!(window > 1)) return points;
  const out = [];
  const buf = [];
  let sum = 0;
  for (const [x, y] of points) {
    if (y == null || !Number.isFinite(y)) {
      out.push([x, null]);
      continue;
    }
    buf.push(y);
    sum += y;
    if (buf.length > window) sum -= buf.shift();
    out.push([x, sum / buf.length]);
  }
  return out;
}

// round ticks covering [lo, hi], about `count` of them
export function niceTicks(lo, hi, count) {
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.1 || 1;
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const start = Math.floor(lo / step) * step;
  // the last tick must reach hi, or the top of the data runs off the chart
  const ticks = [+start.toPrecision(12)];
  while (ticks[ticks.length - 1] < hi) ticks.push(+(start + ticks.length * step).toPrecision(12));
  return ticks;
}

// ticks for a log axis over positive [lo, hi]: 1-2-5 within one decade, else powers
// of ten (every few, for a wide range); the first at or below lo, the last at or above hi
export function logTicks(lo, hi) {
  const a = Math.floor(Math.log10(lo)), b = Math.ceil(Math.log10(hi));
  if (b - a <= 1) return [1, 2, 5, 10].map((m) => +(m * 10 ** a).toPrecision(12));
  const every = Math.ceil((b - a) / 5);
  const ticks = [];
  for (let e = a; ; e += every) {
    ticks.push(+(10 ** e).toPrecision(12));
    if (e >= b) return ticks;
  }
}

// ---------------------------------------------------------------- media

// the entries of each key, in step order, keys in the order first logged
export function entriesByKey(entries) {
  const byKey = new Map();
  for (const e of entries) {
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    byKey.get(e.key).push(e);
  }
  // stable: entries logged twice for a step stay in log order
  for (const list of byKey.values()) list.sort((a, b) => a.step - b.step);
  return byKey;
}

// the index of the entry shown as of step: the last at or before it, or the first
// if they all come after (null step: the latest)
export function entryIndexAt(entries, step) {
  if (!entries.length) return -1;
  if (step == null) return entries.length - 1;
  let idx = 0;
  for (let i = 0; i < entries.length; i++) if (entries[i].step <= step) idx = i;
  return idx;
}

// ---------------------------------------------------------------- location

// the location (§7.6) in a page's query: tab and step reserved, the rest view state
export function parseLocation(search) {
  const q = new URLSearchParams(search);
  const state = {};
  for (const [k, v] of q) if (k !== "tab" && k !== "step") state[k] = v;
  const step = q.get("step");
  return {
    tab: q.get("tab"),
    step: step != null && /^-?\d+$/.test(step) ? Number(step) : null,
    state,
  };
}

export function locationQuery({ tab, step, state }) {
  const q = new URLSearchParams();
  if (tab != null) q.set("tab", tab);
  if (step != null) q.set("step", String(step));
  for (const [k, v] of Object.entries(state ?? {})) if (k !== "tab" && k !== "step") q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : "";
}

// a location after navigate(req): fields left out stay, state keys set to null go
export function applyNavigate(loc, req) {
  const next = { ...loc, state: { ...loc.state } };
  if ("tab" in req) next.tab = req.tab ?? null;
  if ("step" in req) next.step = req.step == null ? null : Math.round(req.step);
  for (const [k, v] of Object.entries(req.state ?? {})) {
    if (v == null) delete next.state[k];
    else next.state[k] = String(v);
  }
  return next;
}
