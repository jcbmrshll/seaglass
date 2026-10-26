// What an entry looks like with no renderer for its type (SPEC.md §8.3): arrays as a
// table, JSON as a tree, images and video as they are, anything else as a link.

import { h } from "./dom.js";
import { fmt } from "./format.js";

const IMAGES = /\.(png|gif|jpe?g|webp|svg)$/i;
const VIDEO = /\.(mp4|webm)$/i;

// draw entry into body; files come from `data` ({url(path), arrays(path), json(path)})
export async function genericView(body, entry, data) {
  const file = entry.file;
  body.classList.remove("center");
  if (file.endsWith(".npz")) {
    body.replaceChildren(arraysTable(await data.arrays(file)));
  } else if (file.endsWith(".json")) {
    body.replaceChildren(h("div", { class: "tree" }, tree(await data.json(file), 0)));
  } else if (IMAGES.test(file)) {
    body.classList.add("center");
    body.replaceChildren(h("img", { src: data.url(file), alt: `${entry.key} at step ${entry.step}` }));
  } else if (VIDEO.test(file)) {
    body.classList.add("center");
    body.replaceChildren(h("video", { src: data.url(file), controls: true, loop: true, muted: true, autoplay: true }));
  } else {
    body.classList.add("center");
    body.replaceChildren(h("a", { href: data.url(file), download: file.split("/").pop(), text: `download ${file}` }));
  }
}

// ---------------------------------------------------------------- arrays

const PREVIEW = 2000;

function stats(a) {
  let min = Infinity, max = -Infinity, sum = 0, n = 0, nan = 0;
  for (const raw of a.data) {
    const v = Number(raw);
    if (!Number.isFinite(v)) {
      nan++;
      continue;
    }
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    n++;
  }
  if (!n) return nan ? `${nan} non-finite` : "";
  return `min ${fmt(min)} · mean ${fmt(sum / n)} · max ${fmt(max)}${nan ? ` · ${nan} non-finite` : ""}`;
}

// the values of an array, nested by its shape, at most PREVIEW of them
export function formatArray(a, limit = PREVIEW) {
  const { shape, data } = a;
  const num = (v) => (typeof v === "bigint" ? v.toString() : Number.isInteger(v) ? String(v) : (+v.toPrecision(5)).toString());
  if (!shape.length) return num(data[0]);
  let count = 0;
  const rec = (offset, dim, indent) => {
    const n = shape[dim];
    const stride = shape.slice(dim + 1).reduce((x, y) => x * y, 1);
    const parts = [];
    for (let i = 0; i < n; i++) {
      if (count >= limit) {
        parts.push("…");
        break;
      }
      if (dim === shape.length - 1) {
        parts.push(num(data[offset + i]));
        count++;
      } else parts.push(rec(offset + i * stride, dim + 1, indent + " "));
    }
    const sep = dim === shape.length - 1 ? ", " : `,\n${indent} `;
    return `[${parts.join(sep)}]`;
  };
  return rec(0, 0, "");
}

function arraysTable(arrays) {
  const rows = Object.entries(arrays).map(([name, a]) => {
    const text = formatArray(a);
    const values = text.length < 80 && !text.includes("\n")
      ? h("span", { text })
      : h("details", {}, h("summary", { text: stats(a) || "values" }), h("pre", { text }));
    return h("tr", {}, h("td", { class: "name", text: name }), h("td", { text: a.dtype }), h("td", { text: `(${a.shape.join(", ")})` }), h("td", { class: "values" }, values));
  });
  return h("table", { class: "arrays" }, h("tr", {}, ["array", "dtype", "shape", "values"].map((t) => h("th", { text: t }))), rows);
}

// ---------------------------------------------------------------- json

function leaf(v) {
  if (v === null) return h("span", { class: "z", text: "null" });
  if (typeof v === "string") return h("span", { class: "s", text: JSON.stringify(v) });
  if (typeof v === "number" || typeof v === "boolean") return h("span", { class: "n", text: String(v) });
  return h("span", { text: String(v) });
}

// a JSON value as a tree; containers below depth 2 start folded
export function tree(v, depth) {
  if (v === null || typeof v !== "object") return h("div", { class: "leaf" }, leaf(v));
  const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
  const label = Array.isArray(v) ? `[${v.length}]` : `{${entries.length}}`;
  // short arrays of plain values on one line
  if (Array.isArray(v) && v.length <= 32 && v.every((x) => x === null || typeof x !== "object")) {
    return h("div", { class: "leaf" }, "[", v.flatMap((x, i) => (i ? [", ", leaf(x)] : [leaf(x)])), "]");
  }
  return h(
    "details",
    { open: depth < 2 },
    h("summary", { text: label }),
    entries.map(([k, x]) => {
      const child = tree(x, depth + 1);
      if (child.tagName === "DETAILS") {
        child.querySelector("summary").prepend(h("span", { class: "k", text: `${k}: ` }));
        return child;
      }
      return h("div", { class: "leaf" }, h("span", { class: "k", text: `${k}: ` }), ...child.childNodes);
    }),
  );
}

