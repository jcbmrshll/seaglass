// A run's page: its head, notes and conclusions, a step bar, and the run's layout
// (SPEC.md §8) drawn with its bundle's modules, each in a sandboxed frame (§7). It
// polls the run, reading metrics and media incrementally. It depends on nothing of
// the page around it, so another app can draw a run with it: mountRunPage.

import { h } from "./dom.js";
import { activity, duration, fmt, progress, started, status, withUnit } from "./format.js";
import {
  CONTRACT, applyNavigate, chartLog, chartNotes, declared, declaredList, describe, entriesByKey, entryIndexAt, locationQuery, matchNames,
  mediaColumns, metricNames, parseLocation, resolveLayout, seriesPoints, smooth, splitGroups, tileNames, valueAt,
} from "./layout.js";
import { SERIES, hideTip, lineChart } from "./chart.js";
import { configText } from "./compare.js";
import { currentTheme, mountModule } from "./host.js";
import { genericView } from "./generic.js";
import { readNpz } from "./npz.js";
import { closeNote, noteButton } from "./note.js";

const POLL_MS = 2000;
// the windows offered over the charts, in steps
const CHART_WINDOWS = [50, 200, 1000];
const FILE_CACHE = 64;

// where a run page reads and links to, as seaglass's own server has them; null for a
// link leaves it out
export const DEFAULT_PATHS = {
  // the API's root (SPEC.md §5)
  api: "/api",
  // the bundles' root: <bundles>/<hash>/<path>
  bundles: "/bundles",
  // a run page's address, written as the location changes (§7.6)
  run: (id) => `/run/${id}`,
  // where the project crumb and a tag chip link to
  project: (name) => `/project/${encodeURIComponent(name)}`,
  tag: (tag) => `/?tag=${encodeURIComponent(tag)}`,
  // the run list, which a missing run links back to
  runs: "/",
};

// Draw run `id` in `container`, at the location `search` (the address's query) holds.
//
// - paths: DEFAULT_PATHS to change
// - theme(): the theme a module's frame gets (§7.5), currentTheme() by default
// - frontend: what host.info says this frontend is
// - prefPrefix: where host.setPref keeps a project's prefs in localStorage
// - hooks, each optional:
//   - head(run): nodes to add to the head's crumbs, after them, or {before, after};
//     called each time the head is drawn
//   - run(run): the run, each time it's read
//   - connected(ok): whether the server answered the last read
//   - textKeydown(event): a key pressed in the notes' or conclusions' box, after the
//     page's own (ctrl+enter saves, Escape cancels); stopPropagation keeps it there
//
// Returns {locationChanged(search), themeChanged(), redrawHead(), resize(), destroy()}.
export function mountRunPage(container, options) {
  const page = new RunPage(container, options);
  return {
    // the address changed under the page (back, forward)
    locationChanged: (search) => page.locationChanged(parseLocation(search)),
    // the theme changed: frames get it again
    themeChanged: () => page.broadcast({ theme: page.theme() }),
    redrawHead: () => page.run && page.head && page.renderHead(),
    // the container changed size, the window aside
    resize: () => page.resize(),
    destroy: () => page.destroy(),
  };
}

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) {
    const err = new Error(`${res.status} ${path}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// POST a JSON body; a refusal throws with the server's reason
async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const reason = await res.json().then((b) => b.error, () => null);
    throw new Error(reason ?? `${res.status} ${path}`);
  }
  return res.json();
}

const enc = (path) => path.split("/").map(encodeURIComponent).join("/");
const label = (name) => name.replaceAll("_", " ");
const sep = () => h("span", { class: "sep", text: "·" });

// each bundle's layout.json, once: null if the server doesn't have it
const layouts = new Map();
function bundleLayout(root, hash) {
  if (!hash) return Promise.resolve(null);
  const url = `${root}/${hash}/layout.json`;
  if (!layouts.has(url)) {
    layouts.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return layouts.get(url);
}

// ---------------------------------------------------------------- the page

// what the run's page lets the reader write about it, under its head: what it is
// testing and why (SPEC.md §4.8), and what it showed (§4.9)
const TEXTS = {
  notes: { what: "notes", title: "what this run is testing and why", placeholder: "what this run is testing, and why" },
  conclusions: {
    what: "conclusions", label: "conclusions", title: "what this run showed: what was learned, and what to try next",
    placeholder: "what this run showed: what was learned, and what to try next",
  },
};

class RunPage {
  constructor(container, { id, search = "", paths = {}, theme = () => currentTheme(), frontend = "seaglass-basic", prefPrefix = "seaglass:pref:", hooks = {} }) {
    this.container = container;
    this.id = id;
    this.paths = { ...DEFAULT_PATHS, ...paths };
    this.theme = theme;
    this.frontend = frontend;
    this.prefPrefix = prefPrefix;
    this.hooks = hooks;
    this.run = null;
    this.rows = [];
    this.metricsNext = 0;
    this.media = [];
    this.mediaNext = 0;
    this.loc = parseLocation(search);
    this.panels = [];
    this.modules = new Set();
    this.files = new Map();
    this.chartWindow = Number(localStorage.getItem("seaglass:chartWindow")) || null;
    this.host = this.makeHost();
    // sg.css draws what's inside
    container.classList.add("sg");
    container.replaceChildren(h("div", { class: "empty" }, h("p", { class: "dim", text: "loading run…" })));
    container.scrollTop = 0;
    this.onResize = () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.resize(), 150);
    };
    addEventListener("resize", this.onResize);
    this.start();
  }

  destroy() {
    this.dead = true;
    clearInterval(this.timer);
    clearTimeout(this.resizeTimer);
    removeEventListener("resize", this.onResize);
    this.clearPanels();
    this.container.classList.remove("fill");
  }

  resize() {
    this.panels.forEach((p) => p.resize?.());
  }

  connected(ok) {
    this.hooks.connected?.(ok);
  }

  // the run's API, from its root: /api/runs/<id>/…
  url(rest = "") {
    return `${this.paths.api}/runs/${this.id}${rest}`;
  }

  clearPanels() {
    for (const p of this.panels) p.destroy?.();
    this.panels = [];
    this.modules.clear();
  }

  async start() {
    try {
      const [run, metrics, media] = await Promise.all([
        api(this.url()),
        api(this.url("/metrics?since=0")),
        api(this.url("/media?since=0")),
      ]);
      this.run = run;
      this.declared = declaredList(run.declared);
      this.rows = metrics.rows;
      this.metricsNext = metrics.next;
      this.media = media.rows;
      this.mediaNext = media.next;
      this.connected(true);
    } catch (e) {
      if (this.dead) return;
      const home = this.paths.runs;
      if (e.status === 404) this.container.replaceChildren(h("div", { class: "empty" }, h("h1", { text: "No such run" }), home && h("p", {}, h("a", { href: home, "data-app": true, text: "all runs" }))));
      else {
        this.connected(false);
        this.container.replaceChildren(h("div", { class: "empty" }, h("h1", { text: "Couldn't load this run" }), h("p", { class: "dim", text: e.message })));
      }
      return;
    }
    this.hooks.run?.(this.run);
    const raw = await bundleLayout(this.paths.bundles, this.run.bundle);
    if (this.dead) return;
    this.layout = resolveLayout(raw);
    if (this.run.bundle && !raw) this.layout.note = `its views (bundle ${this.run.bundle.slice(0, 12)}…) aren't on this server`;
    this.build();
    this.timer = setInterval(() => document.visibilityState === "visible" && this.poll(), POLL_MS);
  }

  async poll() {
    if (this.polling || this.dead) return;
    this.polling = true;
    try {
      const [run, metrics, media] = await Promise.all([
        api(this.url()),
        api(this.url(`/metrics?since=${this.metricsNext}`)),
        api(this.url(`/media?since=${this.mediaNext}`)),
      ]);
      if (this.dead) return;
      this.connected(true);
      const changed = run.updated !== this.run.updated || run.status !== this.run.status;
      const textsChanged = Object.keys(TEXTS).filter((f) => run[f] !== this.run[f]);
      // declarations can come after the run starts, or be changed after it ends
      const declaredChanged = JSON.stringify(run.declared) !== JSON.stringify(this.run.declared);
      this.run = run;
      if (declaredChanged) this.declared = declaredList(run.declared);
      this.metricsNext = metrics.next;
      this.mediaNext = media.next;
      this.rows.push(...metrics.rows);
      this.media.push(...media.rows);
      this.hooks.run?.(run);
      this.renderHead();
      textsChanged.forEach((f) => this.renderText(f));
      if (metrics.rows.length) this.stepBar.update();
      if (metrics.rows.length || declaredChanged) this.panels.forEach((p) => p.metrics?.());
      if (media.rows.length) this.stepBar.update();
      if (media.rows.length || declaredChanged) this.panels.forEach((p) => p.media?.());
      if (changed) this.broadcast({ run });
    } catch {
      this.connected(false);
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
    const url = `${this.paths.run(this.id)}${locationQuery(loc)}`;
    if (push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
    this.applied(before);
  }

  // the address changed under the page (back, forward)
  locationChanged(loc) {
    const before = this.loc;
    this.loc = loc;
    // not drawn yet: drawn at loc when it is
    if (!this.stepBar) return;
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
    if (!req || typeof req !== "object") throw new Error("navigate takes {tab, step, state, replace}");
    if ("tab" in req && req.tab != null && !this.layout.tabs.some((t) => t.title === req.tab)) throw new Error(`no tab ${req.tab}`);
    const next = applyNavigate(this.loc, req);
    // a new tab or view state is somewhere to come back to, unless the module says
    // it isn't; a step isn't
    const push = !req.replace && (("tab" in req && next.tab !== this.loc.tab) || "state" in req);
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
    const run = () => this.url();
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
    const pref = (key) => `${this.prefPrefix}${this.run.project}:${str(key, "a pref key")}`;
    return {
      info: async () => ({ contract: CONTRACT, frontend: this.frontend }),
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
      theme: async () => this.theme(),
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
      url: (path) => this.url(`/files/${enc(path)}`),
      json: (path) => this.host.json(path),
      arrays: (path) => this.host.arrays(path),
    };
  }

  mount(container, { module, data, fill = false, onError }) {
    const url = new URL(`${this.paths.bundles}/${this.run.bundle}/${enc(module)}`, location.href).href;
    const m = mountModule(container, { module: url, data, run: this.run, host: this.host, theme: this.theme(), fill, onError });
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
    // apart from the head, which is drawn again on every poll, so an edit isn't lost
    this.textEls = Object.fromEntries(Object.keys(TEXTS).map((f) => [f, h("div", { class: `text-field ${f}` })]));
    this.editing = new Set();
    this.tabsEl = h("nav", { class: "tabs" });
    this.stepBar = stepBar(this);
    this.windowEl = h("span", { class: "scrub" });
    this.body = h("div", { class: "rows" });
    this.pageEl = h("div", { class: "page" }, this.head, h("div", { class: "texts" }, Object.values(this.textEls)), h("div", { class: "topbar" }, this.tabsEl, this.stepBar.el, h("span", { class: "spacer" }), this.windowEl), this.body);
    this.container.replaceChildren(this.pageEl);
    this.renderHead();
    Object.keys(TEXTS).forEach((f) => this.renderText(f));
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
    const project = this.paths.project?.(run.project);
    const tag = (t) => {
      const href = this.paths.tag?.(t);
      return href ? h("a", { class: "chip", href, "data-app": true, text: t }) : h("span", { class: "chip", text: t });
    };
    // what the embedding page adds: nodes after the crumbs, or {before, after}
    const extra = this.hooks.head?.(run) ?? null;
    const { before = null, after = null } = extra && !Array.isArray(extra) && !(extra instanceof Node) ? extra : { after: extra };
    this.head.replaceChildren(
      h("div", { class: "crumbs" },
        before,
        project ? h("a", { href: project, "data-app": true, text: run.project, title: "compare the project's runs" }) : h("span", { text: run.project }),
        h("span", { class: "id", text: run.id }),
        after),
      h("h1", { text: run.name }),
      h("div", { class: "meta" },
        h("span", { class: `dot ${st}` }), h("span", { text: st }),
        activity(run, now) && [sep(), h("span", { class: "doing", text: activity(run, now) })],
        sep(), h("span", { text: `started ${started(run.created)}` }),
        sep(), h("span", { text: duration(end - run.created) }),
        run.step != null && [sep(), h("span", { text: progress(run) })],
        (run.tags ?? []).length > 0 && [sep(), run.tags.map(tag)]),
      h("div", { class: "prov" },
        git && h("span", { title: git.commit }, `${git.branch ?? "?"} @ ${String(git.commit).slice(0, 8)}`, git.dirty ? h("span", { class: "chip dirty", text: "dirty" }) : null),
        prov.host && h("span", { text: prov.host }),
        argv && h("span", { class: "argv", title: argv, text: `$ ${argv}` }),
        prov.cwd && h("span", { class: "dim", text: prov.cwd })),
      this.layout.note ? h("div", { class: "note", text: `drawn with the default layout: ${this.layout.note}` }) : "",
    );
  }

  // the run's notes or conclusions (TEXTS), which the reader can write here
  renderText(field) {
    if (this.editing.has(field)) return;
    const { what, title, label } = TEXTS[field];
    const text = this.run[field];
    const el = this.textEls[field];
    el.classList.toggle("none", !text);
    el.replaceChildren(
      text ? h("div", { class: "text" }, label && h("div", { class: "label", text: label }), text) : "",
      h("button", { class: "edit", text: `${text ? "edit" : "add"} ${what}`, title, onclick: () => this.editText(field) }),
    );
  }

  editText(field) {
    this.editing.add(field);
    const { placeholder } = TEXTS[field];
    const el = this.textEls[field];
    const box = h("textarea", { rows: 4, maxlength: 10000, placeholder });
    box.value = this.run[field] ?? "";
    const error = h("span", { class: "error" });
    const close = () => {
      this.editing.delete(field);
      this.renderText(field);
    };
    const save = async () => {
      const text = box.value.trim() || null;
      saveButton.disabled = true;
      try {
        await post(this.url(`/${field}`), { [field]: text });
        if (this.dead) return;
        this.run = { ...this.run, [field]: text };
        close();
      } catch (e) {
        error.textContent = `not saved: ${e.message}`;
        saveButton.disabled = false;
      }
    };
    const saveButton = h("button", { class: "on", text: "save", onclick: save });
    box.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
      // the embedding page's say over what else the key does there
      this.hooks.textKeydown?.(e);
    });
    el.classList.remove("none");
    el.replaceChildren(box,
      h("div", { class: "actions" },
        saveButton, h("button", { text: "cancel", onclick: close }),
        h("span", { class: "dim", text: "ctrl+enter saves, esc cancels" }), error));
    box.focus();
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
    closeNote();
    const tab = this.layout.tabs[this.tabIndex()];
    const fill = !!tab.panel;
    this.container.classList.toggle("fill", fill);
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
      const names = tileNames(panel, page.declared, metricNames(page.rows));
      el.replaceChildren(...names.map((k) => {
        const unit = declared(page.declared, k, "unit");
        return h("div", { class: "tile" },
          h("div", { class: "lab" }, h("span", { text: label(k), title: k }), noteButton(`tile:${k}`, describe(page.declared, k))),
          h("div", { class: "val" }, fmt(page.valueAt(k)), unit && h("span", { class: "unit", text: ` ${unit}` })));
      }));
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
        ? splitGroups(names, panel.groups)
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
    const columns = mediaColumns(panel);
    if (columns) {
      el.classList.add("cols");
      el.style.setProperty("--cols", columns);
    }
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
    slot.append(
      sections.length
        ? h("div", { class: "config-grid" },
            sections.map(([name, values]) =>
              h("div", { class: "card" },
                h("div", { class: "card-hdr" }, h("span", { class: "title", text: label(name) })),
                h("table", {}, Object.entries(values).map(([k, v]) => h("tr", {}, h("td", { text: k }), h("td", { text: configText(v) })))))))
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
    const unit = declared(page.declared, s.key, "unit");
    return { ...s, color: SERIES[i % SERIES.length], points: smoothed, raw: smoothed === raw ? null : raw, unit };
  });
  const single = series.length === 1;
  const values = series.map(() => h("b"));
  const showValues = () => series.forEach((s, i) => (values[i].textContent = withUnit(fmt(page.valueAt(s.key)), s.unit)));
  showValues();
  const holder = h("div", { class: "chart-holder" });
  const card = h("div", { class: "card chart-card" },
    h("div", { class: "card-hdr" },
      h("span", { class: "title", text: label(group.name), title: group.name }),
      noteButton(`chart:${group.name}:${group.series.map((s) => s.key).join(",")}`, chartNotes(page.declared, group)),
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
    chart = lineChart(series, holder.clientWidth - 8, { log: chartLog(panel, page.declared, series.map((s) => s.key)), mark: page.loc.step, onPick: (s) => page.pickStep(s) });
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
      noteButton(`media:${key}`, describe(page.declared, key)),
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
