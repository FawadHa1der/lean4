// The .olean fixture writer the tests share (not a test file): pack-set.test.mjs and
// stage-by-reference.test.mjs write trees of these, so pack.mjs reads real import tables.
//
// An .olean whose import table olean-imports.mjs reads: a 64-bit compacted
// region (header with base address and root pointer, then String, Name and
// Import objects, the imports Array and the ModuleData root), so the closure
// checks run on imports pack.mjs really reads (no --no-imports).
export function olean(imports) {
  const base = 0x10000n;
  const objects = [];
  let at = 96;
  const alloc = (bytes) => { const p = base + BigInt(at); objects.push(bytes); at += bytes.length; return p; };
  const word = (b, off, v) => { b.writeBigUInt64LE(v, off); return b; };
  const string = (s) => {
    const utf8 = Buffer.from(`${s}\0`);
    const o = Buffer.alloc(32 + Math.ceil(utf8.length / 8) * 8);
    o[7] = 249; word(o, 8, BigInt(utf8.length)); utf8.copy(o, 32);
    return alloc(o);
  };
  const name = (n) => n.split(".").reduce((prefix, c) => { const s = string(c); const o = Buffer.alloc(24); o[7] = 1; word(o, 8, prefix); word(o, 16, s); return alloc(o); }, 1n);
  const entries = imports.map((m) => { const n = name(m); const o = Buffer.alloc(24); o[6] = 1; word(o, 8, n); return alloc(o); });
  const array = Buffer.alloc(24 + 8 * entries.length);
  array[7] = 246; word(array, 8, BigInt(entries.length));
  entries.forEach((p, i) => word(array, 24 + 8 * i, p));
  const root = alloc(word(Buffer.alloc(16), 8, alloc(array)));
  const header = Buffer.alloc(96);
  header.write("olean", 0, "latin1"); word(header, 80, base); word(header, 88, root);
  return Buffer.concat([header, ...objects]);
}
