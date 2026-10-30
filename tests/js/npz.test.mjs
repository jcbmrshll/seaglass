import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readNpy, readNpz } from "../../seaglass/static/npz.js";

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const expected = JSON.parse(readFileSync(fixture("expected.json")));
const DTYPES = {
  f4: "float32", f8: "float64", f2: "float16", i4: "int32", i2: "int16", i1: "int8",
  u1: "uint8", u2: "uint16", u4: "uint32", i8: "int64", b1: "bool", scalar: "float32", empty: "float32", big: "int32",
};

for (const file of ["compressed.npz", "stored.npz"]) {
  test(`reads numpy's ${file}`, async () => {
    const buf = readFileSync(fixture(file));
    const arrays = await readNpz(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    assert.deepEqual(Object.keys(arrays).sort(), Object.keys(expected).sort());
    for (const [name, want] of Object.entries(expected)) {
      const a = arrays[name];
      assert.equal(a.dtype, DTYPES[name], name);
      assert.deepEqual(a.shape, want.shape, name);
      const got = [...a.data.slice(0, 20)].map((v) => (typeof v === "bigint" ? String(v) : Number.isFinite(v) ? v : String(v).toLowerCase().replace("infinity", "inf")));
      const close = want.values.map((v) => (typeof v === "boolean" ? Number(v) : v)).map((v, i) => (typeof v === "number" && typeof got[i] === "number" ? Math.abs(v - got[i]) <= 1e-6 * Math.max(1, Math.abs(v)) : v === got[i]));
      assert.ok(close.every(Boolean), `${name}: ${got} vs ${want.values}`);
    }
    assert.equal(arrays.big.data.length, 5000);
    assert.equal(arrays.big.data[4999], 4999);
    assert.ok(arrays.i8.data instanceof BigInt64Array);
    assert.ok(arrays.f2.data instanceof Float32Array);
  });
}

test("rejects what isn't an npz or npy", async () => {
  await assert.rejects(readNpz(new Uint8Array([1, 2, 3]).buffer), /not a zip/);
  assert.throws(() => readNpy(new Uint8Array(16)), /not an .npy/);
});

test("rejects big-endian and fortran arrays", () => {
  const npy = (header) => {
    const text = new TextEncoder().encode(header.padEnd(118) + "\n");
    const out = new Uint8Array(10 + text.length + 8);
    out.set([0x93, ...new TextEncoder().encode("NUMPY"), 1, 0, text.length & 0xff, text.length >> 8]);
    out.set(text, 10);
    return out;
  };
  assert.throws(() => readNpy(npy("{'descr': '>f4', 'fortran_order': False, 'shape': (2,), }")), /unsupported dtype/);
  assert.throws(() => readNpy(npy("{'descr': '<f4', 'fortran_order': True, 'shape': (2,), }")), /Fortran/);
  const ok = readNpy(npy("{'descr': '<f4', 'fortran_order': False, 'shape': (2,), }"));
  assert.deepEqual(ok.shape, [2]);
});

test("rejects a body shorter than its shape", () => {
  const npy = (header, body) => {
    const text = new TextEncoder().encode(header.padEnd(118) + "\n");
    const out = new Uint8Array(10 + text.length + body);
    out.set([0x93, ...new TextEncoder().encode("NUMPY"), 1, 0, text.length & 0xff, text.length >> 8]);
    out.set(text, 10);
    return out;
  };
  assert.throws(() => readNpy(npy("{'descr': '<f4', 'fortran_order': False, 'shape': (3,), }", 8)), /needs 12/);
  assert.throws(() => readNpy(npy("{'descr': '<f2', 'fortran_order': False, 'shape': (2, 2), }", 6)), /needs 8/);
  assert.equal(readNpy(npy("{'descr': '<f2', 'fortran_order': False, 'shape': (2, 2), }", 8)).data.length, 4);
});
