// A view that fills the "Values" tab: the value map and greedy policy logged at the
// page's step, following it as it moves; the step can be moved from here too
// (host.navigate), and whether to draw the policy is kept as a pref.

import { h } from "./dom.js";
import { CELL, at, color, drawGrid, gridCanvas, line, styles } from "./grid.js";

export async function render({ el, data: props, host }) {
  styles();
  const key = props.key ?? "values";
  let entries = [], next = 0, shown = null;
  let arrows = (await host.getPref("arrows")) ?? true;
  const label = h("span");
  const prev = h("button", { text: "‹ earlier", onclick: () => go(-1) });
  const later = h("button", { text: "later ›", onclick: () => go(1) });
  const toggle = h("button", { onclick: () => setArrows(!arrows) });
  const stage = h("div", { class: "stage" });
  el.replaceChildren(h("div", { class: "values gw" }, h("div", { class: "bar" }, prev, label, later, h("span", { class: "spacer" }), toggle), stage));

  async function fetchEntries() {
    const got = await host.entries({ key, since: next });
    entries.push(...got.rows);
    next = got.next;
    entries.sort((a, b) => a.step - b.step);
  }

  // the entry at or before the page's step (the latest when it follows the run)
  function current(step) {
    let pick = entries.at(-1);
    if (step != null) pick = entries.filter((e) => e.step <= step).at(-1) ?? entries[0];
    return pick;
  }

  async function draw() {
    const { step } = await host.location();
    const entry = current(step);
    prev.disabled = !entry || entry === entries[0];
    later.disabled = !entry || entry === entries.at(-1);
    toggle.textContent = arrows ? "hide policy" : "show policy";
    toggle.classList.toggle("on", arrows);
    if (!entry) {
      label.textContent = "nothing logged yet";
      return;
    }
    label.textContent = `step ${entry.step}${step == null ? " (latest)" : ""}`;
    if (shown?.entry !== entry) shown = { entry, arrays: await host.arrays(entry.file) };
    const { walls, value, policy, goal } = shown.arrays;
    const [rows, cols] = walls.shape;
    const { canvas, ctx } = gridCanvas(rows, cols);
    let lo = Infinity, hi = -Infinity;
    for (const v of value.data) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const accent = color("s1");
    drawGrid(ctx, walls, goal, (r, c) => {
      const t = hi > lo ? (at(value, r, c) - lo) / (hi - lo) : 0;
      return `color-mix(in srgb, ${accent} ${Math.round(t * 85)}%, ${color("well")})`;
    });
    if (arrows) {
      ctx.strokeStyle = color("fg");
      ctx.lineWidth = 2;
      const d = [[0, -1], [1, 0], [0, 1], [-1, 0]];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (at(walls, r, c) || (r === goal.data[0] && c === goal.data[1])) continue;
          const [dx, dy] = d[at(policy, r, c)];
          const x = (c + 0.5) * CELL, y = (r + 0.5) * CELL, k = CELL * 0.28;
          line(ctx, x - dx * k, y - dy * k, x + dx * k, y + dy * k);
          line(ctx, x + dx * k, y + dy * k, x + dx * k * 0.3 - dy * k * 0.5, y + dy * k * 0.3 + dx * k * 0.5);
          line(ctx, x + dx * k, y + dy * k, x + dx * k * 0.3 + dy * k * 0.5, y + dy * k * 0.3 - dx * k * 0.5);
        }
      }
    }
    stage.replaceChildren(canvas);
  }

  // move the page's step to the entry before or after this one
  async function go(d) {
    const { step } = await host.location();
    const i = entries.indexOf(current(step)) + d;
    if (i < 0 || i >= entries.length) return;
    await host.navigate({ step: i === entries.length - 1 ? null : entries[i].step });
  }

  async function setArrows(on) {
    arrows = on;
    await host.setPref("arrows", on);
    draw();
  }

  await fetchEntries();
  await draw();
  return {
    async update(change) {
      if (change.run) await fetchEntries();
      await draw();
    },
  };
}
