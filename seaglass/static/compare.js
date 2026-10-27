// The logic the project page compares runs with, kept free of the DOM so it can be
// tested without a browser.

// how many runs the project page shows when nobody has picked any
export const DEFAULT_SHOWN = 10;
// colour slots: the six series colours solid, then dashed
export const SLOTS = 12;

// a config as one level: {"opt": {"lr": 1}} → {"opt.lr": 1}; arrays are values
export function flattenConfig(config, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(config ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length) flattenConfig(v, key, out);
    else out[key] = v;
  }
  return out;
}

// the keys, in the order first seen, whose values tell the configs apart: every key
// when there is only one config to look at
export function configColumns(configs) {
  const keys = [];
  const seen = new Set();
  for (const c of configs) {
    for (const k of Object.keys(c)) {
      if (seen.has(k)) continue;
      seen.add(k);
      keys.push(k);
    }
  }
  if (configs.length < 2) return keys;
  return keys.filter((k) => new Set(configs.map((c) => JSON.stringify(c[k] ?? null))).size > 1);
}

// a config value as a table cell shows it
export function configText(v) {
  if (v == null) return "–";
  if (Array.isArray(v) && v.every((x) => x == null || typeof x !== "object")) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// "-loss" → {key: "loss", desc: true}
export function parseSort(text) {
  if (!text) return { key: "created", desc: true };
  return text.startsWith("-") ? { key: text.slice(1), desc: true } : { key: text, desc: false };
}

// numbers before strings, missing values last whichever way the sort goes
export function compareValues(a, b, desc = false) {
  const missing = (v) => v == null || (typeof v === "number" && Number.isNaN(v));
  if (missing(a) || missing(b)) return missing(a) - missing(b);
  let c;
  if (typeof a === "number" && typeof b === "number") c = a - b;
  else if (typeof a === "number") c = -1;
  else if (typeof b === "number") c = 1;
  else c = String(a).localeCompare(String(b), "en", { numeric: true });
  return desc ? -c : c;
}

export function sortBy(items, valueOf, desc = false) {
  return [...items].sort((a, b) => compareValues(valueOf(a), valueOf(b), desc));
}

// colour slots for the runs shown: a run keeps its slot while it stays shown, and a
// new one takes the lowest slot free, so showing or hiding a run never repaints the
// others. Past SLOTS runs, slots repeat.
export function assignSlots(prev, ids) {
  const next = new Map();
  for (const id of ids) if (prev.has(id)) next.set(id, prev.get(id));
  const used = new Set(next.values());
  ids.forEach((id, i) => {
    if (next.has(id)) return;
    let slot = 0;
    while (slot < SLOTS && used.has(slot)) slot++;
    if (slot === SLOTS) slot = i % SLOTS;
    used.add(slot);
    next.set(id, slot);
  });
  return next;
}

// whether a run matches the page's filter: words, each in its name, id or tags
export function runMatches(run, q) {
  const text = `${run.name} ${run.id} ${(run.tags ?? []).join(" ")}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => text.includes(w));
}
