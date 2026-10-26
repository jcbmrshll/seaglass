// The page's side of a module (SPEC.md §7): each instance in a sandboxed frame of its
// own, its host calls answered here by a `host` object of async methods.

const FRAME_JS = new URL("./frame.js", import.meta.url).href;

const srcdoc = () => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent}
body{color:var(--sg-fg);font:13px/1.45 var(--sg-font)}
html.fill,html.fill body,html.fill #el{height:100%}
</style></head><body><div id="el"></div><script type="module" src="${FRAME_JS}"></script></body></html>`;

// the frame under the pointer, which gets the keys pressed on the page
let hovered = null;
document.addEventListener("keydown", (ev) => {
  if (!hovered || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.target.closest?.("input, select, textarea, [contenteditable]")) return;
  hovered.contentWindow?.postMessage({ sg: 1, kind: "key", key: ev.key, code: ev.code, shiftKey: ev.shiftKey }, "*");
  // keys a player takes shouldn't also scroll the page
  if ([" ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(ev.key)) ev.preventDefault();
});

// Run `module` (a URL) in a frame inside `container`, with render({el, data, run, host}).
// Returns {update(change), destroy()}. `fill`: the frame takes the container's height
// rather than its document's.
export function mountModule(container, { module, data, run, host, theme, fill = false, onError = null }) {
  const frame = document.createElement("iframe");
  frame.className = "module-frame";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("allow", "fullscreen");
  frame.style.height = fill ? "100%" : "0px";
  frame.srcdoc = srcdoc();
  let ready = false;
  const queued = [];
  const post = (msg) => {
    if (!ready && msg.kind !== "init") queued.push(msg);
    else frame.contentWindow?.postMessage({ sg: 1, ...msg }, "*");
  };
  const onMessage = async (ev) => {
    if (ev.source !== frame.contentWindow || ev.data?.sg !== 1) return;
    const msg = ev.data;
    if (msg.kind === "ready") {
      ready = true;
      post({ kind: "init", module, data, run, theme, fill });
      queued.splice(0).forEach(post);
    } else if (msg.kind === "size") {
      if (!fill) frame.style.height = `${msg.height}px`;
    } else if (msg.kind === "error") {
      onError?.(msg.message);
    } else if (msg.kind === "call") {
      try {
        const fn = host[msg.method];
        if (typeof fn !== "function") throw new Error(`host has no method ${msg.method}`);
        const value = await fn(...(Array.isArray(msg.args) ? msg.args : []));
        post({ kind: "reply", id: msg.id, ok: true, value });
      } catch (e) {
        post({ kind: "reply", id: msg.id, ok: false, error: String(e?.message ?? e) });
      }
    }
  };
  addEventListener("message", onMessage);
  frame.addEventListener("pointerenter", () => (hovered = frame));
  frame.addEventListener("pointerleave", () => hovered === frame && (hovered = null));
  container.replaceChildren(frame);
  return {
    update: (change) => post({ kind: "update", change }),
    destroy() {
      post({ kind: "destroy" });
      removeEventListener("message", onMessage);
      if (hovered === frame) hovered = null;
      frame.remove();
    },
  };
}

// The theme (§7.5), from the page's own CSS variables, so the two always agree.
export const THEME_VARS = [
  "--sg-bg", "--sg-panel", "--sg-well", "--sg-edge",
  "--sg-fg", "--sg-fg-strong", "--sg-dim", "--sg-faint",
  "--sg-accent", "--sg-good", "--sg-bad",
  "--sg-s1", "--sg-s2", "--sg-s3", "--sg-s4", "--sg-s5", "--sg-s6",
  "--sg-font", "--sg-mono",
];

export function currentTheme() {
  const css = getComputedStyle(document.documentElement);
  const vars = Object.fromEntries(THEME_VARS.map((v) => [v, css.getPropertyValue(v).trim()]));
  const mode = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return { mode, vars };
}
