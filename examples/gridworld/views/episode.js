// The renderer for "gridworld/episode" entries: the agent's path, played step by step.
// Space plays and pauses, the arrow keys step, while the pointer is over it.

import { h } from "./dom.js";
import { CELL, at, color, drawGrid, gridCanvas, line, styles } from "./grid.js";

const FPS = 6;

export async function render({ el, data, host }) {
  styles();
  let episode = null, frame = 0, playing = true, timer = null;
  const scrub = h("input", { type: "range", min: 0, value: 0, step: 1 });
  const playBtn = h("button", { title: "play/pause (space)", onclick: () => setPlaying(!playing) });
  const caption = h("div", { class: "caption" });
  const stage = h("div");
  el.replaceChildren(h("div", { class: "gw" }, stage, h("div", { class: "controls" }, playBtn, scrub), caption));
  scrub.addEventListener("input", () => {
    setPlaying(false);
    show(Number(scrub.value));
  });

  // the entry's arrays: walls (rows, cols), path (steps + 1, 2), rewards (steps), goal (2)
  async function load(entry) {
    const a = await host.arrays(entry.file);
    const [rows, cols] = a.walls.shape;
    const { canvas, ctx } = gridCanvas(rows, cols);
    stage.replaceChildren(canvas);
    canvas.addEventListener("click", () => setPlaying(!playing));
    episode = { ...a, ctx, steps: a.path.shape[0] - 1 };
    scrub.max = episode.steps;
    show(0);
    setPlaying(true);
  }

  function show(t) {
    frame = Math.max(0, Math.min(episode.steps, t));
    const { ctx, walls, path, rewards, goal } = episode;
    drawGrid(ctx, walls, goal);
    // the trail so far, then the agent
    ctx.strokeStyle = color("s1");
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    const centre = (i) => [(at(path, i, 1) + 0.5) * CELL, (at(path, i, 0) + 0.5) * CELL];
    for (let i = 1; i <= frame; i++) line(ctx, ...centre(i - 1), ...centre(i));
    const [x, y] = centre(frame);
    ctx.fillStyle = color("s2");
    ctx.beginPath();
    ctx.arc(x, y, CELL * 0.3, 0, 2 * Math.PI);
    ctx.fill();
    let total = 0;
    for (let i = 0; i < frame; i++) total += rewards.data[i];
    const done = frame === episode.steps;
    const reached = at(path, episode.steps, 0) === goal.data[0] && at(path, episode.steps, 1) === goal.data[1];
    caption.replaceChildren(
      `step ${frame}/${episode.steps} · return `,
      h("b", { text: total.toFixed(2) }),
      done ? (reached ? " · reached the goal" : " · ran out of time") : "",
    );
    scrub.value = frame;
  }

  function setPlaying(on) {
    playing = on;
    playBtn.textContent = on ? "❚❚" : "▶";
    clearInterval(timer);
    if (!on) return;
    if (frame === episode?.steps) show(0);
    timer = setInterval(() => {
      if (frame >= episode.steps) return setPlaying(false);
      show(frame + 1);
    }, 1000 / FPS);
  }

  // keys come to this frame's document (the page forwards them while hovered)
  const onKey = (e) => {
    if (!episode) return;
    if (e.key === " ") setPlaying(!playing);
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      setPlaying(false);
      show(frame + (e.key === "ArrowRight" ? 1 : -1));
    } else return;
    e.preventDefault();
  };
  document.addEventListener("keydown", onKey);

  await load(data);
  return {
    // another entry (the page's step moved), or a new theme
    async update(change) {
      if (change.data) await load(change.data);
      else if (change.theme && episode) show(frame);
    },
    destroy() {
      clearInterval(timer);
      document.removeEventListener("keydown", onKey);
    },
  };
}
