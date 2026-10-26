// The basic frontend: a run list, and a run page that draws a run's layout (SPEC.md
// §8) with its bundle's modules, each in a sandboxed frame (§7). No framework: every
// view is plain DOM built with h(), and text that comes from a run only ever goes in
// as text. It polls, reading metrics and media incrementally.

import { h } from "./dom.js";
import { activity, ago, duration, fmt, progress, started, status } from "./format.js";
import {
  CONTRACT, applyNavigate, entriesByKey, entryIndexAt, locationQuery, matchNames, metricNames,
  parseLocation, resolveLayout, seriesPoints, smooth, splitGroups, valueAt,
} from "./layout.js";
import { SERIES, hideTip, lineChart } from "./chart.js";
import { currentTheme, mountModule } from "./host.js";
import { genericView } from "./generic.js";
import { readNpz } from "./npz.js";

const VERSION = "0.1.0";
const POLL_MS = 2000;
const RUNS_POLL_MS = 5000;
// the windows offered over the charts, in steps
const CHART_WINDOWS = [50, 200, 1000];
const FILE_CACHE = 64;

const main = document.getElementById("main");

// ---------------------------------------------------------------- helpers

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const err = new Error(`${res.status} ${path}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function setConnected(ok) {
  document.getElementById("conn").textContent = ok ? "" : "server unreachable";
}

const enc = (path) => path.split("/").map(encodeURIComponent).join("/");
const label = (name) => name.replaceAll("_", " ");
const sep = () => h("span", { class: "sep", text: "·" });

// each bundle's layout.json, once: null if the server doesn't have it
const layouts = new Map();
function bundleLayout(hash) {
  if (!hash) return Promise.resolve(null);
  if (!layouts.has(hash)) {
    layouts.set(hash, fetch(`/bundles/${hash}/layout.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return layouts.get(hash);
}

// ---------------------------------------------------------------- routing

let page = null;

function route() {
  const m = location.pathname.match(/^\/run\/([\w-]+)\/?$/);
  return m ? { name: "run", id: m[1] } : { name: "list" };
}

export function go(path) {
  history.pushState(null, "", path);
  show();
}

function show() {
  const r = route();
  if (r.name === "run" && page instanceof RunPage && page.id === r.id) {
    page.locationChanged(parseLocation(location.search));
    return;
  }
  page?.destroy();
  hideTip();
  page = r.name === "run" ? new RunPage(r.id) : new RunList();
}

addEventListener("popstate", show);

// links inside the app move without reloading
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a[data-app]");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  go(a.getAttribute("href"));
});

// ---------------------------------------------------------------- run list

class RunList {
  constructor() {
    document.title = "seaglass";
    main.className = "";
    this.runs = null;
    this.el = h("div", { class: "page" });
    main.replaceChildren(this.el);
    main.scrollTop = 0;
    this.poll();
    this.timer = setInterval(() => document.visibilityState === "visible" && this.poll(), RUNS_POLL_MS);
  }

  destroy() {
    clearInterval(this.timer);
    this.dead = true;
  }

  async poll() {
    try {
      this.runs = await api("/api/runs");
      setConnected(true);
    } catch {
      setConnected(false);
      if (this.runs == null) this.runs = [];
    }
    if (this.dead) return;
    // the summaries of the runs' bundles, before drawing them
    const summaries = new Map();
    await Promise.all(
      [...new Set(this.runs.map((r) => r.bundle).filter(Boolean))].map(async (hash) => {
        const layout = await bundleLayout(hash);
        summaries.set(hash, layout?.contract === CONTRACT && Array.isArray(layout.summary) ? layout.summary : []);
      }),
    );
    if (!this.dead && !this.el.contains(document.activeElement)) this.render(summaries);
  }

  filters() {
    const q = new URLSearchParams(location.search);
    return { project: q.get("project") ?? "", tag: q.get("tag") ?? "", branch: q.get("branch") ?? "", q: q.get("q") ?? "" };
  }

  setFilter(key, value) {
    const q = new URLSearchParams(location.search);
    if (value) q.set(key, value);
    else q.delete(key);
    history.replaceState(null, "", `/${q.toString() ? `?${q}` : ""}`);
    this.poll();
  }

  render(summaries) {
    const f = this.filters();
    const runs = this.runs;
    const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort();
    const projects = uniq(runs.map((r) => r.project));
    const tags = uniq(runs.flatMap((r) => r.tags ?? []));
    const branches = uniq(runs.map((r) => r.provenance?.git?.branch));
    const shown = runs.filter(
      (r) =>
        (!f.project || r.project === f.project) &&
        (!f.tag || r.tags?.includes(f.tag)) &&
        (!f.branch || r.provenance?.git?.branch === f.branch) &&
        (!f.q || `${r.name} ${r.id}`.toLowerCase().includes(f.q.toLowerCase())),
    );
    const select = (key, name, options) =>
      h("label", {}, name, h("select", { onchange: (e) => this.setFilter(key, e.target.value) },
        h("option", { value: "", text: "all" }),
        options.map((o) => h("option", { value: o, text: o, selected: o === f[key] }))));
    const search = h("input", { type: "search", placeholder: "name or id", value: f.q || null, onchange: (e) => this.setFilter("q", e.target.value) });

    // each run's summary metrics: its bundle's patterns over what it logged
    const summaryOf = (r) => matchNames(summaries.get(r.bundle) ?? [], Object.keys(r.latest ?? {}));
    // one project: a column per summary metric; several: the values in one column
    const columns = f.project ? [...new Set(shown.flatMap(summaryOf))] : [];
    const head = h("tr", {},
      ["", "run", "project", "tags", "branch", "started", "time", "step"].map((t) => h("th", { text: t })),
      f.project ? columns.map((c) => h("th", { class: "num", text: c })) : h("th", { text: "summary" }));
    const now = Date.now() / 1000;
    const rows = shown.map((r) => {
      const st = status(r, now);
      const git = r.provenance?.git;
      const end = r.status === "running" ? now : r.updated;
      const summary = summaryOf(r);
      return h("tr", { class: "run", onclick: (e) => !e.target.closest("a") && go(`/run/${r.id}`) },
        h("td", {}, h("div", { class: "status", title: st }, h("span", { class: `dot ${st}` }), st)),
        h("td", {},
          h("a", { class: "name", href: `/run/${r.id}`, "data-app": true, text: r.name }),
          h("div", { class: "sub", text: activity(r, now) || r.id })),
        h("td", { class: "mono", text: r.project }),
        h("td", {}, (r.tags ?? []).map((t) => h("span", { class: "chip", text: t }))),
        h("td", { class: "mono" }, git ? [git.branch ?? "", git.dirty ? h("span", { class: "chip dirty", text: "dirty", title: "uncommitted changes" }) : null] : "–"),
        h("td", { class: "mono", text: started(r.created) }),
        h("td", { class: "mono", text: r.status === "running" ? `${duration(end - r.created)} · ${ago(r.updated, now)}` : duration(end - r.created) }),
        h("td", { class: "num", text: progress(r) }),
        f.project
          ? columns.map((c) => h("td", { class: "num", text: summary.includes(c) ? fmt(r.latest[c]) : "" }))
          : h("td", {}, summary.slice(0, 4).map((k) => h("span", { class: "kv" }, `${k} `, h("b", { text: fmt(r.latest[k]) }), "  "))),
      );
    });
    this.el.replaceChildren(
      h("div", { class: "filters" },
        h("h1", { text: "Runs" }),
        select("project", "project", projects),
        select("tag", "tag", tags),
        select("branch", "branch", branches),
        search,
        h("span", { class: "count", text: `${shown.length} of ${runs.length}` })),
      runs.length
        ? h("table", { class: "runs" }, head, rows)
        : h("div", { class: "empty" },
            h("h1", { text: "No runs yet" }),
            h("p", { text: "Log one from a training script:" }),
            h("p", {}, h("code", { text: `Monitor("${location.origin}", project="…").start(config)` })),
            h("p", { text: "It shows up here as soon as it starts." })),
    );
  }
}

// ---------------------------------------------------------------- run page

class RunPage {
  constructor(id) {
    this.id = id;
    this.run = null;
    this.rows = [];
    this.metricsNext = 0;
    this.media = [];
    this.mediaNext = 0;
    this.loc = parseLocation(location.search);
    this.panels = [];
    this.modules = new Set();
    this.files = new Map();
    this.chartWindow = Number(localStorage.getItem("seaglass:chartWindow")) || null;
    this.host = this.makeHost();
    main.className = "";
    main.replaceChildren(h("div", { class: "empty" }, h("p", { class: "dim", text: "loading run…" })));
    main.scrollTop = 0;
    this.onTheme = () => this.broadcast({ theme: currentTheme() });
    this.dark = matchMedia("(prefers-color-scheme: dark)");
    this.dark.addEventListener("change", this.onTheme);
    this.onResize = () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.panels.forEach((p) => p.resize?.()), 150);
    };
    addEventListener("resize", this.onResize);
    this.start();
  }

  destroy() {
    this.dead = true;
    clearInterval(this.timer);
    removeEventListener("resize", this.onResize);
    this.dark.removeEventListener("change", this.onTheme);
    this.clearPanels();
  }

  clearPanels() {
    for (const p of this.panels) p.destroy?.();
    this.panels = [];
    this.modules.clear();
  }

  async start() {
    try {
      const [run, metrics, media] = await Promise.all([
        api(`/api/runs/${this.id}`),
        api(`/api/runs/${this.id}/metrics?since=0`),
        api(`/api/runs/${this.id}/media?since=0`),
      ]);
      this.run = run;
      this.rows = metrics.rows;
      this.metricsNext = metrics.next;
      this.media = media.rows;
      this.mediaNext = media.next;
      setConnected(true);
    } catch (e) {
      if (this.dead) return;
      if (e.status === 404) main.replaceChildren(h("div", { class: "empty" }, h("h1", { text: "No such run" }), h("p", {}, h("a", { href: "/", "data-app": true, text: "all runs" }))));
      else {
        setConnected(false);
        main.replaceChildren(h("div", { class: "empty" }, h("h1", { text: "Couldn't load this run" }), h("p", { class: "dim", text: e.message })));
      }
      return;
    }
    const raw = await bundleLayout(this.run.bundle);
    if (this.dead) return;
    this.layout = resolveLayout(raw);
    if (this.run.bundle && !raw) this.layout.note = `its views (bundle ${this.run.bundle.slice(0, 12)}…) aren't on this server`;
    document.title = `${this.run.name} · seaglass`;
    this.build();
    this.timer = setInterval(() => document.visibilityState === "visible" && this.poll(), POLL_MS);
  }

  async poll() {
    if (this.polling || this.dead) return;
    this.polling = true;
    try {
      const [run, metrics, media] = await Promise.all([
        api(`/api/runs/${this.id}`),
        api(`/api/runs/${this.id}/metrics?since=${this.metricsNext}`),
        api(`/api/runs/${this.id}/media?since=${this.mediaNext}`),
      ]);
      if (this.dead) return;
      setConnected(true);
      const changed = run.updated !== this.run.updated || run.status !== this.run.status;
      this.run = run;
      this.metricsNext = metrics.next;
      this.mediaNext = media.next;
      this.rows.push(...metrics.rows);
      this.media.push(...media.rows);
      this.renderHead();
      if (metrics.rows.length) {
        this.stepBar.update();
        this.panels.forEach((p) => p.metrics?.());
      }
      if (media.rows.length) {
        this.stepBar.update();
        this.panels.forEach((p) => p.media?.());
      }
      if (changed) this.broadcast({ run });
    } catch {
      setConnected(false);
    } finally {
      this.polling = false;
    }
  }

  broadcast(change) {
    for (const m of this.modules) m.update(change);
  }

  // ------------------------------------------------------------ location

  tabIndex() {
    const i = this.layout.tabs.findIndex((t) => t.title === this.loc.tab);
    return i < 0 ? 0 : i;
  }

  setLocation(loc, { push = false } = {}) {
    const before = this.loc;
    this.loc = loc;
    const url = `/run/${this.id}${locationQuery(loc)}`;
    if (push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
    this.applied(before);
  }

  // the address changed under the page (back, forward)
  locationChanged(loc) {
    const before = this.loc;
    this.loc = loc;
    this.applied(before);
  }

  applied(before) {
    const loc = this.loc;
    if (this.tabIndexOf(before.tab) !== this.tabIndex()) {
      this.renderTabs();
      this.renderTab();
    } else if (before.step !== loc.step) {
      this.panels.forEach((p) => p.step?.());
    }
    if (before.step !== loc.step) this.stepBar.update();
    if (before.step !== loc.step || before.tab !== loc.tab || JSON.stringify(before.state) !== JSON.stringify(loc.state)) {
      this.broadcast({ location: loc });
    }
  }

  tabIndexOf(title) {
    const i = this.layout.tabs.findIndex((t) => t.title === title);
    return i < 0 ? 0 : i;
  }

  navigate(req) {
    if (!req || typeof req !== "object") throw new Error("navigate takes {tab, step, state}");
    if ("tab" in req && req.tab != null && !this.layout.tabs.some((t) => t.title === req.tab)) throw new Error(`no tab ${req.tab}`);
    const next = applyNavigate(this.loc, req);
    // a new tab or view state is somewhere to come back to; a step isn't
    const push = ("tab" in req && next.tab !== this.loc.tab) || "state" in req;
    this.setLocation(next, { push });
  }

  pickStep(step) {
    const last = this.lastStep();
    this.setLocation({ ...this.loc, step: step == null || step >= last ? null : step });
  }

  steps() {
    const steps = new Set();
    for (const r of this.rows) steps.add(r.step);
    for (const e of this.media) steps.add(e.step);
    return [...steps].sort((a, b) => a - b);
  }

  lastStep() {
    return this.steps().at(-1) ?? 0;
  }

  // ------------------------------------------------------------ host

  makeHost() {
    const run = () => `/api/runs/${this.id}`;
    const str = (x, what) => {
      if (typeof x !== "string") throw new Error(`${what} is a string`);
      return x;
    };
    const since = (opts) => Math.max(0, Math.floor(Number(opts?.since ?? 0)) || 0);
    const file = (path) => {
      str(path, "a file path");
      let p = this.files.get(path);
      if (!p) {
        p = fetch(`${run()}/files/${enc(path)}`).then((r) => {
          if (!r.ok) throw new Error(r.status === 404 ? `no file ${path}` : `${r.status} reading ${path}`);
          return r.arrayBuffer();
        });
        p.catch(() => this.files.delete(path));
        this.files.set(path, p);
        // files never change, so they're kept, a few at a time
        if (this.files.size > FILE_CACHE) this.files.delete(this.files.keys().next().value);
      }
      return p;
    };
    const pref = (key) => `seaglass:pref:${this.run.project}:${str(key, "a pref key")}`;
    return {
      info: async () => ({ contract: CONTRACT, frontend: `seaglass-basic/${VERSION}` }),
      run: () => api(run()),
      metrics: (opts) => api(`${run()}/metrics?since=${since(opts)}`),
      entries: async (opts) => {
        const res = await api(`${run()}/media?since=${since(opts)}`);
        if (opts?.key != null) res.rows = res.rows.filter((e) => e.key === opts.key);
        return res;
      },
      stream: (name, opts) => api(`${run()}/streams/${encodeURIComponent(str(name, "a stream name"))}?since=${since(opts)}`),
      file,
      json: async (path) => JSON.parse(new TextDecoder().decode(await file(path))),
      arrays: async (path) => readNpz(await file(path)),
      theme: async () => currentTheme(),
      location: async () => this.loc,
      navigate: async (req) => this.navigate(req),
      getPref: async (key) => {
        const v = localStorage.getItem(pref(key));
        return v == null ? null : JSON.parse(v);
      },
      setPref: async (key, value) => {
        const text = JSON.stringify(value ?? null);
        if (text.length > 64 * 1024) throw new Error("prefs are at most 64 KiB");
        localStorage.setItem(pref(key), text);
      },
    };
  }

  // what the page's own (generic) displays read files with
  get data() {
    return {
      url: (path) => `/api/runs/${this.id}/files/${enc(path)}`,
      json: (path) => this.host.json(path),
      arrays: (path) => this.host.arrays(path),
    };
  }

  mount(container, { module, data, fill = false, onError }) {
    const url = new URL(`/bundles/${this.run.bundle}/${enc(module)}`, location.origin).href;
    const m = mountModule(container, { module: url, data, run: this.run, host: this.host, theme: currentTheme(), fill, onError });
    this.modules.add(m);
    return {
      update: (change) => m.update(change),
      destroy: () => {
        this.modules.delete(m);
        m.destroy();
      },
    };
  }

  // ------------------------------------------------------------ the page

  build() {
    this.head = h("div", { class: "runhead" });
    this.tabsEl = h("nav", { class: "tabs" });
    this.stepBar = stepBar(this);
    this.windowEl = h("span", { class: "scrub" });
    this.body = h("div", { class: "rows" });
    this.pageEl = h("div", { class: "page" }, this.head, h("div", { class: "topbar" }, this.tabsEl, this.stepBar.el, h("span", { class: "spacer" }), this.windowEl), this.body);
    main.replaceChildren(this.pageEl);
    this.renderHead();
    this.renderTabs();
    this.renderWindow();
    this.renderTab();
  }

  renderHead() {
    const run = this.run;
    const now = Date.now() / 1000;
    const st = status(run, now);
    const end = run.status === "running" ? now : run.updated;
    const prov = run.provenance ?? {};
    const git = prov.git;
    const argv = Array.isArray(prov.argv) ? prov.argv.join(" ") : null;
    this.head.replaceChildren(
      h("div", { class: "crumbs" },
        h("a", { href: `/?project=${encodeURIComponent(run.project)}`, "data-app": true, text: run.project }),
        h("span", { class: "id", text: run.id })),
      h("h1", { text: run.name }),
      h("div", { class: "meta" },
        h("span", { class: `dot ${st}` }), h("span", { text: st }),
        activity(run, now) && [sep(), h("span", { class: "doing", text: activity(run, now) })],
        sep(), h("span", { text: `started ${started(run.created)}` }),
        sep(), h("span", { text: duration(end - run.created) }),
        run.step != null && [sep(), h("span", { text: progress(run) })],
        (run.tags ?? []).length > 0 && [sep(), run.tags.map((t) => h("a", { class: "chip", href: `/?tag=${encodeURIComponent(t)}`, "data-app": true, text: t }))]),
      h("div", { class: "prov" },
        git && h("span", { title: git.commit }, `${git.branch ?? "?"} @ ${String(git.commit).slice(0, 8)}`, git.dirty ? h("span", { class: "chip dirty", text: "dirty" }) : null),
        prov.host && h("span", { text: prov.host }),
        argv && h("span", { class: "argv", title: argv, text: `$ ${argv}` }),
        prov.cwd && h("span", { class: "dim", text: prov.cwd })),
      this.layout.note ? h("div", { class: "note", text: `drawn with the default layout: ${this.layout.note}` }) : "",
    );
  }

  renderTabs() {
    const tabs = this.layout.tabs;
    const current = this.tabIndex();
    this.tabsEl.hidden = tabs.length < 2;
    this.tabsEl.replaceChildren(
      ...tabs.map((t, i) =>
        h("button", { class: i === current ? "on" : null, text: t.title ?? `tab ${i + 1}`, onclick: () => this.navigate({ tab: i === 0 ? null : t.title }) }),
      ),
    );
  }

  renderWindow() {
    const win = this.chartWindow;
    const set = (n) => {
      this.chartWindow = n > 0 ? Math.floor(n) : null;
      if (this.chartWindow) localStorage.setItem("seaglass:chartWindow", this.chartWindow);
      else localStorage.removeItem("seaglass:chartWindow");
      this.renderWindow();
      this.panels.forEach((p) => p.metrics?.());
    };
    const toggle = (n, text, title) => h("button", { class: win === n ? "on" : null, text, title, onclick: () => set(n) });
    const typed = win && !CHART_WINDOWS.includes(win);
    this.windowEl.replaceChildren(
      ...[h("span", { class: "dim", text: "charts: last" }),
      toggle(null, "all", "every step"),
      CHART_WINDOWS.map((n) => toggle(n, fmt(n), `the last ${n} steps`)),
      h("input", {
        type: "number", min: 1, step: 1, placeholder: "N", title: "the last N steps",
        value: typed ? win : null, class: typed ? "on" : null,
        onchange: (e) => set(Number(e.target.value)),
        onkeydown: (e) => e.key === "Enter" && e.target.blur(),
      }),
      h("span", { class: "dim", text: "steps" })].flat(),
    );
  }

  renderTab() {
    this.clearPanels();
    hideTip();
    const tab = this.layout.tabs[this.tabIndex()];
    const fill = !!tab.panel;
    main.classList.toggle("fill", fill);
    this.pageEl.style.minHeight = "";
    if (fill) {
      const slot = h("div", { class: "fill-slot" });
      this.body.replaceChildren(slot);
      this.addPanel(slot, tab.panel, { fill: true });
    } else {
      const rows = (tab.rows ?? []).map((row) => {
        const rowEl = h("div", { class: "row" });
        for (const panel of row) {
          const slot = h("div", { class: "slot" });
          slot.style.flex = `${Number(panel.width) > 0 ? Number(panel.width) : 1} 1 0`;
          rowEl.append(slot);
          this.addPanel(slot, panel);
        }
        return rowEl;
      });
      this.body.replaceChildren(...rows);
    }
  }

  addPanel(slot, panel, { fill = false } = {}) {
    const make = PANELS[panel?.type];
    if (!make) {
      slot.append(h("div", { class: "media-error", text: `no panel type ${panel?.type}` }));
      return;
    }
    this.panels.push(make(this, slot, panel, { fill }));
  }

  // what tiles and charts show of a metric as of the step picked
  valueAt(key) {
    return valueAt(this.rows, key, this.loc.step);
  }
}

// ---------------------------------------------------------------- step bar

// the slider that picks the step the page shows (null: the latest, following it)
function stepBar(page) {
  const range = h("input", { type: "range", min: 0, max: 0, step: 1, value: 0 });
  const box = h("input", { type: "number", step: 1, title: "type a step" });
  const of = h("span", { class: "dim" });
  const latest = h("button", { text: "latest", title: "back to the latest step, following new ones", onclick: () => page.pickStep(null) });
  const prev = h("button", { text: "‹", title: "the step before", onclick: () => move(-1) });
  const next = h("button", { text: "›", title: "the step after", onclick: () => move(1) });
  // the steps logged, so the slider moves between them
  const move = (d) => {
    const steps = page.steps();
    const at = page.loc.step ?? steps.at(-1);
    const i = steps.findIndex((s) => s >= at);
    page.pickStep(steps[Math.min(steps.length - 1, Math.max(0, (i < 0 ? steps.length - 1 : i) + d))]);
  };
  range.addEventListener("input", () => page.pickStep(Number(range.value)));
  box.addEventListener("change", () => box.value !== "" && page.pickStep(Math.round(Number(box.value))));
  box.addEventListener("keydown", (e) => e.key === "Enter" && box.blur());
  const el = h("div", { class: "scrub stepbar" }, h("span", { class: "dim pos-label", text: "step" }), prev, range, next, box, of, latest);
  function update() {
    const steps = page.steps();
    el.hidden = !steps.length;
    const first = steps[0] ?? 0, last = steps.at(-1) ?? 0;
    range.min = first;
    range.max = last;
    range.value = page.loc.step ?? last;
    if (document.activeElement !== box) box.value = page.loc.step ?? last;
    of.textContent = `of ${last}`;
    latest.disabled = page.loc.step == null;
    el.classList.toggle("pinned", page.loc.step != null);
  }
  update();
  return { el, update };
}

// ---------------------------------------------------------------- panels

function titled(slot, title) {
  if (title) slot.append(h("div", { class: "stitle", text: title }));
}

const PANELS = {
  tiles(page, slot, panel) {
    const el = h("div", { class: "tiles" });
    titled(slot, panel.title);
    slot.append(el);
    const draw = () => {
      let names = matchNames(panel.metrics ?? page.layout.summary, metricNames(page.rows));
      if (panel.max) names = names.slice(0, panel.max);
      el.replaceChildren(...names.map((k) => h("div", { class: "tile", title: k }, h("div", { class: "lab", text: label(k) }), h("div", { class: "val", text: fmt(page.valueAt(k)) }))));
      el.hidden = !names.length;
    };
    draw();
    return { metrics: draw, step: draw };
  },

  chart(page, slot, panel) {
    const patterns = panel.metrics ?? [];
    const title = panel.title ?? (patterns.length === 1 && !panel.split ? patterns[0] : "");
    if (panel.split) titled(slot, panel.title);
    const el = h("div", { class: panel.split ? "grid charts" : "" });
    slot.append(el);
    let updates = [];
    const draw = () => {
      updates = [];
      const names = matchNames(patterns, metricNames(page.rows));
      const groups = panel.split
        ? splitGroups(names)
        : names.length ? [{ name: title, series: names.map((k) => ({ name: k, key: k })) }] : [];
      const last = page.rows.length ? Math.max(...page.rows.map((r) => r.step)) : null;
      const from = page.chartWindow && last != null ? last - page.chartWindow + 1 : -Infinity;
      el.replaceChildren(...groups.map((g) => chartCard(page, panel, g, from, updates)));
    };
    draw();
    return {
      metrics: draw,
      resize: draw,
      step: () => updates.forEach((u) => u()),
    };
  },

  media(page, slot, panel) {
    titled(slot, panel.title);
    const el = h("div", { class: "grid media" });
    slot.append(el);
    const cards = new Map();
    const draw = () => {
      const byKey = entriesByKey(page.media);
      for (const key of matchNames(panel.keys ?? [], [...byKey.keys()])) {
        let card = cards.get(key);
        if (!card) {
          card = mediaCard(page, key);
          cards.set(key, card);
          el.append(card.el);
        }
        card.update(byKey.get(key));
      }
      el.hidden = !cards.size;
    };
    draw();
    return {
      media: draw,
      step: draw,
      destroy: () => cards.forEach((c) => c.destroy()),
    };
  },

  view(page, slot, panel, { fill }) {
    titled(slot, panel.title);
    const holder = h("div", { class: fill ? "view-slot" : "" });
    const card = h("div", { class: "card" }, holder);
    slot.append(card);
    if (!page.layout.usable || typeof panel.module !== "string") {
      holder.append(h("div", { class: "media-error", text: page.layout.usable ? "this view names no module" : "this view's bundle isn't available" }));
      return {};
    }
    const m = page.mount(holder, {
      module: panel.module,
      data: panel.props ?? {},
      fill,
      onError: (message) => card.append(h("div", { class: "media-error", text: `${panel.module} failed: ${message}` })),
    });
    return { destroy: () => m.destroy() };
  },

  config(page, slot, panel) {
    titled(slot, panel.title ?? "Config");
    const config = page.run.config ?? {};
    const isSection = (v) => v && typeof v === "object" && !Array.isArray(v);
    const sections = Object.entries(config).filter(([, v]) => isSection(v));
    const flat = Object.entries(config).filter(([, v]) => !isSection(v));
    if (flat.length) sections.unshift(["config", Object.fromEntries(flat)]);
    const value = (v) => {
      if (v == null) return "–";
      if (Array.isArray(v) && v.every((x) => typeof x !== "object")) return v.join(", ");
      if (typeof v === "object") return JSON.stringify(v);
      return String(v);
    };
    slot.append(
      sections.length
        ? h("div", { class: "config-grid" },
            sections.map(([name, values]) =>
              h("div", { class: "card" },
                h("div", { class: "card-hdr" }, h("span", { class: "title", text: label(name) })),
                h("table", {}, Object.entries(values).map(([k, v]) => h("tr", {}, h("td", { text: k }), h("td", { text: value(v) })))))))
        : h("div", { class: "dim", text: "no config" }),
    );
    return {};
  },
};

// a chart card: its title, each series' value as of the step picked, and the chart
function chartCard(page, panel, group, from, updates) {
  const series = group.series.map((s, i) => {
    const raw = seriesPoints(page.rows, s.key, from);
    const smoothed = smooth(raw, panel.smooth);
    return { ...s, color: SERIES[i % SERIES.length], points: smoothed, raw: smoothed === raw ? null : raw };
  });
  const single = series.length === 1;
  const values = series.map(() => h("b"));
  const showValues = () => series.forEach((s, i) => (values[i].textContent = fmt(page.valueAt(s.key))));
  showValues();
  const holder = h("div", { class: "chart-holder" });
  const card = h("div", { class: "card chart-card" },
    h("div", { class: "card-hdr" },
      h("span", { class: "title", text: label(group.name), title: group.name }),
      h("span", { class: "spacer" }),
      single && h("span", { class: "latest" }, values[0])),
    !single && h("div", { class: "legend" }, series.map((s, i) => h("span", { class: "key" }, h("i", { style: `background:${s.color}` }), s.name, values[i]))),
    holder);
  let chart = null;
  updates.push(() => {
    showValues();
    chart?.setMark(page.loc.step);
  });
  // drawn once the card is laid out, so the chart knows its width
  requestAnimationFrame(() => {
    if (!holder.isConnected) return;
    chart = lineChart(series, holder.clientWidth - 8, { log: !!panel.log, mark: page.loc.step, onPick: (s) => page.pickStep(s) });
    holder.replaceChildren(chart.el);
  });
  return card;
}

// a media card: one key's entries, the one shown as of the step picked (or picked
// here), drawn by the bundle's renderer for its type or the generic display
function mediaCard(page, key) {
  const hdr = h("div", { class: "card-hdr" });
  const attrs = h("div", { class: "media-attrs" });
  const body = h("div", { class: "media-body" });
  const el = h("div", { class: "card media-card" }, hdr, attrs, body);
  let entries = [];
  // an entry picked here, by index, or null to follow the page's step
  let picked = null;
  let shown = null;
  let module = null; // {path, handle} of the renderer drawing this card

  const pick = (i) => {
    picked = Math.max(0, Math.min(entries.length - 1, i));
    update(entries);
  };

  function update(list) {
    entries = list;
    const idx = picked ?? entryIndexAt(entries, page.loc.step);
    const entry = entries[idx];
    hdr.replaceChildren(
      h("span", { class: "title", text: label(key), title: key }),
      h("span", { class: "spacer" }),
      h("span", { class: "scrub" },
        h("button", { text: "‹", title: "previous", disabled: idx === 0, onclick: () => pick(idx - 1) }),
        h("span", { class: "pos", text: `step ${entry.step}` }),
        h("button", { text: "›", title: "next", disabled: idx === entries.length - 1, onclick: () => pick(idx + 1) }),
        h("button", { class: picked == null ? "on" : null, text: "follow", title: "show the entry at the page's step", onclick: () => { picked = null; update(entries); } })),
    );
    // swapping what's drawn restarts it, so only when the entry changes
    const id = `${entry.file}@${entry.time}`;
    if (shown === id) return;
    shown = id;
    draw(entry);
  }

  function draw(entry) {
    const path = page.layout.usable ? page.layout.renderers[entry.type] : null;
    attrs.hidden = !!path || !entry.attrs;
    attrs.textContent = entry.attrs ? JSON.stringify(entry.attrs) : "";
    if (path) {
      if (module?.path === path) {
        module.handle.update({ data: entry });
        return;
      }
      module?.handle.destroy();
      body.classList.remove("center");
      const frameHolder = h("div");
      body.replaceChildren(frameHolder);
      const handle = page.mount(frameHolder, {
        module: path,
        data: entry,
        onError: (message) => {
          if (shown !== `${entry.file}@${entry.time}`) return;
          const generic = h("div");
          body.replaceChildren(h("div", { class: "media-error", text: `${path} failed: ${message}` }), generic);
          module?.handle.destroy();
          module = null;
          genericView(generic, entry, page.data).catch((e) => generic.replaceChildren(h("div", { class: "media-error", text: String(e.message) })));
        },
      });
      module = { path, handle };
      return;
    }
    module?.handle.destroy();
    module = null;
    body.replaceChildren();
    genericView(body, entry, page.data).catch((e) => {
      if (shown === `${entry.file}@${entry.time}`) body.replaceChildren(h("div", { class: "media-error", text: `couldn't show ${entry.file}: ${e.message}` }));
    });
  }

  return { el, update, destroy: () => module?.handle.destroy() };
}

// ---------------------------------------------------------------- start

show();
