// olean-imports.mjs: the three readers (oleanImportEntries, oleanImports,
// oleanExtEntryCounts) on synthetic 64-bit regions, Buffer and plain
// Uint8Array alike; the CLI's --entries and --audit modes and the flag
// contract; main() for a forwarding script (QED64's
// pipeline/artifacts/olean-imports.mjs); and pack.mjs, which reads its
// manifests' import lists through oleanImports. Translated from QED64
// tests/unit/import-lane.test.ts (describe "olean-imports.mjs" and the pack
// options) at QED64 69327fe. QED64 also checks two REAL oleans
// (tests/fixtures/mini-lib/Init/{Core,Prelude}.olean, 5 MB, not vendored
// here); that test runs when L4W_OLEAN_FIXTURE_DIR names a dir holding
// Init/Core.olean and Init/Prelude.olean, and asserts QED64's exact counts
// when they are QED64's mini-lib files (by sha256).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256Hex } from "../artifact-id.mjs";
import { oleanExtEntryCounts, oleanImportEntries, oleanImports } from "../olean-imports.mjs";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(pkg, "olean-imports.mjs");
const run = (file, args, opts = {}) => spawnSync(process.execPath, [file, ...args], { encoding: "utf8", timeout: 60_000, ...opts });
const made = [];
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const USAGE = "usage: olean-imports.mjs (--audit <olean tree> | --entries <olean file>)";

/** A minimal 64-bit compacted region holding ModuleData { imports := … }: the
 * same object layout Lean writes (header, base address, root pointer, then
 * strings / Names / Imports / the Array / the root constructor). With
 * `data`, constNames and entries (`Array (Name × Array _)`, each inner array
 * of `count` boxed scalars) are filled in too; without it they are box 0.
 * (QED64 tests/unit/import-lane.test.ts makeOlean, as JavaScript.) */
function makeOlean(imports, data) {
  const BASE = 0x2000_0000_0000n;
  const chunks = [];
  let offset = 96;
  const push = (b) => {
    const at = BigInt(offset);
    const padded = Buffer.alloc(Math.ceil(b.length / 8) * 8);
    b.copy(padded);
    chunks.push(padded);
    offset += padded.length;
    return BASE + at;
  };
  const objectHeader = (size, fields, tag) => {
    const h = Buffer.alloc(8);
    h.writeUInt16LE(size, 4);
    h.writeUInt8(fields, 6);
    h.writeUInt8(tag, 7);
    return h;
  };
  const u64 = (...values) => {
    const b = Buffer.alloc(8 * values.length);
    values.forEach((v, i) => b.writeBigUInt64LE(v, 8 * i));
    return b;
  };
  const BOX0 = 1n;
  const leanString = (s) => {
    const bytes = Buffer.from(`${s}\0`, "utf8");
    return push(Buffer.concat([objectHeader(1, 0, 249), u64(BigInt(bytes.length), BigInt(bytes.length), BigInt(s.length)), bytes]));
  };
  const leanName = (dotted) => {
    let name = BOX0;
    for (const component of dotted.split(".")) {
      name = /^\d+$/.test(component)
        ? push(Buffer.concat([objectHeader(32, 2, 2), u64(name, (BigInt(component) << 1n) | 1n, 0n)]))
        : push(Buffer.concat([objectHeader(32, 2, 1), u64(name, leanString(component), 0n)]));
    }
    return name;
  };
  const entries = imports.map((spec) => {
    const flags = Buffer.alloc(8);
    flags.writeUInt8(spec.importAll ? 1 : 0, 0);
    flags.writeUInt8(spec.isExported ? 1 : 0, 1);
    flags.writeUInt8(spec.isMeta ? 1 : 0, 2);
    return push(Buffer.concat([objectHeader(19, 1, 0), u64(leanName(spec.module)), flags]));
  });
  const leanArray = (items) => push(Buffer.concat([objectHeader(1, 0, 246), u64(BigInt(items.length), BigInt(items.length), ...items)]));
  const array = leanArray(entries);
  let constNames = BOX0;
  let extEntries = BOX0;
  if (data) {
    constNames = leanArray(data.constNames.map(leanName));
    extEntries = leanArray(data.entries.map(([ext, count]) =>
      push(Buffer.concat([objectHeader(24, 2, 0), u64(leanName(ext), leanArray(Array.from({ length: count }, () => BOX0)))]))));
  }
  const rootObject = push(Buffer.concat([objectHeader(49, 5, 0), u64(array, constNames, BOX0, BOX0, extEntries, 1n)]));
  const header = Buffer.alloc(96);
  header.write("olean", 0, "latin1");
  header.writeUInt8(2, 5);
  header.write("4.99.0", 7, "latin1");
  header.writeBigUInt64LE(BASE, 80);
  header.writeBigUInt64LE(rootObject, 88);
  return Buffer.concat([header, ...chunks]);
}

/** Write a module's facets under `lib`. */
function writeModule(lib, name, imports) {
  const file = path.join(lib, `${name.split(".").join("/")}.olean`);
  write(file, makeOlean(imports));
  fs.writeFileSync(file.replace(/\.olean$/, ".ir"), Buffer.from(`ir of ${name}`));
}

const DATA = {
  constNames: ["A.b", "A.c.2", "D"],
  entries: [["Lean.IR.declMapExt", 3], ["_private.Lean.Foo.0.Lean.barExt", 0], ["Lean.protectedExt", 1]],
};
const COUNTS = {
  constNames: 3,
  entries: { "Lean.IR.declMapExt": 3, "_private.Lean.Foo.0.Lean.barExt": 0, "Lean.protectedExt": 1 },
};

/** The same bytes as a plain Uint8Array (not a Buffer) and as a view at a nonzero offset into a larger ArrayBuffer. */
function plainAndView(buf) {
  const plain = new Uint8Array(buf);
  const padded = new Uint8Array(buf.length + 24);
  padded.fill(0xa5);
  padded.set(buf, 16);
  return { plain, view: new Uint8Array(padded.buffer, 16, buf.length) };
}

// ---------- the readers ----------

test("reads names, flags and numeric components from a compacted region", () => {
  const bytes = makeOlean([
    { module: "Init.Data.List.Basic", isExported: true },
    { module: "Mathlib.Tactic.Ring", importAll: true },
    { module: "Archive.2024.Q1", isMeta: true },
    { module: "Init" },
  ]);
  assert.deepEqual(oleanImportEntries(bytes), [
    { module: "Init.Data.List.Basic", importAll: false, isExported: true, isMeta: false },
    { module: "Mathlib.Tactic.Ring", importAll: true, isExported: false, isMeta: false },
    { module: "Archive.2024.Q1", importAll: false, isExported: false, isMeta: true },
    { module: "Init", importAll: false, isExported: false, isMeta: false },
  ]);
  assert.deepEqual(oleanImports(bytes), ["Archive.2024.Q1", "Init", "Init.Data.List.Basic", "Mathlib.Tactic.Ring"]);
  assert.deepEqual(oleanImports(makeOlean([])), []);
});

test("de-duplicates; returns null for bytes it does not understand", () => {
  assert.deepEqual(oleanImports(makeOlean([{ module: "A.B" }, { module: "A.B", isMeta: true }])), ["A.B"]);
  assert.equal(oleanImports(Buffer.from("not an olean at all")), null);
  assert.equal(oleanImports(new Uint8Array(Buffer.from("not an olean at all"))), null);
  const truncated = makeOlean([{ module: "A.B" }]).subarray(0, 120);
  assert.equal(oleanImports(truncated), null);
  const wild = makeOlean([{ module: "A.B" }]);
  wild.writeBigUInt64LE(0xdead_beefn, 88); // root pointer outside the region
  assert.equal(oleanImports(wild), null);
  for (const nonsense of [undefined, null, "olean", 42, new ArrayBuffer(128)]) {
    assert.equal(oleanImportEntries(nonsense), null, String(nonsense));
    assert.equal(oleanExtEntryCounts(nonsense), null, String(nonsense));
  }
});

test("oleanExtEntryCounts: ModuleData's constant names and per-extension entry counts", () => {
  const bytes = makeOlean([{ module: "Init" }], DATA);
  assert.deepEqual(oleanExtEntryCounts(bytes), COUNTS);
  assert.deepEqual(Object.keys(oleanExtEntryCounts(bytes).entries), DATA.entries.map(([ext]) => ext)); // file order
  assert.deepEqual(oleanImports(bytes), ["Init"]); // the import reader is unaffected by the other fields
  // null for what it does not understand: box-0 fields (no ModuleData arrays), junk, a cut region, a wild root
  assert.equal(oleanExtEntryCounts(makeOlean([{ module: "A" }])), null);
  assert.equal(oleanExtEntryCounts(Buffer.from("not an olean at all")), null);
  const base = bytes.readBigUInt64LE(80);
  const root = Number(bytes.readBigUInt64LE(88) - base); // the root object is the last one in the file
  // a region cut through the root's `entries` field: null here, while the imports field before it still reads
  assert.equal(oleanExtEntryCounts(bytes.subarray(0, root + 40)), null);
  assert.deepEqual(oleanImports(bytes.subarray(0, root + 40)), ["Init"]);
  const wild = Buffer.from(bytes);
  wild.writeBigUInt64LE(0xdead_beefn, 88);
  assert.equal(oleanExtEntryCounts(wild), null);
  // an entries array whose length runs past the region: null, and only for this reader
  const long = Buffer.from(bytes);
  const entriesArray = Number(long.readBigUInt64LE(root + 8 + 8 * 4) - base);
  long.writeBigUInt64LE(1n << 40n, entriesArray + 8);
  assert.equal(oleanExtEntryCounts(long), null);
  assert.deepEqual(oleanImports(long), ["Init"]);
  // a root that is not a 5-field constructor is not ModuleData
  const short = Buffer.from(bytes);
  short.writeUInt8(4, root + 6);
  assert.equal(oleanExtEntryCounts(short), null);
});

test("any Uint8Array, not only a Buffer (the .d.mts types take Uint8Array): a plain copy and a view at a nonzero offset", () => {
  const bytes = makeOlean([{ module: "Init.Core", importAll: true }, { module: "Init.Prelude", isMeta: true }], DATA);
  const { plain, view } = plainAndView(bytes);
  assert.equal(Buffer.isBuffer(plain), false);
  assert.equal(Buffer.isBuffer(view), false);
  for (const input of [plain, view]) {
    assert.deepEqual(oleanExtEntryCounts(input), COUNTS);
    assert.deepEqual(oleanImportEntries(input), oleanImportEntries(bytes));
    assert.deepEqual(oleanImports(input), ["Init.Core", "Init.Prelude"]);
  }
  assert.deepEqual(oleanImports(new Uint8Array(makeOlean([{ module: "Init" }], DATA))), ["Init"]);
  // a view never reads past its own window: end it just inside the root object (the bytes under it go on)
  const root = Number(bytes.readBigUInt64LE(88) - bytes.readBigUInt64LE(80));
  const cut = new Uint8Array(view.buffer, view.byteOffset, root + 4);
  assert.equal(oleanExtEntryCounts(cut), null);
  assert.equal(oleanImports(cut), null);
  // and the readers do not copy or touch the caller's bytes
  assert.deepEqual(Buffer.from(plain), bytes);
});

const REAL = process.env.L4W_OLEAN_FIXTURE_DIR;
// sha256 of QED64's tests/fixtures/mini-lib/Init/{Core,Prelude}.olean (QED64 69327fe)
const QED64_MINI_LIB = {
  core: "f72e6f7eeabb7b390a2dffe39fb63fd359c74eb4367a0c57526a176be158c42f",
  prelude: "5d60b0207475ae3682f733db581705ca18c1626debe2becf211703f1db7f1119",
};
test("real oleans (L4W_OLEAN_FIXTURE_DIR/Init/{Core,Prelude}.olean): imports, entry counts, Uint8Array parity", { skip: REAL ? false : "set L4W_OLEAN_FIXTURE_DIR to a dir with Init/Core.olean and Init/Prelude.olean" }, () => {
  const coreBuf = fs.readFileSync(path.join(REAL, "Init", "Core.olean"));
  const preludeBuf = fs.readFileSync(path.join(REAL, "Init", "Prelude.olean"));
  assert.deepEqual(oleanImports(preludeBuf), []);
  assert.ok(oleanImports(coreBuf).includes("Init.Tactics") || oleanImports(coreBuf).includes("Init.SizeOf"), String(oleanImports(coreBuf)));
  const core = oleanExtEntryCounts(coreBuf);
  const prelude = oleanExtEntryCounts(preludeBuf);
  assert.ok(core && prelude);
  for (const n of [core.constNames, prelude.constNames, ...Object.values(core.entries), ...Object.values(prelude.entries)]) assert.ok(Number.isInteger(n) && n >= 0);
  if (sha256Hex(coreBuf) === QED64_MINI_LIB.core && sha256Hex(preludeBuf) === QED64_MINI_LIB.prelude) {
    assert.deepEqual(oleanImports(coreBuf), ["Init.SizeOf", "Init.Tactics"]);
    assert.equal(core.constNames, 1124);
    assert.equal(Object.keys(core.entries).length, 54);
    assert.equal(core.entries["Lean.IR.declMapExt"], 541);
    assert.equal(core.entries["Lean.protectedExt"], 212);
    assert.equal(core.entries["Lean.auxRecExt"], 127);
    assert.deepEqual([prelude.constNames, Object.keys(prelude.entries).length, prelude.entries["Lean.IR.declMapExt"]], [2204, 56, 890]);
  }
  const { plain, view } = plainAndView(coreBuf);
  assert.deepEqual(oleanExtEntryCounts(plain), core);
  assert.deepEqual(oleanExtEntryCounts(view), core);
  assert.deepEqual(oleanImportEntries(view), oleanImportEntries(coreBuf));
  assert.deepEqual(oleanImports(plain), oleanImports(coreBuf));
  assert.equal(oleanExtEntryCounts(coreBuf.subarray(0, 4096)), null);
});

// ---------- the CLI ----------

test("--entries prints one `entries of <file>: <JSON>` line; refusals exit 2, an unreadable region exits 1", () => {
  const tmp = mkdtemp("l4w-oi-");
  const olean = path.join(tmp, "Init", "Core.olean");
  write(olean, makeOlean([{ module: "Init.Prelude" }], DATA));
  for (const args of [["--entries", olean], [`--entries=${olean}`]]) {
    const r = run(script, args);
    assert.deepEqual([r.status, r.stderr], [0, ""], args.join(" "));
    const m = /^entries of (.+): (\{.*\})\n$/.exec(r.stdout);
    assert.equal(m && m[1], olean);
    assert.equal(m[2], JSON.stringify(COUNTS)); // byte for byte: key order is the file's
    assert.match(r.stdout.trimEnd(), /^entries of (.+): (\{"constNames":\d+,"entries":\{.*\}\})$/); // QED64's marker regex
  }
  // a relative path is printed resolved against the cwd (a child's cwd is a realpath: /private/var on macOS), as QED64 prints it
  const rel = run(script, ["--entries", path.join("Init", "Core.olean")], { cwd: tmp });
  assert.equal(rel.stdout, `entries of ${path.join(fs.realpathSync(tmp), "Init", "Core.olean")}: ${JSON.stringify(COUNTS)}\n`);
  // through the dispatcher
  const viaCli = run(path.join(pkg, "cli.mjs"), ["olean-imports", "--entries", olean]);
  assert.deepEqual([viaCli.status, viaCli.stdout], [0, `entries of ${olean}: ${JSON.stringify(COUNTS)}\n`]);
  // a region without ModuleData arrays, and junk: stdout, exit 1
  const junk = path.join(tmp, "junk.olean");
  fs.writeFileSync(junk, "olean but not really");
  const bare = path.join(tmp, "bare.olean");
  fs.writeFileSync(bare, makeOlean([{ module: "A" }]));
  for (const file of [junk, bare]) {
    const r = run(script, ["--entries", file]);
    assert.deepEqual([r.status, r.stdout, r.stderr], [1, `no readable ModuleData in ${file}\n`, ""]);
  }
  for (const args of [["--entries", path.join(tmp, "absent.olean")], ["--entries", tmp], ["--entries", olean, "--audit", tmp], ["--audit", tmp, "--entries", olean], ["--audit", path.join(tmp, "absent")], []]) {
    const x = run(script, args);
    assert.deepEqual([x.status, x.stdout, x.stderr], [2, "", `${USAGE}\n`], args.join(" "));
  }
});

test("--audit lists the `import all` edges of a tree, by importer", () => {
  const lib = path.join(mkdtemp("l4w-oi-"), "audit-lib");
  writeModule(lib, "Init.Prelude", []);
  writeModule(lib, "Init.Core", [{ module: "Init.Prelude", importAll: true }]);
  writeModule(lib, "Lib.A", [{ module: "Init.Core", importAll: true }, { module: "Lib.B" }]);
  writeModule(lib, "Lib.B", [{ module: "Init.Prelude" }]);
  const r = run(script, ["--audit", lib]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, [
    `import-all audit of ${lib}: 4 modules, 2 \`import all\` edge(s)`,
    "  Init: 1",
    "  Lib: 1",
    "  outside Init/Std/Lean/Lake: 1",
    "    Lib.A → import all Init.Core",
    "",
  ].join("\n"));
  // an unreadable .olean is counted and fails the audit (exit 1), the rest still audited
  fs.writeFileSync(path.join(lib, "Junk.olean"), "olean but not really");
  const bad = run(script, ["--audit", lib]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^import-all audit of .+: 5 modules, 2 `import all` edge\(s\), 1 unreadable \.olean file\(s\)$/m);
});

test("the flag contract: --help first, unknown flags warned, a valueless or repeated flag, the usage line", () => {
  const tmp = mkdtemp("l4w-oi-");
  const a = path.join(tmp, "A.olean");
  const b = path.join(tmp, "B.olean");
  write(a, makeOlean([], DATA));
  write(b, makeOlean([], { constNames: [], entries: [] }));
  for (const args of [["--help"], ["-h"], ["--audit", path.join(tmp, "absent"), "--help"], ["--entries", "--help"], ["--entries=-h"]]) {
    const r = run(script, args);
    assert.deepEqual([r.status, r.stderr], [0, ""], args.join(" "));
    assert.equal(r.stdout.split("\n")[0], USAGE);
    assert.match(r.stdout, /--entries <olean file>/);
    assert.match(r.stdout, /run as: lean4-wasm64 olean-imports/);
  }
  let r = run(script, ["--bogus-flag"]);
  assert.deepEqual([r.status, r.stdout, r.stderr], [2, "", `olean-imports: WARNING — unknown flag --bogus-flag ignored\n${USAGE}\n`]);
  r = run(script, ["--entries"]);
  assert.deepEqual([r.status, r.stdout, r.stderr], [2, "", `olean-imports: WARNING — flag --entries has no value; ignored\n${USAGE}\n`]);
  r = run(script, ["--entries", a, "--entries", b, "stray"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `entries of ${a}: ${JSON.stringify(COUNTS)}\n`);
  assert.equal(r.stderr, "olean-imports: WARNING — flag --entries repeated; the first value wins\nolean-imports: WARNING — unexpected argument stray ignored\n");
});

test("a forwarding script re-exports the readers and runs the same CLI through main(); importing runs nothing", () => {
  const tmp = mkdtemp("l4w-oi-");
  const olean = path.join(tmp, "M.olean");
  write(olean, makeOlean([{ module: "Init" }], DATA));
  const url = JSON.stringify(pathToFileURL(script).href);
  // QED64's shim pattern (tests/adversarial/preflight.mjs there): export *, then main() when it is the entry point
  const shim = path.join(tmp, "olean-imports.mjs");
  fs.writeFileSync(shim, [
    `export * from ${url};`,
    `import { main } from ${url};`,
    `import fs from "node:fs";`,
    `import { fileURLToPath } from "node:url";`,
    `const invokedDirectly = (() => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();`,
    `if (invokedDirectly) main();`,
    "",
  ].join("\n"));
  for (const args of [["--entries", olean], ["--audit", tmp], ["--help"], []]) {
    const direct = run(script, args);
    const shimmed = run(shim, args);
    assert.deepEqual([shimmed.status, shimmed.stdout, shimmed.stderr], [direct.status, direct.stdout, direct.stderr], args.join(" "));
  }
  // importing (the module or the shim) has no side effects, whatever argv holds
  const importer = path.join(tmp, "importer.mjs");
  fs.writeFileSync(importer, `const m = await import(${JSON.stringify(pathToFileURL(shim).href)}); console.log(Object.keys(m).sort().join(","));\n`);
  const r = run(importer, ["--entries", olean]);
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, "main,oleanExtEntryCounts,oleanImportEntries,oleanImports\n", ""]);
  // and through a symlinked package dir the CLI still runs (realpaths on both sides)
  const link = path.join(tmp, "pkg-link");
  fs.symlinkSync(pkg, link);
  const linked = run(path.join(link, "olean-imports.mjs"), ["--entries", olean]);
  assert.deepEqual([linked.status, linked.stdout], [0, `entries of ${olean}: ${JSON.stringify(COUNTS)}\n`]);
  const preserved = spawnSync(process.execPath, ["--preserve-symlinks-main", path.join(link, "olean-imports.mjs"), "--entries", olean], { encoding: "utf8" });
  assert.deepEqual([preserved.status, preserved.stdout], [0, `entries of ${olean}: ${JSON.stringify(COUNTS)}\n`]);
});

// ---------- pack.mjs reads its import lists through oleanImports ----------

test("pack.mjs: imports come from the .olean (a bare `Init` edge dropped when Init is not packed); a non-region .olean fails unless --no-imports", () => {
  const tmp = mkdtemp("l4w-oi-pack-");
  const lib = path.join(tmp, "pack-lib");
  writeModule(lib, "Lib.A", [{ module: "Init" }, { module: "Init.Prelude" }, { module: "Lib.B" }]);
  writeModule(lib, "Lib.B", [{ module: "Init" }]);
  const out = path.join(tmp, "pack-out");
  const r = run(path.join(pkg, "pack.mjs"), ["--lib", lib, "--id", "demo", "--out", out, "--roots", "Lib.A", "--url-prefix", "/profiles/", "--release", "demo-abc1234-wasm64-0123456789abcdef", "--lean-version", "4.99.0"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, "demo.manifest.json"), "utf8"));
  assert.equal(manifest.content.release, "demo-abc1234-wasm64-0123456789abcdef");
  assert.equal(manifest.content.pack.url, "/profiles/demo.pack.gzip");
  for (const part of manifest.content.pack.transport.parts) assert.match(part.url, /^\/profiles\/demo\.pack\.gzip\.[0-9a-f]{20}\.part-\d{3}$/);
  assert.deepEqual(manifest.content.modules["Lib.A"].imports, ["Init.Prelude", "Lib.B"]);
  assert.deepEqual(manifest.content.modules["Lib.B"].imports, []);
  assert.equal(`sha256:${sha256Hex(fs.readFileSync(path.join(out, "demo.pack")))}`, manifest.content.pack.digest);
  const bad = path.join(tmp, "pack-bad");
  write(path.join(bad, "Junk.olean"), Buffer.from("olean but not really"));
  const refused = run(path.join(pkg, "pack.mjs"), ["--lib", bad, "--id", "junk", "--out", path.join(tmp, "bad-out"), "--lean-version", "4.99.0"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /no readable import table/);
  assert.equal(run(path.join(pkg, "pack.mjs"), ["--lib", bad, "--id", "junk", "--out", path.join(tmp, "bad-out2"), "--lean-version", "4.99.0", "--no-imports"]).status, 0);
});
