// Runs inside a module's sandboxed frame (SPEC.md §7.1): imports the module, gives it a
// `host` whose calls go to the page over postMessage, and tells the page how tall the
// document is. Nothing of the page is reachable from here.
//
// host.js writes this function's source into the frame's document and calls it there,
// so a frame fetches nothing but its own bundle. It uses nothing from outside its body.
export function frameMain() {
  const METHODS = [
    "info", "run", "metrics", "entries", "stream", "file", "json", "arrays",
    "theme", "location", "navigate", "getPref", "setPref",
  ];

  let nextId = 0;
  const pending = new Map();
  const post = (msg) => parent.postMessage({ sg: 1, ...msg }, "*");
  const call = (method, args) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      post({ kind: "call", id, method, args });
    });
  const host = Object.freeze(Object.fromEntries(METHODS.map((m) => [m, (...args) => call(m, args)])));

  const el = document.getElementById("el");
  let mod = null, handle = null, current = null;

  function applyTheme(theme) {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
    root.style.colorScheme = theme.mode;
  }

  function fail(e) {
    post({ kind: "error", message: e?.stack ? `${e.message}\n${e.stack}` : String(e) });
  }

  async function render(data) {
    try {
      handle = (await mod.render({ el, data, run: current.run, host })) ?? null;
    } catch (e) {
      fail(e);
    }
  }

  addEventListener("message", async (ev) => {
    if (ev.source !== parent || ev.data?.sg !== 1) return;
    const msg = ev.data;
    if (msg.kind === "reply") {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.ok) p?.resolve(msg.value);
      else p?.reject(new Error(msg.error));
    } else if (msg.kind === "init") {
      current = msg;
      applyTheme(msg.theme);
      document.documentElement.classList.toggle("fill", !!msg.fill);
      try {
        mod = await import(msg.module);
        if (typeof mod.render !== "function") throw new Error(`${msg.module} doesn't export render`);
      } catch (e) {
        return fail(e);
      }
      await render(msg.data);
    } else if (msg.kind === "update") {
      const change = msg.change;
      if (change.theme) applyTheme(change.theme);
      if (change.run) current.run = change.run;
      if (!mod) return;
      if (handle?.update) {
        try {
          await handle.update(change);
        } catch (e) {
          fail(e);
        }
      } else if ("data" in change) {
        // a module that can't update is drawn again, from scratch
        try {
          handle?.destroy?.();
        } catch {}
        handle = null;
        el.replaceChildren();
        await render(change.data);
      }
    } else if (msg.kind === "key") {
      // a key pressed on the page while the pointer is over this frame
      const target = document.querySelector(":hover:not(:has(:hover))") ?? document.body;
      target.dispatchEvent(new KeyboardEvent("keydown", { key: msg.key, code: msg.code, shiftKey: msg.shiftKey, bubbles: true, cancelable: true }));
    } else if (msg.kind === "destroy") {
      try {
        handle?.destroy?.();
      } catch {}
    }
  });

  new ResizeObserver(() => {
    post({ kind: "size", height: Math.ceil(document.documentElement.getBoundingClientRect().height) });
  }).observe(document.documentElement);

  post({ kind: "ready" });
}
