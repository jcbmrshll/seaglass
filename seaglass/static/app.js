// The basic frontend: a run list, a project list, and the pages that compare a
// project's runs (comparison.js) and draw a run (run-page.js). No framework: every view
// is plain DOM built with h(), and text that comes from a run only ever goes in as
// text. It polls.

import { h } from "./dom.js";
import { activity, ago, duration, fmt, progress, started, status, withUnit } from "./format.js";
import { declared, declaredList, headlines } from "./layout.js";
import { hideTip } from "./chart.js";
import { DEFAULT_SHOWN, runMatches, sortBy } from "./compare.js";
import { COMPARE_STATE, mountCompare } from "./comparison.js";
import { mountRunPage } from "./run-page.js";
import { closeNote } from "./note.js";

const VERSION = "0.3.0";
const RUNS_POLL_MS = 5000;

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

// ---------------------------------------------------------------- routing

let page = null;

function route() {
  const m = location.pathname.match(/^\/run\/([\w-]+)\/?$/);
  if (m) return { name: "run", id: m[1] };
  const p = location.pathname.match(/^\/project\/([^/]+)\/?$/);
  if (p) return { name: "project", project: decodeURIComponent(p[1]) };
  if (/^\/projects\/?$/.test(location.pathname)) return { name: "projects" };
  return { name: "list" };
}

export function go(path) {
  history.pushState(null, "", path);
  show();
}

function show() {
  const r = route();
  if (r.name === "run" && page instanceof RunPage && page.id === r.id) {
    page.locationChanged(location.search);
    return;
  }
  page?.destroy();
  hideTip();
  closeNote();
  const make = { run: () => new RunPage(r.id), project: () => new ProjectPage(r.project), projects: () => new ProjectList(), list: () => new RunList() };
  page = make[r.name]();
  // the header's link to the kind of page shown
  const section = r.name === "project" || r.name === "projects" ? "projects" : "runs";
  for (const a of document.querySelectorAll("#hdr [data-nav]")) a.classList.toggle("on", a.dataset.nav === section);
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
    if (!this.dead && !this.el.contains(document.activeElement)) this.render();
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

  render() {
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
        (!f.q || `${r.name} ${r.id} ${r.notes ?? ""} ${r.conclusions ?? ""}`.toLowerCase().includes(f.q.toLowerCase())),
    );
    const select = (key, name, options) =>
      h("label", {}, name, h("select", { onchange: (e) => this.setFilter(key, e.target.value) },
        h("option", { value: "", text: "all" }),
        options.map((o) => h("option", { value: o, text: o, selected: o === f[key] }))));
    const search = h("input", { type: "search", placeholder: "name, id, notes…", title: "words in a run's name, id, notes or conclusions", value: f.q || null, onchange: (e) => this.setFilter("q", e.target.value) });

    // each run's headline metrics, as it declared them, among what it logged
    const summaryOf = (r) => headlines(declaredList(r.declared), Object.keys(r.latest ?? {}));
    const unitOf = (r, k) => declared(declaredList(r.declared), k, "unit");
    // one project: a column per headline metric; several: the values in one column
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
          h("a", { class: "name", href: `/run/${r.id}`, "data-app": true, text: r.name, title: r.notes }),
          h("div", { class: "sub", text: activity(r, now) || r.id })),
        h("td", { class: "mono" }, h("a", { href: `/project/${encodeURIComponent(r.project)}`, "data-app": true, text: r.project, title: "compare the project's runs" })),
        h("td", {}, (r.tags ?? []).map((t) => h("span", { class: "chip", text: t }))),
        h("td", { class: "mono" }, git ? [git.branch ?? "", git.dirty ? h("span", { class: "chip dirty", text: "dirty", title: "uncommitted changes" }) : null] : "–"),
        h("td", { class: "mono", text: started(r.created) }),
        h("td", { class: "mono", text: r.status === "running" ? `${duration(end - r.created)} · ${ago(r.updated, now)}` : duration(end - r.created) }),
        h("td", { class: "num", text: progress(r) }),
        f.project
          ? columns.map((c) => h("td", { class: "num", text: summary.includes(c) ? withUnit(fmt(r.latest[c]), unitOf(r, c)) : "" }))
          : h("td", {}, summary.slice(0, 4).map((k) => h("span", { class: "kv" }, `${k} `, h("b", { text: withUnit(fmt(r.latest[k]), unitOf(r, k)) }), "  "))),
      );
    });
    this.el.replaceChildren(
      h("div", { class: "filters" },
        h("h1", { text: "Runs" }),
        select("project", "project", projects),
        select("tag", "tag", tags),
        select("branch", "branch", branches),
        search,
        h("span", { class: "count", text: `${shown.length} of ${runs.length}` }),
        f.project && h("a", { href: `/project/${encodeURIComponent(f.project)}`, "data-app": true, text: "compare runs →" })),
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

// ---------------------------------------------------------------- project list

// every project on the server, most recently active first, each opening its page
class ProjectList {
  constructor() {
    document.title = "projects · seaglass";
    main.className = "";
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
    let runs;
    try {
      runs = await api("/api/runs");
      setConnected(true);
    } catch {
      setConnected(false);
      if (this.runs != null) return;
      runs = [];
    }
    if (this.dead) return;
    this.runs = runs;
    this.render();
  }

  render() {
    const now = Date.now() / 1000;
    // runs come newest first, so a project's first run is its newest
    const projects = new Map();
    for (const r of this.runs) {
      let p = projects.get(r.project);
      if (!p) projects.set(r.project, (p = { name: r.project, runs: 0, running: 0, updated: 0, newest: r }));
      p.runs++;
      if (status(r, now) === "running") p.running++;
      p.updated = Math.max(p.updated, r.updated);
    }
    const rows = sortBy([...projects.values()], (p) => p.updated, true).map((p) => {
      const href = `/project/${encodeURIComponent(p.name)}`;
      return h("tr", { class: "run", onclick: (e) => !e.target.closest("a") && go(href) },
        h("td", {}, h("a", { class: "name", href, "data-app": true, text: p.name })),
        h("td", { class: "num", text: String(p.runs) }),
        h("td", {}, p.running > 0 && h("div", { class: "status" }, h("span", { class: "dot running" }), `${p.running} running`)),
        h("td", { class: "mono", text: ago(p.updated, now) }),
        h("td", {},
          h("a", { class: "mono", href: `/run/${p.newest.id}`, "data-app": true, text: p.newest.name }),
          h("span", { class: "sub", text: `  ${started(p.newest.created)}` })));
    });
    this.el.replaceChildren(
      h("div", { class: "filters" },
        h("h1", { text: "Projects" }),
        h("span", { class: "count", text: `${projects.size} projects · ${this.runs.length} runs` })),
      projects.size
        ? h("table", { class: "runs" },
            h("tr", {}, ["project", "runs", "", "last active", "newest run"].map((t, i) => h("th", { class: i === 1 ? "num" : null, text: t }))),
            rows)
        : h("div", { class: "empty" },
            h("h1", { text: "No projects yet" }),
            h("p", { text: "A project appears here with its first run." })),
    );
  }
}


// ---------------------------------------------------------------- project page

// a project's runs side by side (comparison.js), the runs down the side, each turned
// on and off in the charts; expanded, the side is the whole table and the charts step
// aside. What is shown, the sort and the chart options live in the page's address.
class ProjectPage {
  constructor(project) {
    this.project = project;
    document.title = `${project} · seaglass`;
    main.className = "";
    this.runs = null;

    const q = new URLSearchParams(location.search);
    const filter = h("input", {
      type: "search", placeholder: "filter runs", value: q.get("q"), title: "words in a run's name, id, tags, notes or conclusions",
      oninput: (e) => {
        this.setParams({ q: e.target.value || null });
        this.compare.set({ q: e.target.value || null });
      },
    });
    const pick = (text, title, ids) => h("button", { text, title, onclick: () => this.setShown(ids()) });
    this.countEl = h("span", { class: "count" });
    // every project on the server, to switch between
    this.projectSelect = h("select", {
      title: "compare another project's runs",
      onchange: (e) => go(`/project/${encodeURIComponent(e.target.value)}`),
    }, h("option", { value: project, text: project }));
    this.expandButton = h("button", {
      class: "expand", onclick: () => this.setExpanded(!this.expanded()),
    });
    const sideBar = h("div", { class: "side-tools" },
      filter,
      h("div", { class: "scrub" },
        h("span", { class: "dim", text: "show" }),
        pick("all", "every run the filter matches", () => [...this.shownIds(), ...(this.runs ?? []).filter((r) => runMatches(r, this.param("q") ?? "")).map((r) => r.id)]),
        pick("none", "no runs", () => []),
        pick(`newest ${DEFAULT_SHOWN}`, `the ${DEFAULT_SHOWN} newest runs`, () => (this.runs ?? []).slice(0, DEFAULT_SHOWN).map((r) => r.id))),
      h("div", { class: "side-count" }, this.countEl, h("span", { class: "spacer" }), this.expandButton));

    const tableEl = h("div", { class: "table-wrap" });
    const chartsEl = h("section", { class: "charts-side" });
    this.layoutEl = h("div", { class: "project-layout" },
      h("aside", { class: "runs-side" }, sideBar, tableEl),
      chartsEl);
    this.el = h("div", { class: "page wide" },
      h("div", { class: "filters" },
        h("h1", { text: project }),
        h("label", {}, "project", this.projectSelect),
        h("span", { class: "spacer" }),
        h("a", { href: `/?project=${encodeURIComponent(project)}`, "data-app": true, text: "run list" })),
      this.layoutEl);
    main.replaceChildren(this.el);
    this.applyLayout();
    main.scrollTop = 0;

    const expanded = this.expanded();
    this.compare = mountCompare({ table: tableEl, charts: chartsEl }, {
      state: Object.fromEntries(COMPARE_STATE.map((k) => [k, q.get(k)])),
      wide: expanded,
      chartsHidden: expanded,
      empty: () => h("div", { class: "empty" }, h("h1", { text: "No runs yet" }), h("p", { text: `Runs logged to the project ${project} show up here.` })),
      hooks: {
        state: (changes) => this.setParams(changes),
        toggle: (id) => this.toggle(id),
        counted: ({ plotted, matched, total }) => (this.countEl.textContent = total ? `${plotted} shown · ${matched} of ${total} runs` : ""),
      },
    });
    this.poll();
    this.timer = setInterval(() => document.visibilityState === "visible" && this.poll(), RUNS_POLL_MS);
  }

  destroy() {
    this.dead = true;
    clearInterval(this.timer);
    this.compare.destroy();
  }

  // ------------------------------------------------------------ the address

  param(key) {
    return new URLSearchParams(location.search).get(key);
  }

  // set (or, for null, drop) parameters
  setParams(changes) {
    const q = new URLSearchParams(location.search);
    for (const [k, v] of Object.entries(changes)) {
      if (v == null) q.delete(k);
      else q.set(k, v);
    }
    const s = q.toString();
    history.replaceState(null, "", `/project/${encodeURIComponent(this.project)}${s ? `?${s}` : ""}`);
  }

  // whether the side is expanded into the whole table
  expanded() {
    return this.param("table") === "1";
  }

  setExpanded(on) {
    this.setParams({ table: on ? "1" : null });
    this.applyLayout();
    this.compare.update({ wide: on, chartsHidden: on });
  }

  applyLayout() {
    const on = this.expanded();
    this.layoutEl.classList.toggle("expanded", on);
    this.expandButton.textContent = on ? "← charts" : "table →";
    this.expandButton.title = on ? "back to the charts" : "every run's config and latest metrics, as a table";
  }

  // ------------------------------------------------------------ which runs

  // the runs shown in the charts: those picked, or the newest few if none were
  shownIds() {
    const picked = this.param("runs");
    if (picked == null) return (this.runs ?? []).slice(0, DEFAULT_SHOWN).map((r) => r.id);
    return picked.split(",").filter(Boolean);
  }

  setShown(ids) {
    if (this.runs == null) return;
    const known = new Set(this.runs.map((r) => r.id));
    this.setParams({ runs: [...new Set(ids)].filter((id) => known.has(id)).join(",") });
    this.compare.update({ shown: this.shownIds() });
  }

  toggle(id) {
    const ids = this.shownIds();
    this.setShown(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]);
  }

  // ------------------------------------------------------------ reading

  async poll() {
    if (this.polling || this.dead) return;
    this.polling = true;
    try {
      const all = await api("/api/runs");
      setConnected(true);
      this.renderProjects(all);
      this.runs = all.filter((r) => r.project === this.project);
    } catch {
      setConnected(false);
      this.runs ??= [];
    }
    try {
      if (!this.dead) await this.compare.update({ runs: this.runs, shown: this.shownIds() });
    } finally {
      this.polling = false;
    }
  }

  renderProjects(all) {
    if (document.activeElement === this.projectSelect) return;
    const counts = new Map([[this.project, 0]]);
    for (const r of all) counts.set(r.project, (counts.get(r.project) ?? 0) + 1);
    const names = [...counts.keys()].sort();
    this.projectSelect.replaceChildren(...names.map((p) =>
      h("option", { value: p, text: `${p} (${counts.get(p)})`, selected: p === this.project })));
    this.projectSelect.disabled = names.length < 2;
  }
}

// ---------------------------------------------------------------- run page

// a run's page (run-page.js), at /run/<id>?<location>
class RunPage {
  constructor(id) {
    this.id = id;
    main.className = "";
    this.handle = mountRunPage(main, {
      id,
      search: location.search,
      frontend: `seaglass-basic/${VERSION}`,
      hooks: {
        connected: setConnected,
        run: (run) => (document.title = `${run.name} · seaglass`),
      },
    });
    // frames follow the browser's light or dark
    this.dark = matchMedia("(prefers-color-scheme: dark)");
    this.onTheme = () => this.handle.themeChanged();
    this.dark.addEventListener("change", this.onTheme);
  }

  locationChanged(search) {
    this.handle.locationChanged(search);
  }

  destroy() {
    this.dark.removeEventListener("change", this.onTheme);
    this.handle.destroy();
  }
}

// ---------------------------------------------------------------- start

show();
