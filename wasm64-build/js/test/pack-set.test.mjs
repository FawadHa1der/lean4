// pack-set.mjs over fake kernel build dirs (an import build and a later
// runtime build): the selection, the placeholders per build, the compilers
// record, the refusals before packing (Init in an Init-free tree, a module
// shared by packs that must be disjoint, a root with no .olean, a tree that is
// not its module list, a closedOver manifest absent from --out), the import
// closure after packing (over oleans with real import tables), and the copy
// fallback when a hard link cannot be made (EXDEV, simulated).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildIdFromSha256, sha256Hex } from "../artifact-id.mjs";

const made = [];
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (args, node = [], env = {}) =>
  spawnSync(process.execPath, [...node, path.join(pkg, "pack-set.mjs"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });
const BUILT = "8d91aadcda8a0b231e47c42d4ff4b9b8360563aa";
const NATIVE = "857544b439aa51633344d638dacc03d304b9ea96";
const MATHLIB = "5ed2965256430c3649e86755f9576b54eca72435";
const RUNTIME = "a8817d01f97227b1b04cc7d661b9e396f6ca8f34";
const ROOTS = ["Mathlib.Analysis.SpecialFunctions.Complex.Circle", "Mathlib.Geometry.Manifold.Instances.Sphere", "Mathlib.Geometry.Manifold.IsManifold.Basic"];
const oleanOf = (name) => `${name.split(".").join("/")}.olean`;
const putter = (dir) => (rel, bytes) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), bytes); };

function runtimeDir() {
  const R = mkdtemp("l4w-r-");
  const put = putter(R);
  const wasm = Buffer.from("a later wasm");
  put("build/stage1/bin/lean.wasm", wasm);
  for (const f of ["Init.olean", "Init/Prelude.olean", "Std.olean", "Lean.olean", "Lake.olean", "Lake/Build.olean", "Lake/Build.ir",
    "LakeMain.olean", "LeanChecker.olean", "LeanIR.olean", "Leanc.olean"]) put(`build/stage1/lib/lean/${f}`, Buffer.alloc(32, 7));
  put("build/stage1/lib/lean/libLean.a", Buffer.alloc(16, 9)); // not a facet: never packed
  put("BUILT-COMMIT", `${RUNTIME}\n`);
  return { R, buildId: buildIdFromSha256(sha256Hex(wasm)) };
}

const ESSENTIAL_FILES = ["Mathlib.olean", ...ROOTS.map(oleanOf), "Lean.olean", "Std.olean"];
function buildDir() {
  const K = mkdtemp("l4w-k-");
  const put = putter(K);
  const wasm = Buffer.from("not really wasm");
  put("build/stage1/bin/lean.wasm", wasm);
  for (const f of ["Init.olean", "Init.olean.server", "Init.olean.private", "Init.ir", "Init.ir.sig", "Init/Prelude.olean", "Init/Prelude.olean.server",
    "Std.olean", "Lean.olean", "Lake.olean", "LakeMain.olean", "LeanChecker.olean", "LeanIR.olean", "Leanc.olean"]) put(`build/stage1/lib/lean/${f}`, Buffer.alloc(64, 1));
  for (const f of ESSENTIAL_FILES) put(`mathlib/essential-tree/${f}`, Buffer.alloc(64, 2));
  put("mathlib/essential-modules.txt", `# mathlib-select's list\n${ESSENTIAL_FILES.map((f) => f.slice(0, -6).split("/").join(".")).join("\n")}\n\n`);
  put("mathlib/extra-tree/Mathlib/Extra.olean", Buffer.alloc(64, 3));
  put("mathlib/extra-modules.txt", "Mathlib.Extra\n");
  put("BUILT-COMMIT", `${BUILT}\n`);
  put("native/NATIVE-COMMIT", `${NATIVE}\n`);
  put("mathlib/MATHLIB-COMMIT", `${MATHLIB}\n`);
  return { K, put, buildId: buildIdFromSha256(sha256Hex(wasm)) };
}

// An .olean whose import table olean-imports.mjs reads: a 64-bit compacted
// region (header with base address and root pointer, then String, Name and
// Import objects, the imports Array and the ModuleData root), so the closure
// checks run on imports pack.mjs really reads (no --no-imports).
function olean(imports) {
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

const LIB = "build/stage1/lib/lean";
const ESSENTIAL = {
  [ROOTS[0]]: ["Init", "Init.Core", ROOTS[2]], // the implicit Init edge: pack.mjs drops it
  [ROOTS[1]]: ["Init", ROOTS[0]],
  [ROOTS[2]]: ["Lean"],
  Lean: ["Init", "Std"],
  Std: ["Init.Prelude"],
};
function importBuild(essential = ESSENTIAL) {
  const K = mkdtemp("l4w-i-");
  const put = putter(K);
  put("build/stage1/bin/lean.wasm", Buffer.from("a wasm with imports"));
  put(`${LIB}/Init.olean`, olean(["Init.Prelude", "Init.Core"]));
  put(`${LIB}/Init/Prelude.olean`, olean([]));
  put(`${LIB}/Init/Core.olean`, olean(["Init.Prelude"]));
  for (const f of ["Init.olean.server", "Init.olean.private", "Init.ir", "Init.ir.sig"]) put(`${LIB}/${f}`, Buffer.alloc(8));
  for (const [m, imports] of Object.entries(essential)) put(`mathlib/essential-tree/${oleanOf(m)}`, olean(imports));
  put("mathlib/essential-modules.txt", `${Object.keys(essential).join("\n")}\n`);
  put("BUILT-COMMIT", `${BUILT}\n`);
  put("native/NATIVE-COMMIT", `${NATIVE}\n`);
  put("mathlib/MATHLIB-COMMIT", `${MATHLIB}\n`);
  return { K, put };
}
const manifestOf = (out, id) => JSON.parse(fs.readFileSync(path.join(out, `${id}.manifest.json`), "utf8")).content;
const handManifest = (modules) => JSON.stringify({ format: "browser64.artifact-manifest", content: { modules: Object.fromEntries(modules.map((m) => [m, { imports: [] }])) } });

test("pack-set cuts every pack of packs.json from the import and the runtime build", () => {
  const { K, buildId } = buildDir();
  const { R, buildId: runtimeId } = runtimeDir();
  const out = path.join(K, "profiles");
  const r = run(["--build-dir", K, "--runtime-dir", R, "--out", out, "--lean-version", "4.34.0", "--no-imports"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const manifest = (id) => manifestOf(out, id);
  const core = manifest("lean-core");
  assert.deepEqual(Object.keys(core.modules).sort(), ["Init", "Init.Prelude"], "lean-core is the Init closure only");
  assert.equal(core.release, `lean-core-4.34.0-${buildId}`);
  assert.equal(core.lean.gitRevision, BUILT.slice(0, 12));
  assert.deepEqual(core.roots, ["Init"]);
  assert.match(core.pack.transport.parts[0].url, /^\/profiles\/lean-core\.pack\.gzip\.[0-9a-f]{20}\.part-000$/);
  assert.equal(manifest("mathlib-essential").release, `mathlib-essential-${MATHLIB.slice(0, 7)}-${buildId}`);
  const extra = manifest("mathlib-game-extra");
  assert.match(extra.pack.transport.parts[0].url, /^\/profiles\/mathlib-game-extra\.pack\.gzip\.[0-9a-f]{20}\.part-000$/);
  assert.deepEqual(extra.roots, []);
  // lean-lib: the RUNTIME build's whole lib/lean, named after that build
  const lib = manifest("lean-lib");
  assert.deepEqual(Object.keys(lib.modules).sort(), ["Init", "Init.Prelude", "Lake", "Lake.Build", "LakeMain", "Lean", "LeanChecker", "LeanIR", "Leanc", "Std"]);
  assert.equal(lib.release, `lean-lib-4.34.0-${runtimeId}`);
  assert.equal(lib.lean.gitRevision, RUNTIME.slice(0, 12));
  assert.equal(lib.workerfs.mountPoint, "/lib/lean");
  assert.ok(!lib.workerfs.metadata.files.some((f) => f.filename.endsWith(".a")), "static archives are not facets");
  assert.ok(!fs.readdirSync(out).some((f) => f.endsWith(".pack") || f.startsWith(".select-")), "no raw packs or side trees left");
  const record = JSON.parse(fs.readFileSync(path.join(out, "pack-set.json"), "utf8"));
  assert.deepEqual(record.packs.map((p) => [p.id, p.build, p.compiler]), [
    ["lean-core", "import", BUILT], ["mathlib-essential", "import", NATIVE],
    ["mathlib-game-extra", "import", NATIVE], ["lean-lib", "runtime", RUNTIME]]);
  assert.deepEqual(record.packs[1].mathlib, { commit: MATHLIB });
  assert.equal(record.packs[3].mathlib, undefined);
});

test("without --runtime-dir the runtime build is the import build", () => {
  const { K, buildId, put } = buildDir();
  put("build/stage1/lib/lean/Lake.olean", Buffer.alloc(8));
  const r = run(["--build-dir", K, "--out", path.join(K, "p"), "--lean-version", "4.34.0", "--no-imports", "--only", "lean-lib"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lib = JSON.parse(fs.readFileSync(path.join(K, "p", "lean-lib.manifest.json"), "utf8")).content;
  assert.equal(lib.release, `lean-lib-4.34.0-${buildId}`);
  assert.equal(lib.lean.gitRevision, BUILT.slice(0, 12));
});

test("pack-set refuses Init in an Init-free tree and a module shared by disjoint packs", () => {
  let { K, put } = buildDir();
  put("mathlib/essential-tree/Init.olean", Buffer.alloc(8));
  let r = run(["--build-dir", K, "--out", path.join(K, "p"), "--lean-version", "4.34.0", "--no-imports"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /mathlib-essential: .* holds Init/);
  ({ K, put } = buildDir());
  put("mathlib/extra-tree/Mathlib.olean", Buffer.alloc(8));
  r = run(["--build-dir", K, "--out", path.join(K, "p"), "--lean-version", "4.34.0", "--no-imports", "--only", "mathlib-game-extra"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /shares 1 module\(s\) with mathlib-essential, e\.g\. Mathlib\.olean/);
  assert.ok(!fs.existsSync(path.join(K, "p")), "refused before writing anything");
});

test("pack-set refuses a root with no .olean, before packing", () => {
  const { K, put } = buildDir();
  fs.rmSync(path.join(K, "mathlib/essential-tree", oleanOf(ROOTS[1])));
  put("mathlib/essential-modules.txt", ESSENTIAL_FILES.filter((f) => f !== oleanOf(ROOTS[1])).map((f) => f.slice(0, -6).split("/").join(".")).join("\n"));
  let r = run(["--build-dir", K, "--out", path.join(K, "p"), "--lean-version", "4.34.0", "--no-imports", "--only", "lean-core,mathlib-essential"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /mathlib-essential: root\(s\) with no \.olean in .*essential-tree: Mathlib\.Geometry\.Manifold\.Instances\.Sphere \(Mathlib\/Geometry\/Manifold\/Instances\/Sphere\.olean\) — renamed or dropped upstream\?/);
  assert.doesNotMatch(r.stderr, /lists|does not list/, "the list matches the tree; only the root is missing");
  assert.ok(!fs.existsSync(path.join(K, "p")), "refused before writing anything");
  // a root of an include pack must be in the selection, not merely in the tree
  const defs = JSON.parse(fs.readFileSync(path.join(pkg, "packs.json"), "utf8"));
  defs.packs[0].roots = ["Init", "Std"];
  fs.writeFileSync(path.join(K, "packs.json"), JSON.stringify(defs));
  r = run(["--build-dir", K, "--out", path.join(K, "p"), "--lean-version", "4.34.0", "--no-imports", "--only", "lean-core", "--packs", path.join(K, "packs.json")]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /lean-core: root\(s\) with no \.olean in .*lib\/lean \(its include selection\): Std \(Std\.olean\)/);
});

test("pack-set refuses a tree that is not its modulesList, naming the first differences", () => {
  const { K, put } = buildDir();
  put("mathlib/essential-tree/Mathlib/Unlisted.olean", Buffer.alloc(8));
  fs.appendFileSync(path.join(K, "mathlib/essential-modules.txt"), "Mathlib.Gone\nMathlib.AlsoGone\n");
  let r = run(["--build-dir", K, "--out", path.join(K, "p"), "--lean-version", "4.34.0", "--no-imports", "--only", "lean-core,mathlib-essential"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /mathlib-essential: mathlib\/essential-modules\.txt lists 2 module\(s\) with no \.olean in .*essential-tree, e\.g\. Mathlib\.AlsoGone, Mathlib\.Gone/);
  assert.match(r.stderr, /mathlib-essential: .*essential-tree holds 1 module\(s\) mathlib\/essential-modules\.txt does not list, e\.g\. Mathlib\.Unlisted/);
  assert.ok(!fs.existsSync(path.join(K, "p")), "refused before writing anything");
  fs.rmSync(path.join(K, "mathlib/extra-modules.txt"));
  r = run(["--build-dir", K, "--out", path.join(K, "p"), "--lean-version", "4.34.0", "--no-imports", "--only", "mathlib-game-extra"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /mathlib-game-extra: .*mathlib\/extra-modules\.txt missing/);
});

test("pack-set checks the import closure after packing and removes a pack whose imports dangle", () => {
  let { K } = importBuild();
  let out = path.join(K, "p");
  let r = run(["--build-dir", K, "--out", out, "--lean-version", "4.34.0", "--only", "lean-core,mathlib-essential"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const ess = manifestOf(out, "mathlib-essential");
  assert.deepEqual(ess.modules[ROOTS[0]].imports, ["Init.Core", ROOTS[2]], "real import tables were read; the Init edge is left out");
  assert.deepEqual(manifestOf(out, "lean-core").modules.Init.imports, ["Init.Core", "Init.Prelude"]);

  ({ K } = importBuild({ ...ESSENTIAL, "Mathlib.Bad": ["Init.Nope", "Mathlib.Missing", "Std"] }));
  out = path.join(K, "p");
  r = run(["--build-dir", K, "--out", out, "--lean-version", "4.34.0", "--only", "lean-core,mathlib-essential", "--keep-raw"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /REFUSED — mathlib-essential after packing \(its manifest and parts were removed from .*\):\n  2 dangling import\(s\), in none of mathlib-essential \+ lean-core: e\.g\. Mathlib\.Bad → Init\.Nope; Mathlib\.Bad → Mathlib\.Missing/);
  const left = fs.readdirSync(out);
  assert.ok(!left.some((f) => f.startsWith("mathlib-essential.")), `nothing of the refused pack is left: ${left}`);
  assert.ok(left.includes("lean-core.manifest.json"), "the pack that passed stays");
  assert.ok(!left.includes("pack-set.json"), "no record of a refused run");

  // a pack whose import tables all read as empty has no edges at all
  ({ K } = importBuild());
  for (const f of ["Init.olean", "Init/Core.olean"]) fs.writeFileSync(path.join(K, LIB, f), olean([]));
  r = run(["--build-dir", K, "--out", path.join(K, "p"), "--lean-version", "4.34.0", "--only", "lean-core"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /REFUSED — lean-core after packing .*\n  no import edges at all/);
});

test("closedOver resolves against a manifest already in --out, and refuses before packing when it is absent", () => {
  const { K } = importBuild();
  const out = path.join(K, "p");
  const args = ["--build-dir", K, "--out", out, "--lean-version", "4.34.0", "--only", "mathlib-essential"];
  let r = run(args);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /mathlib-essential: closed over lean-core, but .*\/p\/lean-core\.manifest\.json is absent \(pack lean-core in this run, or copy its manifest there first\)/);
  assert.ok(!fs.existsSync(out), "refused before writing anything");

  // a manifest copied there first (stage-release copies served packs before packing the rest)
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, "lean-core.manifest.json"), handManifest(["Init", "Init.Prelude", "Init.Core"]));
  r = run(args);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, "pack-set.json"), "utf8")).packs[0].id, "mathlib-essential");

  fs.writeFileSync(path.join(out, "lean-core.manifest.json"), handManifest(["Init", "Init.Prelude"]));
  r = run(args);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /1 dangling import\(s\), in none of mathlib-essential \+ lean-core: e\.g\. Mathlib\.Analysis\.SpecialFunctions\.Complex\.Circle → Init\.Core/);
  assert.ok(fs.existsSync(path.join(out, "lean-core.manifest.json")), "a closedOver manifest is never removed");

  fs.writeFileSync(path.join(out, "lean-core.manifest.json"), "{ not json");
  r = run(args);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /cannot read .*lean-core\.manifest\.json \(mathlib-essential is closed over lean-core\)/);
});

// fs.linkSync failing as it does when --out is on another filesystem than the
// build (or one without hard links): injected by a preload, so the code under
// test is the shipped pack-set.mjs.
function linkFailure(dir) {
  const preload = path.join(dir, "link-fails.mjs");
  fs.writeFileSync(preload, `import fs from "node:fs";
const code = process.env.L4W_TEST_LINK_ERRNO;
const seen = { links: 0, copies: [] };
fs.linkSync = () => { seen.links += 1; throw Object.assign(new Error(code + ": simulated link failure"), { code }); };
const copy = fs.copyFileSync;
fs.copyFileSync = (from, to, mode) => { seen.copies.push(mode ?? 0); return copy(from, to, mode); };
process.on("exit", () => process.stderr.write("LINK-SIM " + JSON.stringify(seen) + "\\n"));
`);
  return ["--import", pathToFileURL(preload).href];
}

test("the lean-core selection is copied (a clone where possible) when hard links fail with EXDEV", () => {
  const { K } = buildDir();
  const args = (out) => ["--build-dir", K, "--out", out, "--lean-version", "4.34.0", "--no-imports", "--only", "lean-core"];
  const linked = run(args(path.join(K, "linked")));
  assert.equal(linked.status, 0, linked.stdout + linked.stderr);
  const preload = linkFailure(K);
  const r = run(args(path.join(K, "copied")), preload, { L4W_TEST_LINK_ERRNO: "EXDEV" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const seen = JSON.parse(/LINK-SIM (.*)/.exec(r.stderr)[1]);
  assert.equal(seen.links, 7, "every selected file was tried as a link first");
  assert.deepEqual(seen.copies, Array(7).fill(fs.constants.COPYFILE_FICLONE));
  const digest = (out) => JSON.parse(fs.readFileSync(path.join(out, "pack-set.json"), "utf8")).packs[0].rawSha256;
  assert.equal(digest(path.join(K, "copied")), digest(path.join(K, "linked")), "the same pack either way");
  assert.ok(!fs.readdirSync(path.join(K, "copied")).some((f) => f.startsWith(".select-")), "no side tree left");

  // any other link error is not papered over: refused, and the partial side tree removed
  const bad = run(args(path.join(K, "eio")), preload, { L4W_TEST_LINK_ERRNO: "EIO" });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stderr, /pack-set: lean-core: selecting from .*lib\/lean failed: EIO: simulated link failure/);
  assert.ok(!fs.readdirSync(path.join(K, "eio")).some((f) => f.startsWith(".select-") || f.startsWith("lean-core.")), "no side tree or pack left");
});
