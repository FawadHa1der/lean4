// The runtime's host knobs, without a runtime: runtime-knobs.mjs's forwarded wasm environment and
// the glue's NODEFS and path lookup, how node-runner and persistent-probe use them (each on a FAKE
// artifact whose bin/lean.js reports what it was given, shaped as emsdk 6.0.5's glue or 7.0.0's),
// and the `lean` link's pthread pool of 24 (src/CMakeLists.txt, src/stdlib.make.in).
// Kernel patch 0038's pool size, thread-exit knobs and counters left with the architecture review's
// D3b; the tests below also hold that none of their plumbing is left.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as knobs from "../runtime-knobs.mjs";
import { FORWARDED_WASM_ENV, forwardWasmEnv, glueFilesystem, vfsExists } from "../runtime-knobs.mjs";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "l4w-knobs-")); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };

// 0038's variables, which nothing forwards or reads since D3b
const GONE = { LEAN4_WASM64_PTHREAD_POOL: "7", LEAN4_WASM64_RTSTATS: "1", LEAN_WASM_PARKED_IDLE_MS: "300", LEAN_WASM_STD_SURPLUS_EXIT: "1" };

// ---------- runtime-knobs.mjs ----------

test("forwardWasmEnv copies the three LEAN_WASM_* knobs when non-empty, and nothing else", () => {
  assert.deepEqual([...FORWARDED_WASM_ENV], ["LEAN_WASM_PARKED_DEDICATED", "LEAN_WASM_STACK_PROBE_SLOTS", "LEAN_WASM_SYMTAB_TRACE"]);
  const ENV = { LEAN_PATH: "/lib/lean", LEAN_WASM_STACK_PROBE_SLOTS: "kept" };
  const host = { LEAN_WASM_PARKED_DEDICATED: "4", LEAN_WASM_STACK_PROBE_SLOTS: "", LEAN_WASM_SYMTAB_TRACE: "miss:", QED64_PROFILE_INIT: "1",
    LEAN_WASM_OTHER: "x", ...GONE };
  assert.equal(forwardWasmEnv(ENV, host), ENV);
  assert.deepEqual(ENV, { LEAN_PATH: "/lib/lean", LEAN_WASM_STACK_PROBE_SLOTS: "kept", LEAN_WASM_PARKED_DEDICATED: "4", LEAN_WASM_SYMTAB_TRACE: "miss:" });
});

test("0038's helpers are gone from the module (the pool key, the counters object and its keys)", () => {
  for (const name of ["poolModuleKeys", "runtimeStats", "TASK_MANAGER_STATS"]) assert.equal(name in knobs, false, name);
  assert.equal(typeof knobs.symtabStats, "function"); // 0039's gauges stay
});

test("glueFilesystem: Module.NODEFS (emsdk 7, exported), else FS.filesystems.NODEFS (emsdk 6.0.5), else the glue's global; none is an error", () => {
  const exported = { name: "exported" }, held = { name: "held" }, global = { name: "global" };
  assert.equal(glueFilesystem({ NODEFS: exported, FS: {} }, "NODEFS", {}), exported); // 7.0.0: no FS.filesystems at all
  assert.equal(glueFilesystem({ FS: { filesystems: { MEMFS: {}, NODEFS: held, WORKERFS: {} } } }, "NODEFS", {}), held); // 6.0.5
  assert.equal(glueFilesystem({ NODEFS: exported, FS: { filesystems: { NODEFS: held } } }, "NODEFS", { NODEFS: global }), exported);
  assert.equal(glueFilesystem({ FS: { filesystems: { NODEFS: held } } }, "NODEFS", { NODEFS: global }), held);
  assert.equal(glueFilesystem({ FS: {} }, "NODEFS", { NODEFS: global }), global); // a 7.0.0 link without the export
  assert.equal(glueFilesystem({ WORKERFS: exported, FS: {} }, "WORKERFS", {}), exported);
  assert.throws(() => glueFilesystem({ FS: { filesystems: null } }, "NODEFS", {}),
    /^Error: the runtime's glue exposes no NODEFS: not as Module\.NODEFS \(exported from emsdk 7 on\), FS\.filesystems\.NODEFS \(emsdk 6\) or a global NODEFS \(is lean\.js linked with -lnodefs\.js\?\)$/);
  assert.throws(() => glueFilesystem(undefined, "WORKERFS", {}), /exposes no WORKERFS.*-lworkerfs\.js/);
});

test("vfsExists: FS.analyzePath(p).exists where the glue has it, else FS.lookupPath(p, {follow: true}) resolving", () => {
  const calls = [];
  const known = new Set(["/lib/lean", "/bin"]);
  const lookupPath = (p, opts) => { calls.push(["lookupPath", p, opts]); if (!known.has(p)) throw Object.assign(new Error("FS error"), { errno: 44 }); return { path: p, node: {} }; };
  const analyzePath = (p) => { calls.push(["analyzePath", p]); return { exists: known.has(p), error: known.has(p) ? 0 : 44 }; };
  // emsdk 6.0.5, and 7.0.0 without -sSTRICT: both functions exist and analyzePath is the one asked
  for (const p of ["/lib/lean", "/nope"]) assert.equal(vfsExists({ analyzePath, lookupPath }, p), known.has(p));
  assert.deepEqual(calls.splice(0), [["analyzePath", "/lib/lean"], ["analyzePath", "/nope"]]);
  // a glue without analyzePath (7.0.0 with -sSTRICT): lookupPath, following a final link, the same answers
  for (const p of ["/bin", "/nope"]) assert.equal(vfsExists({ lookupPath }, p), known.has(p));
  assert.deepEqual(calls.splice(0), [["lookupPath", "/bin", { follow: true }], ["lookupPath", "/nope", { follow: true }]]);
});

// ---------- the tools on a fake artifact ----------

/** Where each glue generation keeps its filesystems for a host (runtime-knobs.mjs glueFilesystem): emsdk 6.0.5
 *  in FS.filesystems; 7.0.0 has none (emscripten#27940) and the kernel's link exports them on Module; "no NODEFS"
 *  has it nowhere (a `const`, as the stubs are, is no global either). */
const GLUE_FS = {
  "6.0.5": "M.FS = { ...FS_OPS, filesystems: { MEMFS: {}, NODEFS, WORKERFS } };",
  "7.0.0": "M.FS = { ...FS_OPS }; M.NODEFS = NODEFS; M.WORKERFS = WORKERFS;",
  "no NODEFS": "M.FS = { ...FS_OPS };",
};
/** A fake glue (`glue`: a GLUE_FS key): records Module's keys, runs preRun against a stub FS whose mount takes only
    the glue's own NODEFS, then `body`. */
const FAKE_GLUE = (body, glue = "6.0.5") => `const M = globalThis.Module;
const report = (o) => console.log("FAKE " + JSON.stringify(o));
const print = (line) => (M.print ?? console.log)(line); // node-runner hooks Module.print only for its marker
M.ENV = {}; // the real glue replaces any Module.ENV as well
const NODEFS = { name: "NODEFS" }, WORKERFS = { name: "WORKERFS" };
const FS_OPS = { mkdir() {}, chdir() {}, analyzePath: () => ({ exists: false }), lookupPath() { throw new Error("ENOENT"); },
  mount(type) { if (type !== NODEFS) throw new Error("FS.mount: not the glue's NODEFS: " + JSON.stringify(type)); return {}; } };
${GLUE_FS[glue]}
const moduleKeys = { hasPthreadPoolSize: "pthreadPoolSize" in M, hooksPrint: typeof M.print === "function" };
for (const f of M.preRun ?? []) f();
report({ ...moduleKeys, env: M.ENV });
${body}
`;
function fakeArtifact(body, glue = "6.0.5") {
  const a = tmp();
  write(path.join(a, "bin", "lean.js"), FAKE_GLUE(body, glue));
  write(path.join(a, "bin", "lean.wasm"), Buffer.from("not wasm"));
  fs.mkdirSync(path.join(a, "lib", "lean"), { recursive: true });
  return a;
}
const hermetic = (extra) => {
  const env = { ...process.env, LEAN4_WASM64_ARTIFACT: "", QED64_LEAN_ARTIFACT: "", QED64_COUNT_PTHREADS: "", QED64_PROFILE_INIT: "",
    LEAN_COMPACTOR_RESERVE: "", LEAN4_WASM64_CWD: "", LEAN4_WASM64_PTHREAD_STACK_MB: "" };
  for (const k of [...FORWARDED_WASM_ENV, ...Object.keys(GONE)]) env[k] = "";
  return { ...env, ...extra };
};
const runTool = (script, args, extra) =>
  spawnSync(process.execPath, ["--stack-size=8192", path.join(pkg, script), ...args], { encoding: "utf8", env: hermetic(extra), timeout: 60_000, killSignal: "SIGKILL" });
const fakeLines = (out) => out.split("\n").filter((l) => l.startsWith("FAKE ")).map((l) => JSON.parse(l.slice(5)));

for (const glue of ["6.0.5", "7.0.0"]) test(`node-runner [emsdk ${glue} glue]: the forwarded knobs reach the glue; 0038's pool key and [rtstats?] answer are gone`, () => {
  const a = fakeArtifact('print("probe line [rtstats?]"); print("[pthreads?]"); process.exit(0);', glue);
  let r = runTool("node-runner.mjs", ["--artifact", a, "--work", tmp(), "--", "/work/x.lean"],
    { LEAN_WASM_PARKED_DEDICATED: "4", LEAN_WASM_STACK_PROBE_SLOTS: "0", ...GONE });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const [seen] = fakeLines(r.stdout);
  assert.equal(seen.hasPthreadPoolSize, false);
  assert.equal(seen.hooksPrint, false); // no marker to answer: Module.print stays the glue's
  assert.deepEqual(seen.env, { LEAN_PATH: "/lib/lean", LEAN_WASM_PARKED_DEDICATED: "4", LEAN_WASM_STACK_PROBE_SLOTS: "0" });
  assert.doesNotMatch(r.stdout, /\[rtstats\]/);
  assert.doesNotMatch(r.stdout, /\[pthreads\] created=/); // QED64_COUNT_PTHREADS is its own switch

  // all unset: nothing forwarded
  r = runTool("node-runner.mjs", ["--artifact", a, "--work", tmp(), "--", "/work/x.lean"], {});
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(fakeLines(r.stdout)[0].env, { LEAN_PATH: "/lib/lean" });
});

test("node-runner: QED64_COUNT_PTHREADS answers [pthreads?] right after the line that asks", () => {
  const a = fakeArtifact('print("A [pthreads?]"); print("B [rtstats?]"); process.exit(0);');
  const r = runTool("node-runner.mjs", ["--artifact", a, "--work", tmp(), "--", "/work/x.lean"], { QED64_COUNT_PTHREADS: "1", LEAN4_WASM64_RTSTATS: "1" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const lines = r.stdout.split("\n").filter((l) => l && !l.startsWith("FAKE "));
  assert.deepEqual(lines.map((l) => l.replace(/\d+$/, "N")), ["A [pthreads?]", "[pthreads] created=N", "B [rtstats?]"]);
});

for (const glue of ["6.0.5", "7.0.0"]) test(`persistent-probe [emsdk ${glue} glue] forwards the knobs as node-runner does, and passes no pool key`, () => {
  const a = fakeArtifact("process.exit(0);", glue);
  const r = runTool("persistent-probe.mjs", ["--artifact", a], { LEAN_WASM_STACK_PROBE_SLOTS: "0", LEAN_WASM_SYMTAB_TRACE: "miss:", ...GONE });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const [seen] = fakeLines(r.stdout);
  assert.equal(seen.hasPthreadPoolSize, false);
  assert.deepEqual(seen.env, { LEAN_PATH: "/lib/lean", LEAN_WASM_STACK_PROBE_SLOTS: "0", LEAN_WASM_SYMTAB_TRACE: "miss:" });
});

test("node-runner and persistent-probe on a glue that exposes no NODEFS: the clear error, before any mount", () => {
  for (const [script, args] of [["node-runner.mjs", ["--work", tmp(), "--", "/work/x.lean"]], ["persistent-probe.mjs", []]]) {
    const r = runTool(script, ["--artifact", fakeArtifact('report({ reached: true }); process.exit(0);', "no NODEFS"), ...args], {});
    assert.notEqual(r.status, 0, `${script}: ${r.stdout}`);
    assert.match(r.stderr, /the runtime's glue exposes no NODEFS: not as Module\.NODEFS \(exported from emsdk 7 on\), FS\.filesystems\.NODEFS \(emsdk 6\)/, script);
    assert.doesNotMatch(r.stderr, /FS\.mount: not the glue's NODEFS/, script);
    assert.deepEqual(fakeLines(r.stdout), [], script);
  }
});

// ---------- the `lean` link's pthread pool ----------

// The link lives in the kernel's src/; the package's CI checks out these two files with wasm64-build/
// (.github/workflows/lean4-wasm64-js.yml), and an installed package has neither.
const SRC = path.resolve(pkg, "..", "..", "src");
const noSrc = ["CMakeLists.txt", "stdlib.make.in"].find((f) => !fs.existsSync(path.join(SRC, f)))
  ?.replace(/.*/, (f) => `${path.join(SRC, f)} is not checked out`) ?? false;

test("the lean link allocates a pool of 24 pthread Workers, with no JS library (src/CMakeLists.txt, src/stdlib.make.in)", { skip: noSrc }, () => {
  const cmake = fs.readFileSync(path.join(SRC, "CMakeLists.txt"), "utf8");
  assert.deepEqual([...cmake.matchAll(/-sPTHREAD_POOL_SIZE=(\w+)/g)].map((m) => m[1]), ["24"]);
  assert.doesNotMatch(cmake, /--js-library|leanPthreadPoolTarget|emscripten-pthread-pool/);
  assert.match(cmake, /set\(LEAN_EXE_LINK_DEPS "\$\{LEAN_SOURCE_DIR\}\/emscripten-exports\.txt"\)/);
  assert.match(fs.readFileSync(path.join(SRC, "stdlib.make.in"), "utf8"), /^\$\(OUTBIN\)\/lean\$\(EXE\): .* \$\{LEAN_EXE_LINK_DEPS\}( |$)/m);
  assert.equal(fs.existsSync(path.join(SRC, "emscripten-pthread-pool.js")), false); // 0038's pool library is gone
});
