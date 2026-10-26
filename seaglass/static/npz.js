// Reading .npz files (numpy's np.savez / np.savez_compressed) in the browser:
// a zip of .npy files, stored or deflated. readNpz(buffer) -> {name: {dtype, shape, data}}

const TYPED = {
  "|b1": Uint8Array, "|u1": Uint8Array, "|i1": Int8Array,
  "<u2": Uint16Array, "<i2": Int16Array, "<u4": Uint32Array, "<i4": Int32Array,
  "<f4": Float32Array, "<f8": Float64Array, "<i8": BigInt64Array, "<u8": BigUint64Array,
};
const NAMES = {
  "|b1": "bool", "|u1": "uint8", "|i1": "int8", "<u2": "uint16", "<i2": "int16",
  "<u4": "uint32", "<i4": "int32", "<f2": "float16", "<f4": "float32", "<f8": "float64",
  "<i8": "int64", "<u8": "uint64",
};

function half(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

export function readNpy(bytes) {
  if (bytes[0] !== 0x93 || String.fromCharCode(...bytes.subarray(1, 6)) !== "NUMPY") throw new Error("not an .npy file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = bytes[6];
  const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const start = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(bytes.subarray(start, start + headerLen));
  const descr = header.match(/'descr':\s*'([^']+)'/)?.[1];
  const fortran = /'fortran_order':\s*True/.test(header);
  const shapeText = header.match(/'shape':\s*\(([^)]*)\)/)?.[1];
  if (!descr || shapeText == null) throw new Error(`can't read the .npy header ${header}`);
  if (fortran) throw new Error("arrays in Fortran order aren't supported");
  const shape = shapeText.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  const size = shape.reduce((a, b) => a * b, 1);
  const body = bytes.subarray(start + headerLen);
  let data;
  if (descr === "<f2") {
    data = new Float32Array(size);
    for (let i = 0; i < size; i++) data[i] = half(body[2 * i] | (body[2 * i + 1] << 8));
  } else {
    const T = TYPED[descr];
    if (!T) throw new Error(`unsupported dtype ${descr}`);
    // copied, so it's aligned for its type
    data = new T(body.slice(0, size * T.BYTES_PER_ELEMENT).buffer);
  }
  return { dtype: NAMES[descr], shape, data };
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// the zip's members, from its central directory: [{name, method, offset, size}]
function members(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  let count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (at === 0xffffffff || count === 0xffff) {
    // zip64: the end-of-central-directory locator sits just before
    const loc = eocd - 20;
    const z64 = Number(view.getBigUint64(loc + 8, true));
    count = Number(view.getBigUint64(z64 + 32, true));
    at = Number(view.getBigUint64(z64 + 48, true));
  }
  const out = [];
  for (let k = 0; k < count; k++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("bad zip central directory");
    const method = view.getUint16(at + 10, true);
    let size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true), extraLen = view.getUint16(at + 30, true), commentLen = view.getUint16(at + 32, true);
    let offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    // zip64 extra field: the sizes and offset that didn't fit, in that order
    let usize = view.getUint32(at + 24, true);
    for (let e = at + 46 + nameLen; e < at + 46 + nameLen + extraLen; ) {
      const id = view.getUint16(e, true), len = view.getUint16(e + 2, true);
      if (id === 0x0001) {
        let p = e + 4;
        if (usize === 0xffffffff) { usize = Number(view.getBigUint64(p, true)); p += 8; }
        if (size === 0xffffffff) { size = Number(view.getBigUint64(p, true)); p += 8; }
        if (offset === 0xffffffff) { offset = Number(view.getBigUint64(p, true)); p += 8; }
      }
      e += 4 + len;
    }
    out.push({ name, method, offset, size });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return { view, list: out };
}

export async function readNpz(buffer) {
  const bytes = new Uint8Array(buffer);
  const { view, list } = members(bytes);
  const arrays = {};
  for (const m of list) {
    if (!m.name.endsWith(".npy")) continue;
    const local = m.offset;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + m.size);
    const npy = m.method === 0 ? raw : m.method === 8 ? await inflate(raw) : null;
    if (!npy) throw new Error(`unsupported zip compression ${m.method}`);
    arrays[m.name.slice(0, -4)] = readNpy(npy);
  }
  return arrays;
}
