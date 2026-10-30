import { test } from "node:test";
import assert from "node:assert/strict";
import { callHost, frameSrcdoc } from "../../seaglass/static/host.js";
import { frameMain } from "../../seaglass/static/frame.js";

test("the frame's bootstrap is inline: it fetches only its module", () => {
  const doc = frameSrcdoc();
  const scripts = [...doc.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const [, attrs, body] = scripts[0];
  assert.doesNotMatch(attrs, /src=/);
  assert.doesNotMatch(doc, /<link|src=|href=/);
  // it parses, and nothing in it ends the script early
  assert.doesNotThrow(() => new Function(body));
  assert.ok(body.includes(String(frameMain)));
});

test("a frame calls only the host's own methods", async () => {
  const host = { run: async () => ({ id: "r" }), add: async (a, b) => a + b };
  assert.deepEqual(await callHost(host, "run", []), { id: "r" });
  assert.equal(await callHost(host, "add", [2, 3]), 5);
  // args that aren't a list are no args
  assert.ok(Number.isNaN(await callHost(host, "add", "not a list")));
  for (const method of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf", "nope", 1, null]) {
    await assert.rejects(callHost(host, method, []), /host has no method/, String(method));
  }
});

// frameMain run with the few globals a frame gives it: what it posts to the page, and
// a way to post to it
function frame() {
  const posted = [];
  const listeners = [];
  const parent = { postMessage: (msg) => posted.push(msg) };
  const props = {};
  const saved = {};
  const globals = {
    parent,
    addEventListener: (type, fn) => type === "message" && listeners.push(fn),
    ResizeObserver: class { observe() {} },
    document: {
      getElementById: () => ({ textContent: "", replaceChildren() {} }),
      querySelector: () => null,
      documentElement: {
        style: { setProperty: (k, v) => (props[k] = v) },
        classList: { toggle() {} },
        getBoundingClientRect: () => ({ height: 0 }),
      },
    },
  };
  for (const [k, v] of Object.entries(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  frameMain();
  const restore = () => {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  };
  const send = (msg) => Promise.all(listeners.map((fn) => fn({ source: parent, data: { sg: 1, ...msg } })));
  return { posted, send, props, restore };
}

const until = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check());
};

test("the frame runs its module, and its host calls go to the page", async () => {
  const f = frame();
  try {
    assert.deepEqual(f.posted, [{ sg: 1, kind: "ready" }]);
    const source = `export async function render({ el, data, host }) {
      el.textContent = data.word + " " + (await host.run()).name;
      globalThis.rendered = el.textContent;
    }`;
    const init = f.send({
      kind: "init", module: `data:text/javascript,${encodeURIComponent(source)}`, data: { word: "hi" },
      run: { id: "r" }, theme: { mode: "dark", vars: { "--sg-fg": "#fff" } }, fill: false,
    });
    await until(() => f.posted.some((m) => m.kind === "call"));
    const call = f.posted.find((m) => m.kind === "call");
    assert.equal(call.method, "run");
    assert.deepEqual(call.args, []);
    assert.equal(f.props["--sg-fg"], "#fff");
    await f.send({ kind: "reply", id: call.id, ok: true, value: { name: "idle-yarrow" } });
    await init;
    assert.equal(globalThis.rendered, "hi idle-yarrow");
    assert.ok(!f.posted.some((m) => m.kind === "error"));
  } finally {
    delete globalThis.rendered;
    f.restore();
  }
});

test("the frame reports a module that fails", async () => {
  const f = frame();
  try {
    await f.send({ kind: "init", module: "data:text/javascript,export const x = 1;", data: {}, run: {}, theme: { mode: "light", vars: {} } });
    const err = f.posted.find((m) => m.kind === "error");
    assert.match(err.message, /doesn't export render/);
  } finally {
    f.restore();
  }
});
