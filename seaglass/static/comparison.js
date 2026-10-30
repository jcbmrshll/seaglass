// Runs side by side: a table of what tells them apart (their config) and how they did
// (their latest metrics), and a chart per metric with a line per run shown. The page
// around it owns which runs there are and which are shown, and keeps the view's state
// (the sort, the charts' options) where it likes, its address for one; this draws
// them, reading each run's config and metrics. Another app can draw a comparison with
// it: mountCompare.

import { h } from "./dom.js";
import { activity, fmt, progress, started, status } from "./format.js";
import { bestValue, chartLog, declared, declaredList, describe, headlines, matchNames, metricNames, rangedSeries, seriesPoints, stepOf, stepRange } from "./layout.js";
import { SERIES, hideTip, lineChart, swatchStyle } from "./chart.js";
import { SLOTS, assignSlots, configColumns, configText, flattenConfig, parseSort, runMatches, sortBy } from "./compare.js";
import { noteButton } from "./note.js";

// run metas read at once, for their configs
const CONFIG_BATCH = 8;

export const DEFAULT_COMPARE_PATHS = {
  // the API's root (SPEC.md §5)
  api: "/api",
  // where a run's name links to; null: no link
  run: (id) => `/run/${id}`,
};

// the view's state, each as text (as an address keeps it) or null
export const COMPARE_STATE = ["q", "sort", "metrics", "smooth", "log", "from", "to"];

// Draw a comparison: its table in `table` and its charts (with their options bar) in
// `charts`, either left out to draw only the other.
//
// - runs: the runs to compare, newest first: the run list's entries (SPEC.md §5.1) or
//   runs' metas; a run without its config has its meta read for it. null: not known yet
// - shown: the ids of the runs drawn in the charts; every run by default
// - state: COMPARE_STATE's keys, each text or null:
//   - q: words a run's name, id, tags, notes or conclusions must have to be listed
//   - sort: the table's column, "-" first for descending ("-m:loss", "c:lr", "name")
//   - metrics: patterns of the metrics charted, by comma or space; every one if none
//   - smooth: a moving average over this many points
//   - log: "1" for a log y axis on every chart (else on those declared log)
//   - from, to: the first and last step the charts show, either open
// - wide: the table has a column per config key that differs and per headline metric
//   (else just the runs); true by default
// - chartsHidden: the charts are out of sight, so not drawn until they're back
// - paths: DEFAULT_COMPARE_PATHS to change
// - empty(): what the table shows when there are no runs
// - hooks, each optional:
//   - state(changes): the reader changed the view's state here; changes is {key: text
//     or null}, to keep
//   - toggle(id): the reader turned a run on or off; without it, the table has no
//     toggles
//   - counted({plotted, matched, total}): the runs charted, listed and given
//
// Returns {update({runs, shown, wide, chartsHidden}), set(state), focus(id), colorOf(id),
// resize(), destroy()}; update reads what's new and draws, and resolves once it has.
export function mountCompare({ table = null, charts = null }, options = {}) {
  const c = new Comparison(table, charts, options);
  return {
    update: (changes) => c.update(changes),
    // the view's state changed outside: {key: text or null}
    set: (changes) => c.set(changes),
    // the run that stands out in every chart, or null
    focus: (id) => c.setFocus(id),
    // a run's line: {color, dashed}
    colorOf: (id) => c.colorOf(id),
    resize: () => c.renderCharts(),
    destroy: () => c.destroy(),
  };
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

const label = (name) => name.replaceAll("_", " ");

class Comparison {
  constructor(table, charts, { runs = null, shown = null, state = {}, wide = true, chartsHidden = false, paths = {}, empty = null, hooks = {} }) {
    this.paths = { ...DEFAULT_COMPARE_PATHS, ...paths };
    this.hooks = hooks;
    this.empty = empty ?? (() => h("div", { class: "empty" }, h("h1", { text: "No runs yet" })));
    this.state = Object.fromEntries(COMPARE_STATE.map((k) => [k, state[k] ?? null]));
    this.wide = wide;
    this.chartsHidden = chartsHidden;
    this.runs = null;
    this.shownList = null;
    // what the runs declared about their metrics, newest run first (SPEC.md §3.3)
    this.declared = [];
    // each run's config, flattened: a run's config never changes, so it is read once
    this.configs = new Map();
    // each run's metrics read so far, as {rows, next, updated}, for the runs shown
    this.metrics = new Map();
    this.slots = new Map();
    this.focus = null;
    // whether the charts are behind what's been read
    this.stale = false;
    // reads one after another, so a run's metrics are never read twice at once
    this.reading = Promise.resolve();

    this.tableEl = table;
    if (charts) {
      this.chartsEl = h("div", { class: "grid charts compare" });
      charts.replaceChildren(this.chartBar(), this.chartsEl);
    }
    this.onResize = () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.renderCharts(), 150);
    };
    addEventListener("resize", this.onResize);
    if (runs) this.update({ runs, shown });
    else if (shown) this.shownList = shown;
  }

  destroy() {
    this.dead = true;
    clearTimeout(this.resizeTimer);
    removeEventListener("resize", this.onResize);
  }

  // ------------------------------------------------------------ the state

  // the reader changed the state here: kept by the page, then drawn
  change(changes, what) {
    this.hooks.state?.(changes);
    this.set(changes, what);
  }

  set(changes, { table = true, charts = true } = {}) {
    for (const [k, v] of Object.entries(changes)) if (COMPARE_STATE.includes(k)) this.state[k] = v ?? null;
    if ("from" in changes || "to" in changes) this.rangeBoxes?.show(this.steps());
    if (this.runs == null) return;
    if (table) this.renderTable();
    if (charts) this.renderCharts();
  }

  // the steps the charts cover, [lo, hi] with either end null for open, or null for all
  steps() {
    return stepRange(stepOf(this.state.from), stepOf(this.state.to));
  }

  // ------------------------------------------------------------ which runs

  shownIds() {
    return this.shownList ?? (this.runs ?? []).map((r) => r.id);
  }

  shown() {
    const ids = new Set(this.shownIds());
    return (this.runs ?? []).filter((r) => ids.has(r.id));
  }

  filtered() {
    const q = this.state.q ?? "";
    return (this.runs ?? []).filter((r) => runMatches(r, q));
  }

  // what the charts draw: the runs shown that the filter matches
  plotted() {
    const ids = new Set(this.filtered().map((r) => r.id));
    return this.shown().filter((r) => ids.has(r.id));
  }

  colorOf(id) {
    const slot = this.slots.get(id) ?? 0;
    return { color: SERIES[slot % SERIES.length], dashed: slot % SLOTS >= SERIES.length };
  }

  // ------------------------------------------------------------ reading

  async update({ runs, shown, wide, chartsHidden } = {}) {
    if (this.dead) return;
    let counted = false;
    if (runs !== undefined) {
      counted = this.runs == null || runs == null || runs.length !== this.runs.length;
      this.runs = runs;
      this.declared = (runs ?? []).flatMap((r) => declaredList(r.declared));
      for (const r of runs ?? []) if (r.config !== undefined && !this.configs.has(r.id)) this.configs.set(r.id, flattenConfig(r.config));
    }
    const picked = shown !== undefined && !sameIds(shown, this.shownList);
    if (picked) this.shownList = shown;
    const back = chartsHidden === false && this.chartsHidden;
    const layout = (wide !== undefined && wide !== this.wide) || (chartsHidden !== undefined && chartsHidden !== this.chartsHidden);
    if (wide !== undefined) this.wide = wide;
    if (chartsHidden !== undefined) this.chartsHidden = chartsHidden;
    this.slots = assignSlots(this.slots, this.shownIds());
    if (this.runs == null) return;
    // what the reader did shows at once; what's read, once it is
    if (picked || layout) this.renderTable();
    if (picked || back) this.renderCharts();
    // the charts are drawn again once read, by the last update waiting
    this.stale ||= counted || picked;
    const read = (this.reading = this.reading.then(() => this.read()));
    await read;
    if (this.dead || read !== this.reading) return;
    this.renderTable();
    if (this.stale) this.renderCharts();
  }

  // the configs and metrics not read yet
  async read() {
    if (this.dead || this.runs == null) return;
    await this.loadConfigs();
    if (await this.loadMetrics()) this.stale = true;
  }

  // the configs not read yet: the run list leaves them out
  async loadConfigs() {
    const missing = this.runs.filter((r) => !this.configs.has(r.id));
    for (let i = 0; i < missing.length; i += CONFIG_BATCH) {
      await Promise.allSettled(
        missing.slice(i, i + CONFIG_BATCH).map(async (r) => {
          const run = await api(`${this.paths.api}/runs/${r.id}`);
          this.configs.set(r.id, flattenConfig(run.config));
        }),
      );
      if (this.dead) return;
    }
  }

  // the metrics of the runs shown that logged since they were last read; whether any
  // came
  async loadMetrics() {
    const stale = this.shown().filter((r) => this.metrics.get(r.id)?.updated !== r.updated);
    const got = await Promise.allSettled(
      stale.map(async (r) => {
        const m = this.metrics.get(r.id) ?? { rows: [], next: 0, updated: null };
        const res = await api(`${this.paths.api}/runs/${r.id}/metrics?since=${m.next}`);
        m.rows.push(...res.rows);
        m.next = res.next;
        m.updated = r.updated;
        this.metrics.set(r.id, m);
        return res.rows.length > 0;
      }),
    );
    return got.some((g) => g.status === "fulfilled" && g.value);
  }

  // ------------------------------------------------------------ the table

  metricColumns() {
    const names = [];
    const seen = new Set();
    for (const r of this.runs) {
      for (const k of Object.keys(r.latest ?? {})) {
        if (seen.has(k)) continue;
        seen.add(k);
        names.push(k);
      }
    }
    const top = headlines(this.declared, names);
    return top.length ? top : names;
  }

  renderTable() {
    const runs = this.runs;
    if (runs == null) return;
    const filtered = this.filtered();
    this.hooks.counted?.({ plotted: this.plotted().length, matched: filtered.length, total: runs.length });
    if (!this.tableEl) return;
    if (!runs.length) {
      this.tableEl.replaceChildren(this.empty());
      return;
    }
    const shownIds = new Set(this.shownIds());
    const toggle = this.hooks.toggle;
    // narrow, a run is its toggle and name; wide, the whole comparison
    const wide = this.wide;
    const config = wide ? configColumns(runs.map((r) => this.configs.get(r.id) ?? {})) : [];
    const metrics = wide ? this.metricColumns() : [];
    const sort = parseSort(this.state.sort);
    const now = Date.now() / 1000;
    const value = (r, key) => {
      if (key.startsWith("c:")) return this.configs.get(r.id)?.[key.slice(2)];
      if (key.startsWith("m:")) return r.latest?.[key.slice(2)];
      if (key === "status") return status(r, now);
      return r[key];
    };
    const rows = sortBy(filtered, (r) => value(r, sort.key), sort.desc);
    // each metric's best value among the runs listed, where it says which way is better
    const best = new Map(metrics.map((k) => [k, bestValue(this.declared, k, filtered.map((r) => r.latest?.[k]))]));

    // a header sorts by its column; again, the other way
    const th = (key, text, cls = "") => {
      const on = sort.key === key;
      // a metric sorts best first, highest unless lower is better
      const metric = key.startsWith("m:") ? key.slice(2) : null;
      const better = metric && declared(this.declared, metric, "better");
      const firstDesc = metric ? better !== "lower" : !(key === "name" || key === "status" || key.startsWith("c:"));
      const next = on ? !sort.desc : firstDesc;
      const unit = metric && declared(this.declared, metric, "unit");
      return h("th", {
        class: `sortable ${cls}${on ? " on" : ""}`, title: `sort by ${text}${better ? ` (${better} is better)` : ""}`,
        onclick: () => this.change({ sort: key === "created" && next ? null : `${next ? "-" : ""}${key}` }, { charts: false }),
      }, text, unit && h("span", { class: "unit", text: ` ${unit}` }), on ? (sort.desc ? " ↓" : " ↑") : "");
    };
    const base = [toggle && h("th", { class: "pick" }), th("name", "run"), wide && [th("created", "started"), th("step", "step", "num")]];
    const groups = wide && h("tr", { class: "groups" },
      h("th", { colspan: toggle ? 4 : 3 }),
      config.length > 0 && h("th", { colspan: config.length, class: "group", text: "config" }),
      metrics.length > 0 && h("th", { colspan: metrics.length, class: "group", text: "latest" }));
    const head = h("tr", {}, base,
      config.map((k, i) => th(`c:${k}`, k, `num${i === 0 ? " first" : ""}`)),
      metrics.map((k, i) => th(`m:${k}`, k, `num${i === 0 ? " first" : ""}`)));

    const body = rows.map((r) => {
      const on = shownIds.has(r.id);
      const st = status(r, now);
      const cfg = this.configs.get(r.id);
      const href = this.paths.run?.(r.id);
      const title = r.notes ? `${r.name}: ${r.notes}` : `open ${r.name}`;
      return h("tr", {
        class: `run${on ? " on" : ""}`,
        onclick: toggle && ((e) => !e.target.closest("a") && toggle(r.id)),
        onmouseenter: () => this.setFocus(on ? r.id : null),
        onmouseleave: () => this.setFocus(null),
      },
        toggle && h("td", { class: "pick" },
          h("button", { class: "eye", "aria-pressed": String(on), title: on ? "shown in the charts: click to hide" : "hidden: click to show in the charts" }, eye(on))),
        h("td", { class: "who" },
          h("div", { class: "line1" },
            h("i", { class: "swatch", style: on ? swatchStyle(this.colorOf(r.id)) : null }),
            href ? h("a", { class: "name", href, "data-app": true, text: r.name, title }) : h("span", { class: "name", text: r.name, title }),
            (r.tags ?? []).map((t) => h("span", { class: "chip", text: t }))),
          h("div", { class: "sub" }, h("span", { class: `dot ${st}`, title: st }), activity(r, now) || (wide ? r.id : `${st} · ${progress(r) || "no steps"}`))),
        wide && [h("td", { class: "mono", text: started(r.created) }), h("td", { class: "num", text: progress(r) })],
        config.map((k, i) => h("td", { class: `num${i === 0 ? " first" : ""}`, text: cfg ? configText(cfg[k]) : "…" })),
        metrics.map((k, i) => {
          const v = r.latest?.[k];
          const top = v != null && v === best.get(k);
          return h("td", { class: `num${i === 0 ? " first" : ""}${top ? " best" : ""}`, title: top ? "the best of these runs" : null, text: fmt(v) });
        }));
    });
    const scrolled = this.tableEl.scrollLeft;
    this.tableEl.replaceChildren(h("table", { class: `runs compare${wide ? "" : " compact"}` }, h("thead", {}, groups, head), h("tbody", {}, body)));
    this.tableEl.scrollLeft = scrolled;
  }

  // ------------------------------------------------------------ the charts

  // the charts' options: which metrics, smoothing, the y scale and the steps
  chartBar() {
    const s = this.state;
    const metricsBox = h("input", {
      type: "search", placeholder: "metrics: loss*, return", value: s.metrics, title: "patterns of the metrics to chart, * any characters",
      onchange: (e) => this.change({ metrics: e.target.value.trim() || null }, { table: false }),
    });
    const smoothBox = h("input", {
      type: "number", min: 0, step: 1, placeholder: "0", value: s.smooth, title: "a moving average over this many points",
      onchange: (e) => this.change({ smooth: Number(e.target.value) > 1 ? String(Math.floor(e.target.value)) : null }, { table: false }),
      onkeydown: (e) => e.key === "Enter" && e.target.blur(),
    });
    const logButton = h("button", {
      text: "log y", class: s.log === "1" ? "on" : null, title: "a log-scale y axis for every chart (off: for the metrics the runs say to)",
      onclick: () => {
        const on = this.state.log !== "1";
        logButton.classList.toggle("on", on);
        this.change({ log: on ? "1" : null }, { table: false });
      },
    });
    const setSteps = (range) => this.change({ from: range?.[0] == null ? null : String(range[0]), to: range?.[1] == null ? null : String(range[1]) }, { table: false });
    this.rangeBoxes = stepRangeBoxes(setSteps);
    this.rangeBoxes.show(this.steps());
    return h("div", { class: "topbar" },
      h("span", { class: "stitle", text: "charts" }),
      metricsBox,
      h("span", { class: "scrub" }, h("span", { class: "dim", text: "smooth" }), smoothBox),
      logButton,
      this.rangeBoxes.el);
  }

  renderCharts() {
    // hidden, the charts are out of sight: they're drawn on the way back
    if (!this.chartsEl || this.runs == null || this.chartsHidden) return;
    this.stale = false;
    hideTip();
    const runs = this.plotted();
    const rowsOf = (r) => this.metrics.get(r.id)?.rows ?? [];
    const patterns = (this.state.metrics ?? "").split(/[\s,]+/).filter(Boolean);
    const logged = metricNames(runs.flatMap(rowsOf));
    // the headline metrics first, unless the page asks for some by pattern
    const top = headlines(this.declared, logged);
    const names = patterns.length ? matchNames(patterns, logged) : [...top, ...logged.filter((n) => !top.includes(n))];
    const over = Number(this.state.smooth) || 0;
    const [lo, hi] = this.steps() ?? [];
    // log y for every chart, or for the metrics declared log
    const allLog = this.state.log === "1";

    if (!names.length) {
      const why = !runs.length ? "No runs shown: pick some in the table." : patterns.length ? "No metric of the runs shown matches." : "The runs shown haven't logged metrics yet.";
      this.chartsEl.replaceChildren(h("div", { class: "dim", text: why }));
      return;
    }
    this.chartsEl.replaceChildren(...names.map((key) => {
      const unit = declared(this.declared, key, "unit");
      const log = allLog || chartLog(null, this.declared, [key]);
      const series = runs.flatMap((r) => {
        const { points, raw } = rangedSeries(seriesPoints(rowsOf(r), key), over, lo, hi);
        if (!points.length) return [];
        return [{ id: r.id, name: r.name, ...this.colorOf(r.id), points, raw, unit }];
      });
      const holder = h("div", { class: "chart-holder" });
      const card = h("div", { class: "card chart-card" },
        h("div", { class: "card-hdr" }, h("span", { class: "title", text: label(key), title: key }), noteButton(`compare:${key}`, describe(this.declared, key))),
        holder);
      // drawn once the card is laid out, so the chart knows its width
      requestAnimationFrame(() => {
        if (!holder.isConnected) return;
        holder.replaceChildren(lineChart(series, holder.clientWidth - 8, { log }).el);
        this.applyFocus(holder);
      });
      return card;
    }));
  }

  // the run hovered in the table stands out in every chart
  setFocus(id) {
    this.focus = id;
    if (this.chartsEl) this.applyFocus(this.chartsEl);
  }

  applyFocus(within) {
    this.chartsEl.classList.toggle("focus", this.focus != null);
    for (const p of within.querySelectorAll("path[data-id]")) p.classList.toggle("hl", p.getAttribute("data-id") === this.focus);
  }
}

const sameIds = (a, b) => a === b || (a != null && b != null && a.length === b.length && a.every((id, i) => id === b[i]));

// two boxes for the steps the charts cover, either left empty for open, and a button
// for every step; a change calls set(range), range null for every step. Returns {el,
// show(range)}.
function stepRangeBoxes(set) {
  const box = (placeholder, title) => h("input", {
    type: "number", step: 1, placeholder, title,
    onchange: () => set(stepRange(stepOf(lo.value), stepOf(hi.value))),
    onkeydown: (e) => e.key === "Enter" && e.target.blur(),
  });
  const lo = box("from", "the first step the charts show (empty: the first logged)");
  const hi = box("to", "the last step the charts show (empty: the latest)");
  const all = h("button", { text: "all", title: "every step", onclick: () => set(null) });
  const show = (range) => {
    [lo, hi].forEach((b, i) => {
      b.value = range?.[i] ?? "";
      b.classList.toggle("on", range?.[i] != null);
    });
    all.disabled = !range;
  };
  return { el: h("span", { class: "scrub" }, h("span", { class: "dim", text: "steps" }), lo, h("span", { class: "dim", text: "–" }), hi, all), show };
}

// the toggle that shows a run in the charts, or hides it
function eye(on) {
  return h("svg", { class: "eye-icon", viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": "true" },
    h("path", { d: "M1.5 8C3.5 4.6 5.7 3.3 8 3.3s4.5 1.3 6.5 4.7c-2 3.4-4.2 4.7-6.5 4.7S3.5 11.4 1.5 8Z" }),
    h("circle", { cx: 8, cy: 8, r: 2.1 }),
    !on && h("line", { x1: 2.5, y1: 13.5, x2: 13.5, y2: 2.5 }));
}
