// Line charts of metrics against step, drawn as SVG, and the page's tooltip.

import { h } from "./dom.js";
import { fmt, fmtTick } from "./format.js";
import { logTicks, niceTicks } from "./layout.js";

export const SERIES = [1, 2, 3, 4, 5, 6].map((i) => `var(--sg-s${i})`);
const H = 150;

let tip = null;
export function showTip(x, y, ...children) {
  tip ??= document.getElementById("tip");
  tip.replaceChildren(...children.filter((c) => c != null && c !== false));
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const left = x + 14 + r.width > innerWidth ? x - 14 - r.width : x + 14;
  const top = Math.min(innerHeight - r.height - 4, Math.max(4, y - r.height / 2));
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
export function hideTip() {
  if (tip) tip.hidden = true;
}

// A chart of series [{name, color, points: [[step, value]], raw?: points}] `width` wide.
// `raw` (the unsmoothed points) is drawn faint under the line. A dashed mark shows
// `mark` (the step picked), and a click picks the nearest step with onPick(step).
// Returns {el, setMark(step)}.
export function lineChart(series, width, { log = false, mark = null, onPick = null } = {}) {
  const W = Math.max(width, 200);
  const svg = h("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  const ok = (y) => y != null && Number.isFinite(y) && (!log || y > 0);
  const all = series.flatMap((s) => [...s.points, ...(s.raw ?? [])]);
  const ys = all.map((p) => p[1]).filter(ok);
  if (!ys.length) return { el: svg, setMark() {} };

  const xs = all.map((p) => p[0]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const yt = log ? logTicks(Math.min(...ys), Math.max(...ys)) : niceTicks(Math.min(...ys), Math.max(...ys), 3);
  // room for the widest y label (9px mono is ~5.5px a character)
  const labelW = Math.max(...yt.map((t) => fmtTick(t).length)) * 5.5;
  const pad = { l: Math.max(28, labelW + 12), r: 10, t: 10, b: 18 };
  const f = log ? Math.log10 : (y) => y;
  const y0 = f(yt[0]), y1 = f(yt[yt.length - 1]);
  const sx = (x) => pad.l + (x1 === x0 ? 0.5 : (x - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const sy = (y) => pad.t + (1 - (f(y) - y0) / (y1 - y0)) * (H - pad.t - pad.b);

  for (const t of yt) {
    svg.append(
      h("line", { class: "grid", x1: pad.l, x2: W - pad.r, y1: sy(t), y2: sy(t) }),
      h("text", { class: "tick", x: pad.l - 6, y: sy(t) + 3, "text-anchor": "end", text: fmtTick(t) }),
    );
  }
  svg.append(h("line", { class: "axis", x1: pad.l, x2: W - pad.r, y1: H - pad.b, y2: H - pad.b }));
  const xt = niceTicks(x0, x1, Math.max(2, Math.floor((W - pad.l - pad.r) / 80))).filter((t) => t >= x0 && t <= x1 && Number.isInteger(t));
  for (const t of xt) svg.append(h("text", { class: "tick", x: sx(t), y: H - 5, "text-anchor": "middle", text: fmtTick(t) }));

  // a line, broken wherever a value is missing (a diverged loss, logged as null)
  const path = (points) => {
    let d = "", gap = true;
    for (const [x, y] of points) {
      if (!ok(y)) {
        gap = true;
        continue;
      }
      d += `${gap ? "M" : "L"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`;
      gap = false;
    }
    return d;
  };
  for (const s of series) {
    if (s.raw) svg.append(h("path", { class: "line raw", d: path(s.raw), stroke: s.color }));
    svg.append(h("path", { class: "line", d: path(s.points), stroke: s.color }));
  }

  const markLine = h("line", { class: "step-mark", y1: pad.t, y2: H - pad.b, visibility: "hidden" });
  const setMark = (step) => {
    const on = step != null && step >= x0 && step <= x1;
    markLine.setAttribute("visibility", on ? "visible" : "hidden");
    if (on) {
      markLine.setAttribute("x1", sx(step));
      markLine.setAttribute("x2", sx(step));
    }
  };
  setMark(mark);
  svg.append(markLine);

  // hover: a crosshair snapped to the nearest logged step, every series in one tooltip
  const steps = [...new Set(xs)].sort((a, b) => a - b);
  const lookup = series.map((s) => new Map(s.points));
  const cross = h("line", { class: "cross", y1: pad.t, y2: H - pad.b, visibility: "hidden" });
  const dots = series.map((s) => h("circle", { class: "hover-dot", r: 4, fill: s.color, visibility: "hidden" }));
  svg.append(cross, ...dots);
  const nearest = (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const target = x0 + ((px - pad.l) / (W - pad.l - pad.r)) * (x1 - x0);
    let best = steps[0];
    for (const st of steps) if (Math.abs(st - target) < Math.abs(best - target)) best = st;
    return best;
  };
  if (onPick) svg.addEventListener("click", (e) => onPick(nearest(e)));
  svg.addEventListener("pointermove", (e) => {
    const best = nearest(e);
    cross.setAttribute("x1", sx(best));
    cross.setAttribute("x2", sx(best));
    cross.setAttribute("visibility", "visible");
    const rows = [];
    series.forEach((s, i) => {
      const v = lookup[i].get(best);
      const shown = ok(v);
      dots[i].setAttribute("visibility", shown ? "visible" : "hidden");
      if (!shown) return;
      dots[i].setAttribute("cx", sx(best));
      dots[i].setAttribute("cy", sy(v));
      rows.push([v, s]);
    });
    rows.sort((a, b) => b[0] - a[0]);
    showTip(
      e.clientX,
      e.clientY,
      h("div", { class: "head", text: `step ${best}${onPick ? " · click to pick" : ""}` }),
      ...rows.map(([v, s]) =>
        h("div", { class: "row" }, h("i", { style: `background:${s.color}` }), h("b", { text: fmt(v) }), series.length > 1 && h("span", { text: s.name })),
      ),
    );
  });
  svg.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    dots.forEach((d) => d.setAttribute("visibility", "hidden"));
    hideTip();
  });
  return { el: svg, setMark };
}
