// Drawing a gridworld on a canvas, shared by the bundle's modules. Colours come from
// the theme the frontend sets on this frame (SPEC.md §7.5), read when drawing.

import { h } from "./dom.js";

export const CELL = 40;

export const color = (name) => getComputedStyle(document.documentElement).getPropertyValue(`--sg-${name}`).trim();

// the bundle's stylesheet, once per frame
export function styles() {
  if (document.getElementById("gw-style")) return;
  document.head.append(h("link", { id: "gw-style", rel: "stylesheet", href: new URL("./style.css", import.meta.url).href }));
}

// arrays from host.arrays, {name: {dtype, shape, data}}: a 2-d array's value at (r, c)
export const at = (a, r, c) => a.data[r * a.shape[1] + c];

// a canvas sized for an h × w grid, drawn sharp at the screen's pixel ratio
export function gridCanvas(rows, cols) {
  const canvas = h("canvas");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = cols * CELL * dpr;
  canvas.height = rows * CELL * dpr;
  canvas.style.aspectRatio = `${cols} / ${rows}`;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  return { canvas, ctx };
}

// the floor, the walls and the goal; fill(r, c) colours a floor cell, if given
export function drawGrid(ctx, walls, goal, fill = null) {
  const [rows, cols] = walls.shape;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.fillStyle = at(walls, r, c) ? color("fg") : (fill?.(r, c) ?? color("well"));
      ctx.fillRect(c * CELL, r * CELL, CELL, CELL);
    }
  }
  ctx.strokeStyle = color("edge");
  ctx.lineWidth = 1;
  for (let r = 0; r <= rows; r++) line(ctx, 0, r * CELL, cols * CELL, r * CELL);
  for (let c = 0; c <= cols; c++) line(ctx, c * CELL, 0, c * CELL, rows * CELL);
  const [gr, gc] = goal.data;
  ctx.fillStyle = color("good");
  star(ctx, (gc + 0.5) * CELL, (gr + 0.5) * CELL, CELL * 0.32);
}

export function line(ctx, x0, y0, x1, y1) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function star(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI) / 5 - Math.PI / 2, k = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + k * Math.cos(a), y + k * Math.sin(a));
  }
  ctx.closePath();
  ctx.fill();
}
