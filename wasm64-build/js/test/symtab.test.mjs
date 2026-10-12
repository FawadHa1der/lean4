// Kernel patch 0039, without a runtime: the generator of the native-symbol table and the export
// list (../gen-exports.py, on synthetic C, with a fake nm), the link check (../check-link.py), the
// static contract checks the gate runs (runtime-contract.mjs, on synthetic glue and wasm bytes), the
// consumer audit (exports-audit.mjs, on a fixture tree) and the stack-margin bisection
// (../stack-margin.mjs, on a fake runtime). The Python tools need python3; their tests skip without it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT, GLUE_SURFACE, contractLevel, exportBindings, parseSeed, readWasm, requiredExports, staticChecks } from "../runtime-contract.mjs";

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
  write(path.join(bin, "lean.js.symbols"), "0:main\n1:l_A___boxed\n");
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
  write(path.join(bin, "lean.js.symbols"), "0:main\n7:signature_mismatch:l_A___boxed\n");
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

test("the shipped allowlist starts uncalibrated and says how it is calibrated", () => {
  const text = fs.readFileSync(path.join(BUILD, "link-undefined-allowlist.txt"), "utf8");
  assert.doesNotMatch(text, /^#\s*calibrated-from:/m);
  assert.match(text, /NOT CALIBRATED YET/);
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
  'var checkMailbox=()=>{var pthread_ptr=_pthread_self();if(!pthread_ptr)return;runtimeKeepalivePush();callUserCallback(()=>{__emscripten_check_mailbox()})};',
  'var FS={mkdirTree(path,mode){},makedev:(ma,mi)=>ma<<8|mi,filesystems:null};FS.filesystems={MEMFS,NODEFS,WORKERFS};',
  'var TTY={ttys:[],stream_ops:{write(stream,buffer){stream.tty.ops.put_char(stream.tty,buffer[0])}},default_tty_ops:{put_char(tty,val){},fsync(tty){}}};',
  'function callMain(args=[]){var entryFunction=__emscripten_proxy_main;runtimeKeepalivePush();throw"unwind"}',
  ...["callMain", "FS", "ENV", "getValue", "setValue", "stringToNewUTF8", "UTF8ToString", "ccall"].map((m) => `Module["${m}"]=${m};`),
].join("\n");
/** A 0039 glue binding `names` to minified raw exports, and its wasm (every raw name a function export). */
function runtimeOf(names = CONTRACT.map((c) => c.name), extraGlue = "", wasmExtra = {}) {
  const bind = names.map((n, i) => `${n}=Module["${n}"]=wasmExports["e${i}"];`).join("");
  const glue = `${SURFACE}\nfunction assignWasmExports(wasmExports){${bind}}\n${extraGlue}`;
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

test("the static checks pass a 0039 runtime that keeps the contract and the glue surface", () => {
  const rt = runtimeOf();
  assert.equal(contractLevel(rt.glue), "0039");
  const { level, results } = staticChecks(rt);
  assert.equal(level, "0039");
  for (const r of results) if (!r.note) assert.equal(r.ok, true, `${r.label}: ${r.extra}`);
  assert.equal(results.filter((r) => !r.note).length, 6); // S1 x4, S2, S6
  assert.match(byLabel(results, /^S6 test-probe/).label, /all 4 present/);
  for (const s of GLUE_SURFACE) assert.equal(s.test(rt.glue), true, s.id);
  assert.equal(exportBindings(rt.glue).get("_lean_wasm_compile"), `e${CONTRACT.findIndex((c) => c.name === "_lean_wasm_compile")}`);
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
  for (const [cut, id] of [['throw"unwind"', '"unwind"'], ["pthread_ptr+204", "mailbox await"], ["exitOnMainThread,pthreadCreateProxied", "proxiedFunctionTable"],
    ["runtimeKeepalivePush();callUserCallback", "checkMailbox"], ["var TTY=", "TTY"]]) {
    const g = runtimeOf(names);
    ({ results } = staticChecks({ glue: g.glue.replace(cut, "/*cut*/"), wasmBytes: g.wasmBytes }));
    assert.equal(byLabel(results, /^S6 the \[GLUE\]/).ok, false, cut);
    assert.match(byLabel(results, /^S6 the \[GLUE\]/).extra, new RegExp(id.replace(/[[\]]/g, "\\$&")), cut);
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

test("an older runtime is held to what it promised: S1 skipped, S2 without the 0038/0039 names, S6 in full; the repository seed only from 0039", () => {
  const base = CONTRACT.filter((c) => c.patch === null).map((c) => c.name);
  // before 0039 the glue binds the built-ins to globals only, not on Module (r3: `_pthread_self=wasmExports["pthread_self"]`)
  const builtins = 'function more(wasmExports){_pthread_self=wasmExports["pthread_self"];__emscripten_check_mailbox=wasmExports["_emscripten_check_mailbox"]}';
  let { level, results } = staticChecks(olderRuntime(base, builtins));
  assert.equal(level, "base");
  assert.equal(byLabel(results, /S1 skipped/).note, true);
  assert.equal(byLabel(results, /^S2/).ok, true, byLabel(results, /^S2/).extra);
  assert.equal(byLabel(results, /^S6 the \[GLUE\]/).ok, true);
  ({ results } = staticChecks({ ...olderRuntime(base, builtins), seed: ["_lean_extra_from_the_seed"] }));
  assert.equal(byLabel(results, /^S2/).ok, true); // the seed binds a 0039 runtime only
  ({ results } = staticChecks(olderRuntime(base)));
  assert.match(byLabel(results, /^S6 the \[GLUE\]/).extra, /_pthread_self, __emscripten_check_mailbox/); // no binding at all
  const with0038 = [...base, "_lean_wasm_task_manager_stat", "_lean_wasm_engine_probes", "_lean_wasm_engine_guard_trips"];
  ({ level } = staticChecks(olderRuntime(with0038)));
  assert.equal(level, "0038");
  assert.deepEqual(requiredExports("0038"), with0038);
  ({ results } = staticChecks({ ...runtimeOf(), seed: ["_lean_extra_from_the_seed"] }));
  assert.match(byLabel(results, /^S2/).extra, /_lean_extra_from_the_seed not bound on Module/);
});

test("a 0039 runtime whose glue lost _lean_wasm_symtab_stats is still 0039 (its static module, or its glue without 0017's gate, says so): S2 fails on the name", () => {
  const all = CONTRACT.map((c) => c.name);
  const lost = all.filter((n) => n !== "_lean_wasm_symtab_stats");
  let { level, results } = staticChecks({ ...runtimeOf(lost), seed: all });
  assert.equal(level, "0039");
  assert.equal(byLabel(results, /S1 no generated Lean name/).ok, true); // S1 ran
  assert.match(byLabel(results, /^S2/).label, new RegExp(`${all.length} names .*with the repository's seed`));
  assert.match(byLabel(results, /^S2/).extra, /_lean_wasm_symtab_stats not bound on Module/);
  // a dynamically linked module, but a glue with 0038's names and without 0017's gate: 0039, and S1 fails the link
  ({ level, results } = staticChecks(runtimeOf(lost, "", DYNAMIC)));
  assert.equal(level, "0039");
  assert.equal(byLabel(results, /statically linked module/).ok, false);
  // the same with 0017's gate is a 0038 runtime; without lean.wasm the glue alone decides
  assert.equal(staticChecks(runtimeOf(lost, OLD_GATE, DYNAMIC)).level, "0038");
  assert.equal(contractLevel(runtimeOf(lost).glue), "0039");
  assert.equal(contractLevel(runtimeOf(lost).glue + OLD_GATE), "0038");
  assert.equal(contractLevel(runtimeOf(lost).glue + OLD_GATE, readWasm(runtimeOf(lost).wasmBytes)), "0039"); // static wins
  assert.equal(contractLevel(OLD_GATE, readWasm(Buffer.from("not wasm"))), "base");
});

test("runtime-contract.mjs's copy of the contract is src/emscripten-exports.seed.txt", (t) => {
  const seed = path.resolve(pkg, "..", "..", "src", "emscripten-exports.seed.txt");
  if (!fs.existsSync(seed)) return t.skip(`${seed} is not checked out`);
  assert.deepEqual(parseSeed(fs.readFileSync(seed, "utf8")).sort(), CONTRACT.map((c) => c.name).sort());
  assert.deepEqual(parseSeed("# c\n_a   # x\n\n  _b\n#_c\n"), ["_a", "_b"]);
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
  const glue = path.join(root, "glue.js");
  write(glue, 'var Module=typeof Module!="undefined"?Module:{};var someGlueVar=1;var PThread={};function f(){var worker=1;return worker}var a,b,c;');
  const run = (...args) => spawnSync(process.execPath, [path.join(pkg, "exports-audit.mjs"), ...args], { encoding: "utf8" });
  let r = run("--glue", glue, "--json", tree);
  assert.equal(r.status, 1, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.files, 1);
  assert.equal(j.skippedGlueCopies, 1);
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

// ---------- ../stack-margin.mjs ----------

test("stack-margin.mjs bisects the pthread stack each probe survives and passes with (a fake runtime)", () => {
  const art = tmp();
  // the fake: Lean's error below 0.6 MiB, a RangeError below 0.3 (Fin 40); an overflow ends the run at once
  write(path.join(art, "bin", "lean.js"), [
    "const mb = Number(process.env.LEAN4_WASM64_PTHREAD_STACK_MB);",
    "const work = process.argv[process.argv.indexOf('--work') + 1];",
    "const src = require('node:fs').readFileSync(work + '/input.lean', 'utf8');",
    "if (!src.includes('Fin 40')) throw new Error('unexpected probe');",
    "if (mb < 0.3) console.log('Uncaught RangeError: Maximum call stack size exceeded');",
    "else { if (mb < 0.6) console.log('/work/input.lean:1:0: error: maximum recursion depth has been reached'); console.log('MARGIN DONE'); }",
    "setInterval(() => {}, 1000);", ""].join("\n"));
  write(path.join(art, "bin", "lean.wasm"), "fake");
  write(path.join(art, "bin", "package.json"), '{"type":"commonjs"}');
  fs.mkdirSync(path.join(art, "lib", "lean"), { recursive: true });
  const json = path.join(art, "margins.json");
  const run = (...args) => spawnSync(process.execPath, [path.join(BUILD, "stack-margin.mjs"), "--artifact", art, ...args], { encoding: "utf8", timeout: 120_000 });
  const r = run("--probes", "fin", "--lo", "0.2", "--hi", "1", "--step", "0.05", "--timeout-ms", "20000", "--json", json, "--no-lock-check");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const fin = JSON.parse(fs.readFileSync(json, "utf8")).results.fin;
  assert.ok(fin.survives.mb >= 0.3 && fin.survives.mb <= 0.35, JSON.stringify(fin.survives));
  assert.ok(fin.passes.mb >= 0.6 && fin.passes.mb <= 0.65, JSON.stringify(fin.passes));
  assert.deepEqual([...new Set(fin.trials.map((t) => t.outcome))].sort(), ["guard", "ok", "overflow"]);
  assert.match(r.stdout, /fin: survives from 0\.3\d* MiB, passes from 0\.6\d* MiB/);
  // outside the host lock it refuses to start; a proof that never passes is exit 1
  assert.equal(run("--probes", "fin").status, 2);
  const never = run("--probes", "fin", "--lo", "0.1", "--hi", "0.5", "--step", "0.2", "--timeout-ms", "20000", "--no-lock-check");
  assert.equal(never.status, 1, never.stdout);
  assert.match(never.stdout, /passes from more than 0\.5 MiB/);
});
