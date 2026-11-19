// Kernel patch 0039, without a runtime: the generator of the native-symbol table and the export
// list (../gen-exports.py, on synthetic C, with a fake nm), the link check (../check-link.py), the
// static contract checks the gate runs (runtime-contract.mjs, on synthetic glue and wasm bytes) and the
// consumer audit (exports-audit.mjs, on a fixture tree). The Python tools need python3; their tests
// skip without it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT, EXPORT_GLOBALS, GLUE_NAMES, GLUE_SURFACE, MODULE_ONLY_METHODS, RUNTIME_METHODS, contractLevel, exportBindings, moduleOnly, parseSeed,
  proxiedFunctionTable, pthreadPool, readWasm, requiredExports, staticChecks } from "../runtime-contract.mjs";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = path.resolve(pkg, "..");
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "l4w-symtab-")); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const python = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;
const noPython = python ? false : "python3 is not on PATH";

// ---------- gen-exports.py ----------

const GEN = path.join(BUILD, "gen-exports.py");
const LONG = "a".repeat(300);
const gens = Array.from({ length: 40 }, (_, i) => `l_Gen_f${String(i).padStart(2, "0")}___boxed`);
/** A synthetic lib/temp: four modules (Init, Std, Lean, Init.Core) and the symbols of every kind. */
function fixtureTree() {
  const root = tmp(), temp = path.join(root, "temp"), src = path.join(root, "src");
  const init = (m) => ["", "runtime_", "meta_"].map((p) => `LEAN_EXPORT lean_object* ${p}initialize_${m}(uint8_t builtin);`).join("\n");
  write(path.join(temp, "Init.c"), `${init("Init")}\n`);
  write(path.join(temp, "Std.c"), `${init("Std")}\n`);
  write(path.join(temp, "Lean.c"), `${init("Lean")}\n`);
  write(path.join(temp, "Init", "Core.c"), [
    init("Init_Core"),
    "lean_object* l_Other_external(lean_object*);",                       // another module's: not LEAN_EXPORT
    "LEAN_EXPORT lean_object* l_Foo_bar(lean_object*, lean_object*);",     // plain: no boxed wrapper
    "LEAN_EXPORT uint8_t l_Foo_baz(uint8_t);",                             // unboxed, with a wrapper
    "LEAN_EXPORT lean_object* l_Foo_baz___boxed(lean_object*);",
    "LEAN_EXPORT lean_object* l_Lean_MVarId_intro1__(size_t, lean_object*);", // a stem ending in __ ...
    "LEAN_EXPORT lean_object* l_Lean_MVarId_intro1___00__boxed(lean_object*, lean_object*);", // ... and its wrapper
    "LEAN_EXPORT lean_object* lean_my_export(lean_object*);",              // @[export]
    "LEAN_EXPORT lean_object* l_Foo_cell;",
    "LEAN_EXPORT const lean_object* l_Foo_ground = (const lean_object*)&l_Foo_ground_value;",
    "LEAN_EXPORT uint8_t l_Foo_flag;",
    `LEAN_EXPORT lean_object* l_${LONG}x;`, `LEAN_EXPORT lean_object* l_${LONG}y;`,   // a shared prefix over 255 bytes
    ...gens.map((g) => `LEAN_EXPORT lean_object* ${g}(lean_object*);`),
    "LEAN_EXPORT lean_object* l_Foo_bar(lean_object* x_1, lean_object* x_2) {",       // a definition line
    "  return x_1;", "}", "",
  ].join("\n"));
  write(path.join(src, "emscripten-exports.seed.txt"), [
    "# the contract", "_main   # libc", "_malloc", "_lean_wasm_compile        # a caller", "__emscripten_check_mailbox", "_lean_gone   # no source defines it", "",
  ].join("\n"));
  write(path.join(src, "Lean", "Shell.lean"), "@[export lean_wasm_compile] def wasmCompile := 0\n");
  return { root, temp, src };
}
const TABLE = {
  boxed: ["l_Foo_baz___boxed", "l_Lean_MVarId_intro1___00__boxed", ...gens],
  plain: ["l_Foo_bar"],
  export: ["lean_my_export"],
  cell: ["l_Foo_cell", "l_Foo_ground", "l_Foo_flag", `l_${LONG}x`, `l_${LONG}y`],
  init: ["Init", "Std", "Lean", "Init_Core"].map((m) => `initialize_${m}`),
  init_rt: ["Init", "Std", "Lean", "Init_Core"].map((m) => `runtime_initialize_${m}`),
  init_meta: ["Init", "Std", "Lean", "Init_Core"].map((m) => `meta_initialize_${m}`),
};
const KINDS = ["boxed", "plain", "export", "cell", "init", "init_rt", "init_meta"];
/** nm's output for the fixture's symbols (`extra`: more lines), and a fake nm that prints the file it is given. */
function fakeArchives(dir, extra = []) {
  const lines = [...Object.entries(TABLE).flatMap(([k, ns]) => ns.map((n) => `00000000 ${k === "cell" ? "D" : "T"} ${n}`)),
    "00000000 T l_Foo_baz", "00000000 T l_Lean_MVarId_intro1__", ...extra];
  const libs = ["libInit.a", "libStd.a", "libLean.a"].map((l, i) => {
    const p = path.join(dir, l);
    write(p, `\n${l}(Core.c.o.export):\n${lines.filter((_, j) => j % 3 === i).join("\n")}\n`);
    return p;
  });
  const nm = path.join(dir, "fake-nm");
  write(nm, '#!/bin/sh\n[ "$1" = "--defined-only" ] && [ "$2" = "-g" ] || exit 9\nexec cat "$3"\n');
  fs.chmodSync(nm, 0o755);
  return { libs, nm };
}
const gen = (f, args) => spawnSync(python, ["-I", GEN, f.temp, f.src, ...args], { encoding: "utf8" });

/** The names, kinds and FNV of a generated TU, decoded the way wasm_symtab.cpp decodes them. */
function decodeTU(text) {
  const literal = /lean_wasm_symtab_names\[\] =\n([\s\S]*?);\n/.exec(text)[1];
  const bytes = [];
  for (const piece of literal.split("\n")) {
    const s = piece.slice(1, -1);
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "\\") { bytes.push(parseInt(s.slice(i + 1, i + 4), 8)); i += 3; } else bytes.push(s.charCodeAt(i));
    }
  }
  const arr = (name) => /\{([^}]*)\}/.exec(text.slice(text.indexOf(name)))[1].split(",").map(Number);
  const count = Number(/lean_wasm_symtab_count = (\d+)u/.exec(text)[1]), block = Number(/lean_wasm_symtab_block = (\d+)u/.exec(text)[1]);
  const offsets = arr("lean_wasm_symtab_block_off"), kinds = arr("lean_wasm_symtab_kind");
  const names = [];
  let at = 0, prev = Buffer.alloc(0);
  for (let i = 0; i < count; i++) {
    let shared = 0;
    if (i % block === 0) assert.equal(at, offsets[i / block], `block ${i / block} starts at its offset`);
    else shared = bytes[at++];
    let end = at;
    while (bytes[end] !== 0) end++;
    const cur = Buffer.concat([prev.subarray(0, shared), Buffer.from(bytes.slice(at, end))]);
    names.push(cur.toString("latin1"));
    at = end + 1;
    prev = cur;
  }
  let h = 0xcbf29ce484222325n;
  names.forEach((n, i) => {
    for (const b of [...Buffer.from(n, "latin1"), 0, kinds[i]]) h = ((h ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
  });
  const addrs = [...text.matchAll(/^  \(void\*\)(&?)([A-Za-z0-9_]+),$/gm)].map((m) => [m[2], m[1] === "&"]);
  return { names, kinds, fnv: h.toString(16).padStart(16, "0"), declared: /lean_wasm_symtab_fnv = 0x([0-9a-f]+)ull/.exec(text)[1], addrs, bytes: at, blob: bytes.length };
}

test("gen-exports.py: the table's selection, kinds, front coding and manifest; the export list is the seed's contract", { skip: noPython }, () => {
  const f = fixtureTree(), out = path.join(f.root, "out"), { libs, nm } = fakeArchives(f.root);
  const r = gen(f, ["--symtab", path.join(out, "t.c"), "--symtab-manifest", path.join(out, "t.json"), "--archives", ...libs, "--nm", nm, "--no-floors"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /the archives \(\d+ symbols, .*fake-nm\) and the C agree/);
  assert.match(r.stdout, /plain functions in the table: 1/);
  assert.match(r.stdout, /SEED NAMES NO LONGER DEFINED ANYWHERE IN src\/ — dropped \(1\):\n  _lean_gone/);
  const tu = fs.readFileSync(path.join(out, "t.c"), "utf8");
  const m = JSON.parse(fs.readFileSync(path.join(out, "t.json"), "utf8"));
  const want = Object.fromEntries(KINDS.map((k) => [k, (TABLE[k] ?? []).length]));
  assert.deepEqual(m.counts, want);
  assert.equal(m.count, Object.values(want).reduce((a, b) => a + b));
  assert.equal(m.include_plain, true);
  assert.equal(m.plain_candidates, 1); // l_Foo_bar (0039b: in the table); l_Foo_baz and l_Lean_MVarId_intro1__ have wrappers
  assert.equal(m.source, "archives");
  assert.equal(m.archives_agree, true);
  assert.equal(m.modules, 4);
  assert.equal(m.c_files, 4);
  // the decoded table: sorted bytewise, every name of its kind, the FNV the TU and the manifest carry
  const d = decodeTU(tu);
  const all = Object.entries(TABLE).flatMap(([k, ns]) => ns.map((n) => [n, KINDS.indexOf(k)]))
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  assert.deepEqual(d.names, all.map(([n]) => n));
  assert.deepEqual(d.kinds, all.map(([, k]) => k));
  assert.equal(d.fnv, m.fnv1a64);
  assert.equal(d.declared, m.fnv1a64);
  assert.equal(d.blob, m.blob_bytes);
  assert.equal(m.names_sha256.length, 64);
  // every entry has its address: a cell's (&), a function's; the declarations are the C's own
  assert.deepEqual(d.addrs.map(([n]) => n), d.names);
  for (const [n, amp] of d.addrs) assert.equal(amp, TABLE.cell.includes(n), n);
  assert.match(tu, /^LEAN_EXPORT lean_object\* l_Foo_baz___boxed\(lean_object\*\);$/m);
  assert.match(tu, /^extern const lean_object\* l_Foo_ground;$/m);
  assert.match(tu, /^extern uint8_t l_Foo_flag;$/m);
  assert.match(tu, /^lean_object\* runtime_initialize_Init_Core\(uint8_t\);$/m);
  // a plain function by its prototype (not its definition line); unboxed ones with a wrapper and foreign ones stay out
  assert.match(tu, /^LEAN_EXPORT lean_object\* l_Foo_bar\(lean_object\*, lean_object\*\);$/m);
  assert.doesNotMatch(tu, /l_Foo_bar\(lean_object\* x_1|l_Foo_baz\(|l_Other_external|l_Lean_MVarId_intro1__\(/);
  assert.match(tu, /^#include <stdint.h>$/m);
  assert.doesNotMatch(tu, /lean\.h/);
  // the export list: the seed's names, comments gone, the vanished one dropped
  assert.equal(fs.readFileSync(path.join(f.src, "emscripten-exports.txt"), "utf8"), "_main\n_malloc\n_lean_wasm_compile\n__emscripten_check_mailbox\n");

  // write-if-changed: nothing rewritten, mtimes kept
  const files = [path.join(out, "t.c"), path.join(out, "t.json"), path.join(f.src, "emscripten-exports.txt")];
  const before = files.map((p) => fs.statSync(p).mtimeMs);
  const again = gen(f, ["--symtab", path.join(out, "t.c"), "--symtab-manifest", path.join(out, "t.json"), "--archives", ...libs, "--nm", nm, "--no-floors"]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal((again.stdout.match(/^unchanged: /gm) ?? []).length, 3, again.stdout);
  assert.deepEqual(files.map((p) => fs.statSync(p).mtimeMs), before);

  // --check: writes nothing, passes on the build's outputs, fails on a changed manifest or list
  const check = (args = []) => gen(f, ["--check", "--symtab-manifest", path.join(out, "t.json"), "--archives", ...libs, "--nm", nm, "--no-floors", ...args]);
  let c = check();
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /check: the export list and the table \(fnv [0-9a-f]{16}\) are the build's/);
  fs.writeFileSync(path.join(out, "t.json"), JSON.stringify({ ...m, fnv1a64: "0".repeat(16) }));
  c = check();
  assert.equal(c.status, 1);
  assert.match(c.stdout, /CHECK FAILED: the table differs from the build's manifest .*fnv1a64/);
  fs.writeFileSync(path.join(out, "t.json"), JSON.stringify(m));
  fs.appendFileSync(path.join(f.src, "emscripten-exports.txt"), "_extra\n");
  c = check();
  assert.equal(c.status, 1);
  assert.match(c.stdout, /CHECK FAILED: the export list on disk is not this tree's \(\+0 -1\)/);
});

test("gen-exports.py fails closed: archives that disagree with the C, an nm that cannot read them, floors, a plain function that is not all-object, a missing prototype, --slim", { skip: noPython }, () => {
  const f = fixtureTree();
  const outs = (dir) => ["--symtab", path.join(dir, "t.c"), "--symtab-manifest", path.join(dir, "t.json")];
  const nothingWritten = (dir) => {
    assert.equal(fs.existsSync(path.join(dir, "t.c")), false);
    assert.equal(fs.existsSync(path.join(dir, "t.json")), false);
    assert.equal(fs.existsSync(path.join(f.src, "emscripten-exports.txt")), false);
  };
  // B1: a symbol only the archives have, and one only the C has
  let a = fakeArchives(path.join(f.root, "a1"), ["00000000 T l_Extra___boxed"]);
  let r = gen(f, [...outs(path.join(f.root, "o1")), "--archives", ...a.libs, "--nm", a.nm, "--no-floors"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the archives and the C disagree \(B1\) — nothing written/);
  assert.match(r.stderr, /in an archive, in no C .*: 1\n    l_Extra___boxed/);
  nothingWritten(path.join(f.root, "o1"));
  a = fakeArchives(path.join(f.root, "a2"));
  fs.writeFileSync(a.libs[0], fs.readFileSync(a.libs[0], "utf8").replace(/^.* T l_Foo_baz___boxed$/m, ""));
  fs.writeFileSync(a.libs[1], fs.readFileSync(a.libs[1], "utf8").replace(/^.* T l_Foo_baz___boxed$/m, ""));
  fs.writeFileSync(a.libs[2], fs.readFileSync(a.libs[2], "utf8").replace(/^.* T l_Foo_baz___boxed$/m, ""));
  r = gen(f, [...outs(path.join(f.root, "o2")), "--archives", ...a.libs, "--nm", a.nm, "--no-floors"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /in the C, in no archive .*: 1\n    l_Foo_baz___boxed   \(Init\/Core\.c\)/);
  // a cell the archives call a function
  a = fakeArchives(path.join(f.root, "a3"), []);
  for (const lib of a.libs) fs.writeFileSync(lib, fs.readFileSync(lib, "utf8").replace(/ D l_Foo_flag$/m, " T l_Foo_flag"));
  r = gen(f, [...outs(path.join(f.root, "o3")), "--archives", ...a.libs, "--nm", a.nm, "--no-floors"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /kinds differ: 1\n    l_Foo_flag: C cell, archive fn/);
  // an nm that cannot read the archives, and one that reads nothing from them
  const badNm = path.join(f.root, "bad-nm");
  write(badNm, "#!/bin/sh\necho 'nm: file format not recognized' >&2\nexit 1\n");
  fs.chmodSync(badNm, 0o755);
  r = gen(f, [...outs(path.join(f.root, "o4")), "--archives", ...a.libs, "--nm", badNm, "--no-floors"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read .*libInit\.a \(exit 1\): nm: file format not recognized/);
  const emptyNm = path.join(f.root, "empty-nm");
  write(emptyNm, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(emptyNm, 0o755);
  r = gen(f, [...outs(path.join(f.root, "o5")), "--archives", ...a.libs, "--nm", emptyNm, "--no-floors"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /read no function from .*libInit\.a/);
  r = gen(f, [...outs(path.join(f.root, "o6")), "--archives", path.join(f.root, "nope.a"), "--nm", a.nm, "--no-floors"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--archives: .*nope\.a does not exist/);
  nothingWritten(path.join(f.root, "o6"));
  // B2: the real floors refuse a tree this small
  r = gen(f, outs(path.join(f.root, "o7")));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /below its floors \(B2\) — nothing written: boxed 42 < 80000; plain 1 < 25000; export 1 < 100; cell 5 < 7000; initializers 4\/4\/4 for 4 C files/);
  nothingWritten(path.join(f.root, "o7"));
  const core = path.join(f.temp, "Init", "Core.c");
  // a plain function (no wrapper) that does not take 1 to 16 objects and return one: a scalar in its
  // signature means a missed wrapper, and the interpreter would call it with boxed values
  const coreText = fs.readFileSync(core, "utf8");
  for (const [name, proto] of [["l_Foo_scalar", "LEAN_EXPORT uint8_t l_Foo_scalar(lean_object*);"],
    ["l_Foo_usize", "LEAN_EXPORT lean_object* l_Foo_usize(size_t, lean_object*);"],
    ["l_Foo_wide", `LEAN_EXPORT lean_object* l_Foo_wide(${Array(17).fill("lean_object*").join(", ")});`]]) {
    fs.writeFileSync(core, `${coreText}${proto}\n`);
    r = gen(f, [...outs(path.join(f.root, "o10")), "--no-floors"]);
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, new RegExp(`plain function ${name} \\(.*Core\\.c\\) does not take 1 to 16 objects and return one`));
    nothingWritten(path.join(f.root, "o10"));
  }
  fs.writeFileSync(core, `${coreText}LEAN_EXPORT lean_object* l_Foo_sixteen(${Array(16).fill("lean_object*").join(", ")});\n`);
  r = gen(f, [...outs(path.join(f.root, "o11")), "--no-floors"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(f.root, "o11", "t.c"), "utf8"), /^  \(void\*\)l_Foo_sixteen,$/m);
  fs.writeFileSync(core, coreText);
  fs.rmSync(path.join(f.src, "emscripten-exports.txt"));
  // a selected function whose prototype the C does not have on one line
  fs.writeFileSync(core, fs.readFileSync(core, "utf8").replace("LEAN_EXPORT lean_object* lean_my_export(lean_object*);", "LEAN_EXPORT lean_object* lean_my_export(lean_object* x) {"));
  r = gen(f, [...outs(path.join(f.root, "o8")), "--no-floors"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no one-line prototype for function lean_my_export/);
  // the retired slim list, and a missing --symtab
  r = gen(f, [...outs(path.join(f.root, "o9")), "--slim", "x.txt"]);
  assert.equal(r.status, 2);
  r = gen(f, ["--symtab-manifest", path.join(f.root, "o9", "t.json")]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--symtab <c> is required/);
});

test("the generated table compiles for wasm64 without warnings (when this host's clang has the target)", { skip: noPython }, (t) => {
  const targets = spawnSync("clang", ["-print-targets"], { encoding: "utf8" });
  if (targets.status !== 0 || !/\bwasm64\b/.test(targets.stdout)) return t.skip("no clang with the wasm64 target");
  const f = fixtureTree(), out = path.join(f.root, "out");
  assert.equal(gen(f, ["--symtab", path.join(out, "t.c"), "--symtab-manifest", path.join(out, "t.json"), "--no-floors"]).status, 0);
  const r = spawnSync("clang", ["--target=wasm64-unknown-emscripten", "-ffreestanding", "-O2", "-fPIC", "-pthread", "-Wall", "-Wextra",
    "-c", path.join(out, "t.c"), "-o", path.join(out, "t.o")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
});

// ---------- check-link.py ----------

const CHECK = path.join(BUILD, "check-link.py");
test("check-link.py: signature mismatches and undefined table entries fail; other undefined symbols follow the allowlist", { skip: noPython }, () => {
  const d = tmp(), bin = path.join(d, "bin"), tu = path.join(d, "t.c");
  write(tu, "void * const lean_wasm_symtab_addr[] = {\n  (void*)l_A___boxed,\n  (void*)&l_cell,\n};\n");
  const APPLY = [...Array(16).keys()].map((i) => `lean_apply_${i + 1}`).concat(["lean_apply_m", "lean_apply_n"]);
  const symbolMap = (extra) => ["main", "l_A___boxed", ...APPLY, ...extra].map((n, i) => `${i}:${n}`).join("\n") + "\n";
  write(path.join(bin, "lean.js.symbols"), symbolMap([]));
  const allow = (text) => { const p = path.join(d, `allow-${made.length}-${Math.random()}.txt`); write(p, text); return p; };
  const log = (text) => { const p = path.join(d, `log-${Math.random()}.txt`); write(p, text); return p; };
  const LINK = "[    ] Building /build/stage1/bin/lean.js\n";
  const run = (l, a) => spawnSync(python, ["-I", CHECK, l, bin, tu, a], { encoding: "utf8" });
  const UNCAL = allow("# header only\n");
  let r = run(log(`${LINK}emcc: warning: undefined symbol: uv_x (referenced by root reference) [-Wundefined]\n`), UNCAL);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /1 undefined symbols in the link; allowlist 0 names, NOT CALIBRATED/);
  assert.match(r.stdout, /new undefined symbol: uv_x/);
  r = run(log(`${LINK}warning: undefined symbol: uv_x\n`), allow("# calibrated-from: test build\nuv_x\nuv_gone   # was undefined\n"));
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /allowlisted, no longer undefined: uv_gone/);
  r = run(log(`${LINK}warning: undefined symbol: uv_y\n`), allow("# calibrated-from: test build\nuv_x\n"));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /LINK CHECK FAILED: 1 undefined symbols not in/);
  r = run(log(`${LINK}wasm-ld: error: undefined symbol: l_cell\nwarning: undefined symbol: l_A___boxed (referenced by x)\n`), UNCAL);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /LINK CHECK FAILED: 2 table entries are undefined in the link: l_A___boxed, l_cell/);
  r = run(log(`${LINK}wasm-ld: warning: function signature mismatch: l_A___boxed\n`), UNCAL);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /LINK CHECK FAILED: 1 signature-mismatch lines in the link log/);
  // patch 0041: a closure-application entry point inlined away (missing from the map) fails
  write(path.join(bin, "lean.js.symbols"), symbolMap([]).replace(/^\d+:lean_apply_16\n/m, ""));
  r = run(log(LINK), UNCAL);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /LINK CHECK FAILED: 1 closure-application entry points were inlined .*: lean_apply_16$/m);
  write(path.join(bin, "lean.js.symbols"), symbolMap([]));
  r = run(log(LINK), UNCAL);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /the 18 closure-application entry points \(lean_apply_\*\) are functions of their own/);
  write(path.join(bin, "lean.js.symbols"), symbolMap(["signature_mismatch:l_A___boxed"]));
  r = run(log("make: Nothing to be done\n"), UNCAL);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /shows no `lean` link/);
  assert.match(r.stdout, /LINK CHECK FAILED: 1 signature-mismatch stubs in .*: signature_mismatch:l_A___boxed/);
  fs.rmSync(path.join(bin, "lean.js.symbols"));
  r = run(log(LINK), UNCAL);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no symbol map .*lean\.js\.symbols/);
  assert.equal(spawnSync(python, ["-I", CHECK, "a"], { encoding: "utf8" }).status, 2);
});

test("the shipped allowlist is calibrated from the first 0039 link, which had no undefined symbol", () => {
  const text = fs.readFileSync(path.join(BUILD, "link-undefined-allowlist.txt"), "utf8");
  assert.match(text, /^#\s*calibrated-from:\s*[0-9a-f]{10}\b.*: 0 undefined symbols$/m);
  assert.doesNotMatch(text, /NOT CALIBRATED/);
  assert.deepEqual(parseSeed(text), []);
});

// ---------- runtime-contract.mjs: the gate's static checks ----------

const leb = (n) => { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return out; };
const str = (s) => [...leb(Buffer.byteLength(s)), ...Buffer.from(s)];
const section = (id, body) => [id, ...leb(body.length), ...body];
/** A wasm binary with just the sections the checks read (customs, imports, exports). */
function wasmOf({ customs = [], imports = [], exports = [] }) {
  const importBody = imports.flatMap(([m, f, kind]) => [...str(m), ...str(f), kind,
    ...(kind === 0 ? leb(3) : kind === 2 ? [0x07, ...leb(2048), ...leb(262144)] : kind === 1 ? [0x70, 0x04, ...leb(10)] : [0x7e, 1])]);
  return Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...customs.flatMap((c) => section(0, [...str(c), 9, 9, 9])),
    ...(imports.length ? section(2, [...leb(imports.length), ...importBody]) : []),
    ...section(1, [0x01, 0x60, 0, 0]), // a type section, skipped
    ...(exports.length ? section(7, [...leb(exports.length), ...exports.flatMap(([n, kind, i]) => [...str(n), kind, ...leb(i)])]) : [])]);
}
/** A glue with every [GLUE] reach-in S6 checks, in the shapes emsdk 6.0.5's -O3 glue has. */
const SURFACE = [
  'var Module=typeof Module!="undefined"?Module:{};',
  'var ENVIRONMENT_IS_PTHREAD=ENVIRONMENT_IS_WORKER&&globalThis.name=="em-pthread";',
  'var ABORT=false;var EXITSTATUS;var wasmMemory;function initMemory(){if(Module["wasmMemory"]){wasmMemory=Module["wasmMemory"]}}',
  'var out=Module["print"]||console.log;var err=Module["printErr"]||console.error;Module["arguments"];Module["locateFile"];Module["noInitialRun"];',
  'Module["onRuntimeInitialized"];Module["onAbort"];Module["onExit"];Module["preRun"];',
  'class ExitStatus{name="ExitStatus";constructor(status){this.message=`exit(${status})`;this.status=status}}',
  'var runtimeKeepaliveCounter=0;var runtimeKeepalivePush=()=>{runtimeKeepaliveCounter+=1};var runtimeExited=false;',
  'var PThread={unusedWorkers:[],pthreads:{},allocateUnusedWorker(){var worker;var pthreadMainJs=Module["mainScriptUrlOrBlob"];worker=new Worker(pthreadMainJs,{name:"em-pthread"});worker.onerror=e=>{var message="worker sent an error!";err(`${message} ${e.filename}`);throw e};PThread.unusedWorkers.push(worker)},',
  'getNewWorker(){if(PThread.unusedWorkers.length==0){PThread.allocateUnusedWorker()}return PThread.unusedWorkers.pop()},returnWorkerToPool:worker=>{delete PThread.pthreads[worker.pthread_ptr]}};',
  'var cleanupThread=pthread_ptr=>{var worker=PThread.pthreads[pthread_ptr];PThread.returnWorkerToPool(worker)};',
  'var spawnThread=threadParams=>{var worker=PThread.getNewWorker();return 0};function pthreadCreateProxied(){return spawnThread(threadParams)}',
  'var _proc_exit=code=>{throw new ExitStatus(code)};function exitOnMainThread(returnCode){}var proxiedJSCallArgs=[];',
  'var proxiedFunctionTable=[_proc_exit,exitOnMainThread,pthreadCreateProxied];',
  'var waitAsyncPolyfilled=!Atomics.waitAsync;function __emscripten_thread_mailbox_await(pthread_ptr){if(!waitAsyncPolyfilled){var wait=Atomics.waitAsync(HEAP32,(pthread_ptr+204)/4,pthread_ptr);wait.value.then(checkMailbox)}}',
  'var checkMailbox=()=>{var pthread_ptr=_pthread_self();if(!pthread_ptr)return;runtimeKeepalivePush();callUserCallback(()=>{__emscripten_thread_mailbox_await(pthread_ptr);__emscripten_check_mailbox()});runtimeKeepalivePop()};',
  'var FS={mkdirTree(path,mode){},makedev:(ma,mi)=>ma<<8|mi,filesystems:null};FS.filesystems={MEMFS,NODEFS,WORKERFS};',
  'var TTY={ttys:[],stream_ops:{write(stream,buffer){stream.tty.ops.put_char(stream.tty,buffer[0])}},default_tty_ops:{put_char(tty,val){},fsync(tty){}}};',
  'function callMain(args=[]){var entryFunction=__emscripten_proxy_main;runtimeKeepalivePush();throw"unwind"}',
  ...["callMain", "FS", "ENV", "getValue", "setValue", "stringToNewUTF8", "UTF8ToString", "ccall"].map((m) => `Module["${m}"]=${m};`),
].join("\n");
/**
 * The same reach-ins in the shapes emsdk 7.0.0's -O3 glue has (the trial build of 2026-11-17,
 * emsdk7-eval bd4560f0a3): `!==` (emscripten#27927); the exit hooks swapped in the table, which
 * also holds proxied functions Terser inlined (#28059, #27995); runtime methods used only by their
 * export inlined into it, so no global getValue, setValue, ccall or stringToNewUTF8 (Terser); no
 * FS.filesystems (#27940), NODEFS and WORKERFS exported on Module by the kernel's link.
 */
const SURFACE_7 = [
  'var Module=typeof Module!=="undefined"?Module:{};',
  'var ENVIRONMENT_IS_PTHREAD=ENVIRONMENT_IS_WORKER&&globalThis.name=="em-pthread";',
  'var ABORT=false;var EXITSTATUS;var wasmMemory;function initMemory(){if(Module["wasmMemory"]){wasmMemory=Module["wasmMemory"]}}',
  'var out=Module["print"]||console.log;var err=Module["printErr"]||console.error;Module["arguments"];Module["locateFile"];Module["noInitialRun"];',
  'Module["onRuntimeInitialized"];Module["onAbort"];Module["onExit"];Module["preRun"];',
  'class ExitStatus{name="ExitStatus";constructor(status){this.message=`Program terminated with exit(${status})`;this.status=status}}',
  'var runtimeKeepaliveCounter=0;var runtimeKeepalivePush=()=>{runtimeKeepaliveCounter+=1};var runtimeExited=false;',
  'var PThread={unusedWorkers:[],tlsInitFunctions:[],pthreads:{},allocateUnusedWorker(){var worker;var pthreadMainJs=Module["mainScriptUrlOrBlob"];worker=new Worker(pthreadMainJs,{workerData:"em-pthread",name:"em-pthread"});worker.onerror=e=>{err(`worker sent an error! ${e.filename}`);throw e};PThread.unusedWorkers.push(worker);return worker},',
  'getNewWorker(){if(PThread.unusedWorkers.length==0){var newWorker=PThread.allocateUnusedWorker()}return PThread.unusedWorkers.pop()},returnWorkerToPool:worker=>{delete PThread.pthreads[worker.pthread_ptr]}};',
  'var cleanupThread=pthread_ptr=>{var worker=PThread.pthreads[pthread_ptr];PThread.returnWorkerToPool(worker)};',
  'var spawnThread=threadParams=>{var worker=PThread.getNewWorker();if(!worker)return 6;return 0};function pthreadCreateProxied(){return spawnThread(threadParams)}',
  'function exitOnMainThread(returnCode){if(ENVIRONMENT_IS_PTHREAD)return proxyToMainThread(0,0,0,returnCode)}function _proc_exit(code){if(ENVIRONMENT_IS_PTHREAD)return proxyToMainThread(1,0,1,code);throw new ExitStatus(code)}var proxiedJSCallArgs=[];',
  'var proxiedFunctionTable=[exitOnMainThread,_proc_exit,pthreadCreateProxied,function(fd,newfd,flags){if(ENVIRONMENT_IS_PTHREAD)return proxyToMainThread(3,0,1,fd,newfd,flags);try{if(fd===newfd)return-28;var old=SYSCALLS.getStreamFromFD(fd);return FS.dupStream(old,newfd).fd}catch(e){if(typeof FS==="undefined"||!(e.name==="ErrnoError"))throw e;return-e.errno}},_fd_write];',
  'var waitAsyncPolyfilled=!Atomics.waitAsync;function __emscripten_thread_mailbox_await(pthread_ptr){if(!waitAsyncPolyfilled){var wait=Atomics.waitAsync(HEAP32,pthread_ptr/4,pthread_ptr);wait.value.then(checkMailbox);var waitingAsync=pthread_ptr+204}}',
  'var checkMailbox=()=>{var pthread_ptr=_pthread_self();if(!pthread_ptr)return;runtimeKeepalivePush();callUserCallback(()=>{__emscripten_thread_mailbox_await(pthread_ptr);__emscripten_check_mailbox()});runtimeKeepalivePop()};',
  'var FS={mkdirTree(path,mode=511){},makedev:(ma,mi)=>ma<<8|mi};var NODEFS={staticInit(){}};var WORKERFS={mount(mount){}};',
  'var TTY={ttys:[],stream_ops:{write(stream,buffer){stream.tty.ops.put_char(stream.tty,buffer[0])}},default_tty_ops:{put_char(tty,val){},fsync(tty){}}};',
  'function callMain(args=[]){var entryFunction=__emscripten_proxy_main;runtimeKeepalivePush();throw"unwind"}',
  'var UTF8ToString=(ptr,maxBytesToRead,ignoreNul)=>"";',
  'Module["callMain"]=callMain;Module["ENV"]=ENV;Module["ccall"]=(ident,returnType,argTypes,args)=>{};',
  'Module["setValue"]=function(ptr,value,type="i8"){};Module["getValue"]=function(ptr,type="i8"){};',
  'Module["UTF8ToString"]=UTF8ToString;Module["stringToNewUTF8"]=str=>{};Module["FS"]=FS;Module["NODEFS"]=NODEFS;Module["WORKERFS"]=WORKERFS;',
].join("\n");
const SURFACES = [["emsdk 6.0.5", SURFACE], ["emsdk 7.0.0", SURFACE_7]];
// 7.0.0 keeps a global binding only for the exports the glue itself reads (Terser drops the rest)
const GLUE_READS_7 = new Set(["_malloc", "_pthread_self", "__emscripten_proxy_main", "__emscripten_check_mailbox"]);
/** A 0039 glue (`surface`'s shapes) binding `names` to minified raw exports, and its wasm (every raw name a function export). */
function runtimeOf(names = CONTRACT.map((c) => c.name), extraGlue = "", wasmExtra = {}, surface = SURFACE) {
  const global = (n) => (surface !== SURFACE_7 || GLUE_READS_7.has(n) ? `${n}=` : "");
  const bind = names.map((n, i) => `${global(n)}Module["${n}"]=wasmExports["e${i}"];`).join("");
  const glue = `${surface}\nfunction assignWasmExports(wasmExports){${bind}}\n${extraGlue}`;
  const wasm = wasmOf({ exports: [...names.map((_, i) => [`e${i}`, 0, i]), ["mem", 2, 0]], imports: [["a", "b", 2], ["a", "c", 0]], ...wasmExtra });
  return { glue, wasmBytes: wasm };
}
const byLabel = (results, re) => results.find((r) => re.test(r.label));

test("readWasm reads custom sections, imports and exports, and never throws", () => {
  const w = readWasm(wasmOf({ customs: ["dylink.0", "name"], imports: [["env", "memory", 2], ["GOT.func", "f", 3], ["env", "tbl", 1], ["env", "f", 0]], exports: [["_start", 0, 1], ["memory", 2, 0]] }));
  assert.equal(w.ok, true, w.error);
  assert.deepEqual(w.customs, ["dylink.0", "name"]);
  assert.deepEqual(w.imports.map((i) => `${i.module}.${i.field}:${i.kind}`), ["env.memory:2", "GOT.func.f:3", "env.tbl:1", "env.f:0"]);
  assert.deepEqual([...w.exports], [["_start", 0], ["memory", 2]]);
  for (const bad of [Buffer.from("not wasm"), Buffer.alloc(0), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 7, 50, 1])]) {
    const r = readWasm(bad);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, "string");
  }
});

test("the static checks pass a 0039 runtime that keeps the contract and the glue surface, in emsdk 6.0.5's and 7.0.0's glue shapes", () => {
  for (const [gen, surface] of SURFACES) {
    const rt = runtimeOf(undefined, "", {}, surface);
    assert.equal(contractLevel(rt.glue), "0039", gen);
    const { level, results } = staticChecks(rt);
    assert.equal(level, "0039", gen);
    for (const r of results) if (!r.note) assert.equal(r.ok, true, `${gen}: ${r.label}: ${r.extra}`);
    assert.equal(results.filter((r) => !r.note).length, 7, gen); // S1 x4, S2, S6 K6, S6
    assert.match(byLabel(results, /^S6 K6 /).label, /5 items/, gen);
    assert.match(byLabel(results, /^S6 test-probe/).label, /all 4 present/, gen);
    for (const s of GLUE_SURFACE.filter((s) => s.need !== "PIN")) assert.equal(s.test(rt.glue), true, `${gen}: ${s.id}`);
    assert.equal(exportBindings(rt.glue).get("_lean_wasm_compile"), `e${CONTRACT.findIndex((c) => c.name === "_lean_wasm_compile")}`, gen);
  }
  // what only lean4game's pinned worker reads: a note, present in 6.0.5's table order, absent from 7.0.0's
  const pinLine = (glue) => byLabel(staticChecks({ glue, wasmBytes: runtimeOf().wasmBytes }).results, /^S6 what only lean4game's pinned worker/);
  assert.deepEqual(GLUE_SURFACE.filter((s) => s.need === "PIN").map((s) => s.id), ["exit entries at [0] and [1]"]);
  assert.equal(pinLine(runtimeOf().glue).note, true);
  assert.match(pinLine(runtimeOf().glue).label, /: all 1 present$/);
  assert.equal(pinLine(runtimeOf(undefined, "", {}, SURFACE_7).glue).note, true);
  assert.match(pinLine(runtimeOf(undefined, "", {}, SURFACE_7).glue).label,
    /: absent exit entries at \[0\] and \[1\] \(proxiedFunctionTable\[0\] is _proc_exit .*\): lean4game re-pins before it runs on this runtime$/);
  // the table as written: the exit hooks at either position; 7.0.0's also holds a function Terser inlined
  assert.deepEqual(proxiedFunctionTable(SURFACE), ["_proc_exit", "exitOnMainThread", "pthreadCreateProxied"]);
  const t7 = proxiedFunctionTable(SURFACE_7);
  assert.deepEqual([t7.length, ...t7.slice(0, 3), t7[4]], [5, "exitOnMainThread", "_proc_exit", "pthreadCreateProxied", "_fd_write"]);
  assert.match(t7[3], /^function\(fd,newfd,flags\)\{.*"ErrnoError".*\}$/);
  assert.equal(proxiedFunctionTable("var notTheTable=[_proc_exit,exitOnMainThread];"), null);
});

test("S6 on either glue fails what hosts would miss: the Module adoption, a runtime method, the FS route, an exit entry", () => {
  const names = CONTRACT.map((c) => c.name);
  // both REQ lines of S6, K6's and the rest, as one
  const s6 = (glue) => {
    const { results } = staticChecks({ glue, wasmBytes: runtimeOf(names).wasmBytes });
    const lines = [byLabel(results, /^S6 K6 /), byLabel(results, /^S6 the \[GLUE\]/)];
    return { ok: lines.every((l) => l.ok), extra: lines.map((l) => l.extra).filter(Boolean).join("; ") };
  };
  const cuts = {
    "emsdk 6.0.5": [
      ['var Module=typeof Module!="undefined"?Module:{};', "Module adoption"],
      ['Module["getValue"]=getValue;', "runtime methods"],
      ["FS.filesystems={MEMFS,NODEFS,WORKERFS};", "FS"], // 6.0.5's only route to NODEFS and WORKERFS
      ["FS.filesystems={MEMFS,NODEFS,WORKERFS}", "FS", "FS.filesystems={MEMFS,NODEFS}"],
      ["exitOnMainThread,pthreadCreateProxied", "exit entries", "pthreadCreateProxied"],
      ["[_proc_exit,", "exit entries", "["],
    ],
    "emsdk 7.0.0": [
      ['var Module=typeof Module!=="undefined"?Module:{};', "Module adoption"],
      ['Module["getValue"]=function(ptr,type="i8"){};', "runtime methods"],
      ['Module["stringToNewUTF8"]=str=>{};', "runtime methods"],
      ['Module["WORKERFS"]=WORKERFS;', "FS"], // no FS.filesystems: the exports are the route
      ['Module["NODEFS"]=NODEFS;', "FS"],
      ["[exitOnMainThread,", "exit entries", "["],
      ["exitOnMainThread,_proc_exit,", "exit entries", "exitOnMainThread,"],
      ["function _proc_exit(code)", "exit entries", "function _proc_exit2(code)"], // in the table, not defined
    ],
  };
  for (const [gen, surface] of SURFACES) {
    const glue = runtimeOf(names, "", {}, surface).glue;
    assert.equal(s6(glue).ok, true, gen);
    for (const [cut, id, by = "/*cut*/"] of cuts[gen]) {
      assert.ok(glue.includes(cut), `${gen}: ${cut}`);
      const r = s6(glue.replace(cut, by));
      assert.equal(r.ok, false, `${gen}: ${cut}`);
      assert.match(r.extra, new RegExp(`(?:^|; )${id}: `), `${gen}: ${cut}`);
    }
  }
  // either route passes, whatever the rest of the glue looks like; the names alone (var NODEFS, var WORKERFS) do not
  const g7 = runtimeOf(names, "", {}, SURFACE_7).glue;
  const noExports = g7.replace('Module["NODEFS"]=NODEFS;Module["WORKERFS"]=WORKERFS;', "");
  assert.notEqual(noExports, g7);
  assert.equal(s6(noExports).ok, false);
  assert.match(s6(noExports).extra, /^FS: /);
  assert.equal(s6(`${noExports}\nFS.filesystems={MEMFS,NODEFS,WORKERFS};`).ok, true);
  assert.equal(s6(`${noExports}\nFS.filesystems={'MEMFS':MEMFS,'NODEFS':NODEFS,'WORKERFS':WORKERFS};`).ok, true); // emsdk's unminified spelling
  assert.equal(s6(`${noExports}\nModule['NODEFS']=NODEFS;Module['WORKERFS']=WORKERFS;`).ok, true); // single quotes
  // a reordered 6.0.5 table, and the 7.0.0 adoption line in a 6.0.5 glue: shapes, not generations, are checked
  const g5 = runtimeOf(names).glue;
  assert.equal(s6(g5.replace("[_proc_exit,exitOnMainThread,", "[pthreadCreateProxied,exitOnMainThread,_proc_exit,").replace(",pthreadCreateProxied]", "]")).ok, true);
  assert.equal(s6(g5.replace('typeof Module!="undefined"', "typeof Module!=='undefined'")).ok, true);
  assert.equal(s6(g5.replace('Module["ccall"]=ccall;', 'Module["ccall"]==ccall;')).ok, false); // a comparison is no export
});

test("K6: S6 checks the glue names QED64's worker reads on a line of their own, the exit entries at any index", () => {
  // QED64's docs/ARCHITECTURE.md "Glue internals the worker reads", rows 1-4, one or two items each
  assert.deepEqual(GLUE_SURFACE.filter((s) => s.k6).map((s) => [s.k6, s.id]),
    [[1, "exit entries"], [2, "waitAsyncPolyfilled"], [2, "checkMailbox"], [3, "__emscripten_check_mailbox"], [4, "PThread pool"]]);
  for (const s of GLUE_SURFACE.filter((s) => s.k6)) assert.equal(s.need, "REQ", s.id);
  const k6Line = (r) => byLabel(r, /^S6 K6 /), restLine = (r) => byLabel(r, /^S6 the \[GLUE\]/);
  const glueWith = (from, to) => { const g = runtimeOf(); return { glue: g.glue.replace(from, to), wasmBytes: g.wasmBytes }; };
  const TABLE = "var proxiedFunctionTable=[_proc_exit,exitOnMainThread,pthreadCreateProxied];";
  // emsdk may reorder the table: K6 holds at any index; the copy lean4game pins (QED64 73d7f3b) hooks [0] and [1]
  // (emsdk 7 does: emscripten#28059), so that is a note of its own (a PIN item), never a failure
  const pinLine = (r) => byLabel(r, /^S6 what only lean4game's pinned worker/);
  let { results } = staticChecks(glueWith(TABLE, "var proxiedFunctionTable=[pthreadCreateProxied,exitOnMainThread,_proc_exit];"));
  assert.equal(k6Line(results).ok, true, k6Line(results).extra);
  assert.equal(restLine(results).ok, true, restLine(results).extra);
  assert.equal(pinLine(results).note, true);
  assert.match(pinLine(results).label, /absent exit entries at \[0\] and \[1\]/);
  // an entry missing, or a table that holds the names but not the top-level functions it is compared with
  for (const [from, to, why] of [[TABLE, "var proxiedFunctionTable=[_proc_exit,pthreadCreateProxied];", "no exitOnMainThread entry"],
    ["var _proc_exit=code=>", "var procExit=code=>", "_proc_exit not defined at top level"],
    [TABLE, "var proxiedFunctionTable=_tableOf(_proc_exit,exitOnMainThread);", "not an array literal"]]) {
    ({ results } = staticChecks(glueWith(from, to)));
    assert.equal(k6Line(results).ok, false, why);
    assert.match(k6Line(results).extra, /^exit entries: /, why);
  }
  // the kick is the global binding; Module.__emscripten_check_mailbox alone does not do (the worker's fallback)
  ({ results } = staticChecks(glueWith("__emscripten_check_mailbox=Module[\"__emscripten_check_mailbox\"]=", "Module[\"__emscripten_check_mailbox\"]=")));
  assert.match(k6Line(results).extra, /^__emscripten_check_mailbox: /);
  assert.equal(restLine(results).ok, true, restLine(results).extra);
  // the pool sample needs both PThread fields; the methods older workers wrap are the rest's
  ({ results } = staticChecks(glueWith("pthreads:{},", "")));
  assert.match(k6Line(results).extra, /^PThread pool: /);
  ({ results } = staticChecks(glueWith("returnWorkerToPool:worker=>", "giveBack:worker=>")));
  assert.equal(k6Line(results).ok, true);
  assert.match(restLine(results).extra, /^PThread methods: /);
  // message mode: checkMailbox without its keepalive, waitAsyncPolyfilled gone
  ({ results } = staticChecks(glueWith("runtimeKeepalivePush();callUserCallback", "callUserCallback")));
  assert.match(k6Line(results).extra, /^checkMailbox: /);
  ({ results } = staticChecks(glueWith("var waitAsyncPolyfilled=!Atomics.waitAsync;", "")));
  assert.match(k6Line(results).extra, /^waitAsyncPolyfilled: /);
  // every K6 name is one exports-audit knows, and 0038's pool variable is not
  for (const n of ["proxiedFunctionTable", "_proc_exit", "exitOnMainThread", "waitAsyncPolyfilled", "checkMailbox", "__emscripten_check_mailbox", "PThread"])
    assert.ok(GLUE_NAMES.includes(n), n);
  assert.equal(GLUE_NAMES.includes("leanPthreadPoolTarget"), false);
});

test("proxiedFunctionTable reads the table's entries as written: identifiers, or expressions with brackets and strings", () => {
  assert.deepEqual(proxiedFunctionTable("var a=1;var proxiedFunctionTable=[_proc_exit,exitOnMainThread,pthreadCreateProxied];var b"),
    ["_proc_exit", "exitOnMainThread", "pthreadCreateProxied"]);
  assert.deepEqual(proxiedFunctionTable('var proxiedFunctionTable=[ exitOnMainThread , function(fd,x){return [fd,"],",x]},\n_proc_exit ];'),
    ["exitOnMainThread", 'function(fd,x){return [fd,"],",x]}', "_proc_exit"]);
  assert.deepEqual(proxiedFunctionTable("var proxiedFunctionTable=[];"), []);
  assert.equal(proxiedFunctionTable("var notproxiedFunctionTable=[_proc_exit];"), null);
  assert.equal(proxiedFunctionTable("x.proxiedFunctionTable=[_proc_exit];"), null);
  assert.equal(proxiedFunctionTable("var proxiedFunctionTable=[_proc_exit,"), null); // unterminated
});

test("pthreadPool reads the pool the glue allocates at start-up: -sPTHREAD_POOL_SIZE's literal, or 0038's library's default", () => {
  const loop = (v) => `initMainThread(){var pthreadPoolSize=${v};while(pthreadPoolSize--){PThread.allocateUnusedWorker()}addOnPreRun(()=>{})}`;
  assert.deepEqual(pthreadPool(`var PThread={${loop(24)}}`), { size: 24, form: "literal" }); // emsdk 6.0.5's -O3 shape, as since D3b and before 0038
  // emsdk 7.0.0's: its Terser pass drops the loop's braces (the 0038 line of the emsdk7-eval trial glue had
  // `var pthreadPoolSize=leanPthreadPoolTarget;while(pthreadPoolSize--)PThread.allocateUnusedWorker();`)
  assert.deepEqual(pthreadPool("var PThread={initMainThread(){var pthreadPoolSize=24;while(pthreadPoolSize--)PThread.allocateUnusedWorker();addOnPreRun(async()=>{})}}"),
    { size: 24, form: "literal" });
  assert.deepEqual(pthreadPool(`var PThread={${loop(4)}}`), { size: 4, form: "literal" });
  const lib = 'function leanPoolInt(v,dflt,lo,hi){return dflt}var leanPthreadPoolTarget=leanPoolInt(Module["pthreadPoolSize"],24,0,64);';
  assert.deepEqual(pthreadPool(`${lib}var PThread={${loop("leanPthreadPoolTarget")}}`), { size: 24, form: "0038" }); // the runtimes from 0038 to D3b
  assert.deepEqual(pthreadPool(`var PThread={${loop("leanPthreadPoolTarget")}}`), { size: null, form: "0038" }); // the library's variable without its initializer
  assert.deepEqual(pthreadPool("var PThread={initMainThread(){addOnPreRun(()=>{})}}"), { size: null, form: null }); // no pool at all (PTHREAD_POOL_SIZE=0)
  assert.deepEqual(pthreadPool(runtimeOf().glue), { size: null, form: null });
});

test("the static checks fail what hosts would miss: an unbound or non-function export, a generated export, a dynamic module, a lost glue internal", () => {
  const names = CONTRACT.map((c) => c.name);
  let { results } = staticChecks(runtimeOf(names.filter((n) => n !== "_lean_wasm_compile")));
  assert.match(byLabel(results, /^S2/).extra, /_lean_wasm_compile not bound on Module/);
  const rt = runtimeOf(names);
  ({ results } = staticChecks({ glue: rt.glue, wasmBytes: wasmOf({ exports: names.map((_, i) => [`e${i}`, i === 0 ? 2 : 0, i]) }) }));
  assert.match(byLabel(results, /^S2/).extra, new RegExp(`${names[0]} -> wasmExports\\["e0"\\] is not a function export`));
  ({ results } = staticChecks(runtimeOf(names, 'Module["_l_Foo___boxed"]=wasmExports["zz"];Module["_initialize_Init"]=wasmExports["zy"];')));
  assert.equal(byLabel(results, /S1 no generated Lean name/).ok, false);
  assert.match(byLabel(results, /S1 no generated Lean name/).extra, /2 bound, e\.g\. _l_Foo___boxed, _initialize_Init/);
  ({ results } = staticChecks(runtimeOf(names, "", { customs: ["dylink.0"], imports: [["GOT.func", "f", 3]] })));
  assert.equal(byLabel(results, /statically linked module/).ok, false);
  assert.match(byLabel(results, /statically linked module/).extra, /sections dylink\.0, 1 GOT imports/);
  ({ results } = staticChecks(runtimeOf(names, "EM_JS qed64_symbol_exists")));
  assert.equal(byLabel(results, /export-set gate of 0017/).ok, false);
  ({ results } = staticChecks({ ...runtimeOf(names, `/*${"x".repeat(1 << 20)}*/`) }));
  assert.equal(byLabel(results, /under 1 MiB/).ok, false);
  // [cut, the item that fails, the line it fails: K6's (QED64's worker) or the rest of S6]
  for (const [cut, id, line] of [['throw"unwind"', '"unwind"', /^S6 the \[GLUE\]/], ["pthread_ptr+204", "mailbox await", /^S6 the \[GLUE\]/],
    ["exitOnMainThread,pthreadCreateProxied", "exit entries", /^S6 K6 /],
    ["runtimeKeepalivePush();callUserCallback", "checkMailbox", /^S6 K6 /], ["});runtimeKeepalivePop()", "checkMailbox", /^S6 K6 /],
    ["var TTY=", "TTY", /^S6 the \[GLUE\]/]]) {
    const g = runtimeOf(names);
    ({ results } = staticChecks({ glue: g.glue.replace(cut, "/*cut*/"), wasmBytes: g.wasmBytes }));
    assert.equal(byLabel(results, line).ok, false, cut);
    assert.match(byLabel(results, line).extra, new RegExp(`(?:^|; )${id.replace(/[[\]]/g, "\\$&")}: `), cut);
  }
  // an unreadable lean.wasm fails S1 and S2 (the gate's fake-artifact test boots on such bytes)
  ({ results } = staticChecks({ glue: rt.glue, wasmBytes: Buffer.from("not wasm") }));
  assert.match(byLabel(results, /^S2/).extra, /lean\.wasm unreadable/);
  assert.equal(byLabel(results, /statically linked module/).ok, false);
});

// a runtime of this line before 0039: a MAIN_MODULE (dylink.0, GOT imports) whose glue holds 0017's export-set gate
const OLD_GATE = "function qed64_symbol_exists(sym){if(!Module.qed64ExportSet){Module.qed64ExportSet=new Set(Object.keys(wasmExports))}return Module.qed64ExportSet.has(sym)}";
const DYNAMIC = { customs: ["dylink.0"], imports: [["a", "b", 2], ["a", "c", 0], ["GOT.mem", "__heap_base", 3], ["GOT.func", "f", 3]] };
const olderRuntime = (names, extraGlue = "") => runtimeOf(names, `${OLD_GATE}\n${extraGlue}`, DYNAMIC);

test("an older runtime is held to what it promised: S1 skipped, S2 without the 0039 names, S6 in full; the repository seed only from 0039", () => {
  const base = CONTRACT.filter((c) => c.patch === null).map((c) => c.name);
  // before 0039 the glue binds the built-ins to globals only, not on Module (r3: `_pthread_self=wasmExports["pthread_self"]`)
  const builtins = 'function more(wasmExports){_pthread_self=wasmExports["pthread_self"];__emscripten_check_mailbox=wasmExports["_emscripten_check_mailbox"]}';
  let { level, results } = staticChecks(olderRuntime(base, builtins));
  assert.equal(level, "base");
  assert.equal(byLabel(results, /S1 skipped/).note, true);
  assert.equal(byLabel(results, /^S2/).ok, true, byLabel(results, /^S2/).extra);
  assert.equal(byLabel(results, /^S6 K6 /).ok, true, byLabel(results, /^S6 K6 /).extra);
  assert.equal(byLabel(results, /^S6 the \[GLUE\]/).ok, true);
  ({ results } = staticChecks({ ...olderRuntime(base, builtins), seed: ["_lean_extra_from_the_seed"] }));
  assert.equal(byLabel(results, /^S2/).ok, true); // the seed binds a 0039 runtime only
  ({ results } = staticChecks(olderRuntime(base)));
  // no binding at all: the kick is K6's (QED64's worker), _pthread_self the rest's (the copy lean4game pins)
  assert.match(byLabel(results, /^S6 K6 /).extra, /^__emscripten_check_mailbox: /);
  assert.match(byLabel(results, /^S6 the \[GLUE\]/).extra, /(?:^|; )_pthread_self: /);
  // 0038's three counters are required of no runtime since D3b: a glue that still binds them is held to the rest
  const counters0038 = ["_lean_wasm_task_manager_stat", "_lean_wasm_engine_probes", "_lean_wasm_engine_guard_trips"];
  for (const lv of ["base", "0039", "0041"]) for (const n of counters0038) assert.equal(requiredExports(lv, []).includes(n), false, `${lv} ${n}`);
  ({ level, results } = staticChecks(olderRuntime([...base, ...counters0038], builtins)));
  assert.equal(level, "base"); // a glue with 0038's names and 0017's gate: there was a level "0038" until D3b
  assert.equal(byLabel(results, /^S2/).ok, true, byLabel(results, /^S2/).extra);
  ({ results } = staticChecks({ ...runtimeOf(), seed: ["_lean_extra_from_the_seed"] }));
  assert.match(byLabel(results, /^S2/).extra, /_lean_extra_from_the_seed not bound on Module/);
});

test("a 0039 runtime whose glue lost _lean_wasm_symtab_stats is still 0039 (its static module, or a pre-D3b glue without 0017's gate, says so): S2 fails on the name", () => {
  const all = CONTRACT.map((c) => c.name);
  const lost = all.filter((n) => n !== "_lean_wasm_symtab_stats");
  let { level, results } = staticChecks({ ...runtimeOf(lost), seed: all });
  assert.equal(level, "0039");
  assert.equal(byLabel(results, /S1 no generated Lean name/).ok, true); // S1 ran
  assert.match(byLabel(results, /^S2/).label, new RegExp(`${all.length} names .*with the repository's seed`));
  assert.match(byLabel(results, /^S2/).extra, /_lean_wasm_symtab_stats not bound on Module/);
  // a glue from 0038 until D3b (it binds 0038's counter export), dynamically linked, without 0017's gate: 0039, and S1 fails the link
  const MARK_0038 = 'Module["_lean_wasm_task_manager_stat"]=wasmExports["zz"];';
  ({ level, results } = staticChecks(runtimeOf(lost, MARK_0038, DYNAMIC)));
  assert.equal(level, "0039");
  assert.equal(byLabel(results, /statically linked module/).ok, false);
  // the same with 0017's gate is held to the base contract; without lean.wasm the glue alone decides
  assert.equal(staticChecks(runtimeOf(lost, `${MARK_0038}\n${OLD_GATE}`, DYNAMIC)).level, "base");
  assert.equal(contractLevel(runtimeOf(lost).glue + MARK_0038), "0039");
  assert.equal(contractLevel('var leanPthreadPoolTarget=leanPoolInt(Module["pthreadPoolSize"],24,0,64);'), "0039"); // 0038's pool variable marks it too
  assert.equal(contractLevel(runtimeOf(lost).glue + MARK_0038 + OLD_GATE), "base");
  assert.equal(contractLevel(runtimeOf(lost).glue + OLD_GATE, readWasm(runtimeOf(lost).wasmBytes)), "0039"); // static wins
  assert.equal(contractLevel(OLD_GATE, readWasm(Buffer.from("not wasm"))), "base");
  // a glue from D3b on carries no 0038 name: alone it reads "base", and S2 still fails, as lean.wasm is unreadable
  assert.equal(contractLevel(runtimeOf(lost).glue), "base");
  ({ results } = staticChecks({ glue: runtimeOf(lost).glue, wasmBytes: Buffer.from("not wasm") }));
  assert.equal(byLabel(results, /^S2/).ok, false);
});

test("runtime-contract.mjs's copy of the contract is src/emscripten-exports.seed.txt", (t) => {
  const seed = path.resolve(pkg, "..", "..", "src", "emscripten-exports.seed.txt");
  if (!fs.existsSync(seed)) return t.skip(`${seed} is not checked out`);
  assert.deepEqual(parseSeed(fs.readFileSync(seed, "utf8")).sort(), CONTRACT.map((c) => c.name).sort());
  assert.deepEqual(parseSeed("# c\n_a   # x\n\n  _b\n#_c\n"), ["_a", "_b"]);
});

test("RUNTIME_METHODS are the lean link's -sEXPORTED_RUNTIME_METHODS (src/CMakeLists.txt); what exists on Module only", (t) => {
  // on Module only since emsdk 7: four runtime methods, and every export of the contract but the four the glue reads itself
  assert.deepEqual(CONTRACT.map((c) => c.name).filter((n) => !moduleOnly(n)).sort(), [...EXPORT_GLOBALS].sort());
  for (const n of ["_main", "_free", "_lean_wasm_compile", "_lean_apply_m"]) assert.equal(moduleOnly(n), true, n);
  for (const m of MODULE_ONLY_METHODS) assert.ok(RUNTIME_METHODS.includes(m) && moduleOnly(m) && !GLUE_NAMES.includes(m), m);
  for (const n of ["FS", "ENV", "callMain", "UTF8ToString", "NODEFS", "_lean_not_in_the_contract", "_proc_exit"]) assert.equal(moduleOnly(n), false, n);
  assert.equal(moduleOnly("_lean_x", ["_lean_x"]), true); // against another contract (exports-audit's --seed)
  const cmake = path.resolve(pkg, "..", "..", "src", "CMakeLists.txt");
  if (!fs.existsSync(cmake)) return t.skip(`${cmake} is not checked out`);
  assert.deepEqual([...fs.readFileSync(cmake, "utf8").matchAll(/-sEXPORTED_RUNTIME_METHODS=([\w,]+)/g)].map((m) => m[1].split(",")), [[...RUNTIME_METHODS]]);
});

// ---------- exports-audit.mjs ----------

test("exports-audit: every runtime name a consumer touches is in the contract or guarded; unknown and unguarded names fail", () => {
  const root = tmp(), tree = path.join(root, "consumer");
  write(path.join(tree, "workers", "lean.worker.js"), [
    "const r = M._lean_wasm_compile(a, b); self._pthread_self(); M['_lean_init_task_manager_using'](4);",
    "// the kick: _emscripten_check_mailbox (the raw wasm name) through __emscripten_check_mailbox()",
    "if (typeof PThread !== 'undefined') PT.unusedWorkers.length; const t = TTY.ttys[0]; FS.mkdirTree('/x');",
    "function local(worker) { return typeof worker; }",
    "M.noInitialRun = true; self.someGlueVar; M._lean_not_in_the_contract();",
  ].join("\n"));
  write(path.join(tree, "node_modules", "dep", "index.js"), "M._lean_from_a_dependency();");
  write(path.join(tree, "public", "runtime", "lean.js"), 'var Module=typeof Module!="undefined"?Module:{};M._lean_inside_a_glue_copy();');
  // an emsdk 7.0.0 glue copy (strict typeof, emscripten#27927) is skipped as well
  write(path.join(tree, "public", "runtime-7", "lean.js"), 'var Module=typeof Module!=="undefined"?Module:{};M._lean_inside_a_7_glue_copy();');
  const glue = path.join(root, "glue.js");
  write(glue, 'var Module=typeof Module!="undefined"?Module:{};var someGlueVar=1;var PThread={};function f(){var worker=1;return worker}var a,b,c;');
  const run = (...args) => spawnSync(process.execPath, [path.join(pkg, "exports-audit.mjs"), ...args], { encoding: "utf8" });
  let r = run("--glue", glue, "--json", tree);
  assert.equal(r.status, 1, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.files, 1);
  assert.equal(j.skippedGlueCopies, 2);
  assert.deepEqual(j.unknown.map((u) => u.name), ["_lean_not_in_the_contract"]);
  assert.deepEqual(j.unguarded.map((u) => u.name), ["someGlueVar"]);
  assert.deepEqual(j.contract.map((u) => u.name), ["__emscripten_check_mailbox", "_emscripten_check_mailbox", "_lean_init_task_manager_using", "_lean_wasm_compile", "_pthread_self"]);
  assert.ok(j.guarded.some((u) => u.name === "PThread") && j.guarded.some((u) => u.name === "noInitialRun"));
  assert.ok(!j.unguarded.some((u) => u.name === "worker")); // a consumer's local, and only a glue function's local
  assert.deepEqual(j.members.map((u) => u.name).sort(), ["FS.mkdirTree", "PThread.unusedWorkers", "TTY.ttys"]);
  r = run(tree);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /UNKNOWN exports \(neither in the contract nor a guarded glue name\) \(1\):\n  _lean_not_in_the_contract/);
  assert.match(r.stdout, /AUDIT: 1 name\(s\) the contract and S6 do not cover/); // without --glue only S6's own names are recognized
  fs.writeFileSync(path.join(tree, "workers", "lean.worker.js"), "M._lean_wasm_compile(a, b); self.someGlueVar;");
  r = run("--glue", glue, tree);
  assert.equal(r.status, 1);
  fs.writeFileSync(path.join(tree, "workers", "lean.worker.js"), "M._lean_wasm_compile(a, b); self.checkMailbox = x;");
  r = run("--glue", glue, tree);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /AUDIT: every name is covered/);
  // a chain is read at every link: Module, then the glue global behind it
  write(glue, 'var Module=typeof Module!="undefined"?Module:{};var someGlueVar=1;var HEAPU8;var someInternal;');
  fs.writeFileSync(path.join(tree, "workers", "lean.worker.js"),
    "const b = globalThis.Module.HEAPU8?.buffer; self.Module.someInternal(); window.Module?.checkMailbox; M._lean_wasm_compile(a, b);");
  r = run("--glue", glue, "--json", tree);
  assert.equal(r.status, 1, r.stdout);
  const chained = JSON.parse(r.stdout);
  assert.deepEqual(chained.unguarded.map((u) => u.name), ["HEAPU8", "someInternal"]);
  assert.deepEqual(chained.guarded.map((u) => u.name), ["checkMailbox", "Module"]);
  assert.equal(run().status, 2);
  assert.equal(run("--nope", tree).status, 2);
  assert.equal(run(path.join(root, "absent")).status, 2);
  for (const flag of ["--glue", "--seed"]) {
    r = run(flag, path.join(root, "no-such-file.js"), tree);
    assert.equal(r.status, 2, `${flag}: ${r.stderr}`);
    assert.match(r.stderr, /no-such-file\.js not found/);
    assert.doesNotMatch(r.stderr, /\n\s+at /); // a usage error, not a stack trace
  }
  assert.equal(run("--help").status, 0);
});

test("exports-audit: a Module-only name read off the global scope or named bare in code is BARE (no global since emsdk 7); FS members a glue lacks are marked", () => {
  const root = tmp(), tree = path.join(root, "consumer");
  const BARE = [
    "_free(p); const v = self.getValue(x, 'i8'); globalThis._lean_wasm_compile(a, b); typeof ccall; window['stringToNewUTF8'];",
    "if (typeof _main === 'function') {}",
  ];
  const FINE = [
    // Module reads, the four exports the glue keeps as globals, keys, method definitions, declarations, comments, strings
    "M._free(p); M.getValue(x); Module['_lean_mk_string'](s); self.Module._lean_initialize(); M?._main; _malloc(8n); __emscripten_check_mailbox(); _pthread_self();",
    "const fake = { _free: () => {}, _lean_wasm_compile(a, b) { return 0; }, _lean_mk_string() {} };",
    "// _free(ptr) after the load; \"_lean_wasm_compile(code)\"; `_main()`",
    "const msg = `needs _lean_wasm_load_snapshot_mem in the runtime`; function _free() {} /* _lean_initialize() */",
    "FS.mount(M.WORKERFS ?? FS.filesystems.WORKERFS, {}, '/p');",
  ];
  write(path.join(tree, "worker.js"), [...BARE, ...FINE].join("\n"));
  write(path.join(tree, "types.d.ts"), "interface M { _free(p: bigint): void; _lean_wasm_compile?(a: bigint, b: bigint): number; _main: () => void; }");
  const glue7 = path.join(root, "glue-7.js"), glue6 = path.join(root, "glue-6.js");
  write(glue7, 'var Module=typeof Module!=="undefined"?Module:{};var FS={mount(){}};var WORKERFS={};Module["getValue"]=function(ptr){};');
  write(glue6, 'var Module=typeof Module!="undefined"?Module:{};var FS={mount(){},filesystems:null};var WORKERFS={};function getValue(ptr){}');
  const run = (...args) => spawnSync(process.execPath, [path.join(pkg, "exports-audit.mjs"), ...args], { encoding: "utf8" });
  let r = run("--glue", glue7, "--json", tree);
  assert.equal(r.status, 1, r.stderr);
  let j = JSON.parse(r.stdout);
  assert.deepEqual(j.bare.map((u) => u.name).sort(), ["_free", "_lean_wasm_compile", "_main", "ccall", "getValue", "stringToNewUTF8"]);
  assert.deepEqual([j.unknown, j.unguarded], [[], []]);
  assert.ok(["getValue", "WORKERFS"].every((n) => j.guarded.some((u) => u.name === n)), JSON.stringify(j.guarded)); // read on Module: runtime methods
  assert.deepEqual(j.members.filter((m) => m.absent).map((m) => m.name), ["FS.filesystems"]); // gone from emsdk 7's glue (emscripten#27940)
  r = run("--glue", glue7, tree);
  assert.match(r.stdout, /^BARE reads of Module-only names \(no global binding since emsdk 7: read them on Module\) \(6\):\n {2}_free {3}consumer\/worker\.js$/m);
  assert.match(r.stdout, /^members of FS: .*filesystems \(not in --glue\)/m);
  assert.match(r.stdout, /AUDIT: 6 name\(s\) the contract and S6 do not cover, or read bare/);
  // a glue that still names the member marks nothing; without the bare reads the tree passes, on either glue
  j = JSON.parse(run("--glue", glue6, "--json", tree).stdout);
  assert.deepEqual(j.members.filter((m) => m.absent), []);
  write(path.join(tree, "worker.js"), FINE.join("\n"));
  for (const glue of [glue7, glue6]) {
    r = run("--glue", glue, tree);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /AUDIT: every name is covered/);
  }
});

test("exports-audit: a Module-only method named bare is BARE in a file whose code names Module, importScripts or FS; no mention in a comment or a string is", () => {
  const root = tmp(), tree = path.join(root, "consumer");
  const run = (...args) => spawnSync(process.execPath, [path.join(pkg, "exports-audit.mjs"), ...args], { encoding: "utf8" });
  /** The BARE rows ("name file,…") of a tree of `files` ({ path: text }); a BARE read fails the audit like any other. */
  const bare = (files) => {
    fs.rmSync(tree, { recursive: true, force: true });
    for (const [name, text] of Object.entries(files)) write(path.join(tree, name), text);
    const r = run("--json", tree);
    const rows = JSON.parse(r.stdout).bare.map((u) => `${u.name} ${[...u.files].sort().join(",")}`).sort();
    assert.equal(r.status, rows.length ? 1 : 0, r.stdout);
    return rows;
  };
  // a bare call in a worker-like file, one whose code names importScripts, Module or FS (of an .html file, its <script>)
  assert.deepEqual(bare({
    "worker.js": 'importScripts("lean.js");\nconst n = getValue(p, "i64");',
    "boot.mjs": "self.Module = { preRun: [() => setValue(p, 1, 'i32')] };",
    "mount.ts": "FS.mkdirTree('/w'); const s = stringToNewUTF8(path);",
    "page.html": '<script>var Module = {}; Module.onRuntimeInitialized = () => ccall("main", null, [], []);</script>',
  }), ["ccall consumer/page.html", "getValue consumer/worker.js", "setValue consumer/boot.mjs", "stringToNewUTF8 consumer/mount.ts"]);
  assert.match(run(tree).stdout, /^BARE reads of Module-only names .*\(4\):\n {2}ccall {3}consumer\/page\.html$[\s\S]*AUDIT: 4 name\(s\) the contract and S6 do not cover, or read bare/m);
  // the same calls in files whose code names none of them are the files' own (a React state setter, a library's
  // getValue): Module, importScripts or FS named in a comment, a string or an .html file's text do not count
  assert.deepEqual(bare({
    "view.tsx": 'const [value, setValue] = useState("");\nsetValue(x); const n = getValue(p, "i64");',
    "lib.js": '// after importScripts, Module and FS are up\nconst label = "Module"; ccall("main", null, [], []); stringToNewUTF8(path);',
    "page.html": '<p>var Module = {}; ccall("main", null, [], []);</p><script>run();</script>',
  }), []);
  // in a worker-like file, a mention in a comment, a string, a template or an .html file's text is no read; nor are a
  // local definition or declaration, an object key, a method definition, a TS signature, or a read off an object
  assert.deepEqual(bare({
    "worker.js": [
      'importScripts("lean.js"); // getValue(p, "i64") once the runtime is up; setValue(p, 1) too',
      'const s = "ccall(\'main\')", t = `stringToNewUTF8(${x})`; /* getValue(p) */',
      "function getValue(o) { return o.v; } const setValue = (o, v) => { o.v = v; }; let ccall;",
      "const api = { getValue: 1, setValue(o, v) {}, stringToNewUTF8(s) { return s; } }; class Store { ccall(name) { return name; } }",
      'M.getValue(p, "i64"); Module.ccall("main", null, [], []); store?.setValue(1); Module["stringToNewUTF8"](s);',
    ].join("\n"),
    "types.d.ts": "declare const Module: { getValue(p: number, t: string): number; ccall?(n: string): number; setValue: (p: number) => void };",
    "page.html": '<p>getValue(p, "i64") is prose</p>\n<script>var Module = {};</script>',
  }), []);
  // the global-scope and typeof forms are BARE in code (any file), and not in a comment, a string or a template
  const FORMS = "self.getValue(p); globalThis._free(p); typeof ccall; window?.stringToNewUTF8; self['_main']; typeof _lean_wasm_compile;";
  assert.deepEqual(bare({ "worker.js": `importScripts("lean.js");\n${FORMS}`, "node.mjs": FORMS }),
    ["_free", "_lean_wasm_compile", "_main", "ccall", "getValue", "stringToNewUTF8"].map((n) => `${n} consumer/node.mjs,consumer/worker.js`));
  assert.deepEqual(bare({
    "worker.js": `importScripts("lean.js");\n// ${FORMS}\n/* ${FORMS} */ const why = ${JSON.stringify(FORMS)};`,
    "node.mjs": `// ${FORMS}\nconst t = \`${FORMS}\`;`,
  }), []);
  // a regex literal in an arrow body (`=> /…/`) is a literal: its `//`, a quote or a backtick in it hides no code after
  // it on the line (or the lines after), and turns no string's text into code
  assert.deepEqual(bare({
    "worker.js": 'importScripts("lean.js"); const isUrl = (s) => /^https?:\\/\\//i.test(s); self.getValue(p, "i64"); typeof ccall; _free(p);',
    "tick.js": 'importScripts("lean.js"); const isTick = (s) => /`/.test(s);\nsetValue(p, 1, "i32"); const done = `ok`;',
    "quote.js": 'importScripts("lean.js"); const isQuote = (s) => /"/.test(s); const why = "call getValue(p) first, then _free(p)";',
  }), ["_free consumer/worker.js", "ccall consumer/worker.js", "getValue consumer/worker.js", "setValue consumer/tick.js"]);
});
