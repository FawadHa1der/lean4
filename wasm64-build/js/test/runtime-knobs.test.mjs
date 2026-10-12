// Kernel patch 0038, without a runtime: runtime-knobs.mjs (the Module keys, the forwarded wasm
// environment, the counters object), how node-runner, persistent-probe and snapshot-probe use it
// (each on a FAKE artifact whose bin/lean.js reports what it was given), and the pool-size JS
// library src/emscripten-pthread-pool.js, evaluated the way emsdk 6.0.5's jsifier emits it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { FORWARDED_WASM_ENV, TASK_MANAGER_STATS, forwardWasmEnv, poolModuleKeys, runtimeStats } from "../runtime-knobs.mjs";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "l4w-knobs-")); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };

// ---------- runtime-knobs.mjs ----------

test("poolModuleKeys: LEAN4_WASM64_PTHREAD_POOL is Module.pthreadPoolSize, passed raw; empty or unset passes nothing", () => {
  assert.deepEqual(poolModuleKeys({}), {});
  assert.deepEqual(poolModuleKeys({ LEAN4_WASM64_PTHREAD_POOL: "" }), {});
  for (const v of ["8", "-3", "abc", "0", " 4 "]) assert.deepEqual(poolModuleKeys({ LEAN4_WASM64_PTHREAD_POOL: v }), { pthreadPoolSize: v });
});

test("forwardWasmEnv copies the four LEAN_WASM_* knobs when non-empty, and nothing else", () => {
  assert.deepEqual([...FORWARDED_WASM_ENV],
    ["LEAN_WASM_PARKED_DEDICATED", "LEAN_WASM_PARKED_IDLE_MS", "LEAN_WASM_STD_SURPLUS_EXIT", "LEAN_WASM_STACK_PROBE_SLOTS"]);
  const ENV = { LEAN_PATH: "/lib/lean", LEAN_WASM_PARKED_IDLE_MS: "kept" };
  const host = { LEAN_WASM_PARKED_DEDICATED: "4", LEAN_WASM_PARKED_IDLE_MS: "", LEAN_WASM_STD_SURPLUS_EXIT: "1", QED64_PROFILE_INIT: "1", LEAN_WASM_OTHER: "x" };
  assert.equal(forwardWasmEnv(ENV, host), ENV);
  assert.deepEqual(ENV, { LEAN_PATH: "/lib/lean", LEAN_WASM_PARKED_IDLE_MS: "kept", LEAN_WASM_PARKED_DEDICATED: "4", LEAN_WASM_STD_SURPLUS_EXIT: "1" });
});

test("runtimeStats reads the 0038 exports and the glue's pool, by name; Numbers, BigInts and -1 (no task manager)", () => {
  const calls = [];
  const values = [3, 2, 9, 7, 1, 6];
  const M = {
    _lean_wasm_task_manager_stat: (k) => { calls.push(k); return values[k]; },
    _lean_wasm_engine_probes: () => 1234,
    _lean_wasm_engine_guard_trips: (site) => (site === 0 ? 2n : 5),
  };
  const g = { PThread: { unusedWorkers: [{}, {}], pthreads: { 64: {}, 128: {}, 256: {} } }, leanPthreadPoolTarget: 4 };
  assert.deepEqual(runtimeStats(M, g), {
    pool: { target: 4, unused: 2, live: 3 },
    tm: { liveStd: 3, stdCap: 2, liveStdPeak: 9, stdSurplusExits: 7, parked: 1, parkedIdleExits: 6 },
    guard: { probes: 1234, trips: [2, 5] },
  });
  assert.deepEqual(calls, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(Object.keys(runtimeStats(M, g).tm), [...TASK_MANAGER_STATS]);
  // before lean_init_task_manager: every key reads -1
  assert.deepEqual(runtimeStats({ ...M, _lean_wasm_task_manager_stat: () => -1 }, g).tm,
    Object.fromEntries(TASK_MANAGER_STATS.map((k) => [k, null])));
  // Module.PThread wins over the global (QED64's worker looks there first)
  assert.equal(runtimeStats({ ...M, PThread: { unusedWorkers: [], pthreads: {} } }, g).pool.unused, 0);
});

test("runtimeStats on a runtime before 0038 (no exports, no pool variable) and on no runtime at all: nulls, no throw", () => {
  const old = { _lean_wasm_task_manager_parked_threads: () => 0 };
  assert.deepEqual(runtimeStats(old, { PThread: { unusedWorkers: [{}], pthreads: {} } }),
    { pool: { target: null, unused: 1, live: 0 }, tm: null, guard: null });
  assert.deepEqual(runtimeStats(old, {}), { pool: null, tm: null, guard: null });
  assert.deepEqual(runtimeStats(undefined, {}), { pool: null, tm: null, guard: null });
});

// ---------- the tools on a fake artifact ----------

/** A fake glue: records Module's keys, runs preRun against a stub FS, defines what runtimeStats reads, then `body`. */
const FAKE_GLUE = (body) => `const M = globalThis.Module;
const report = (o) => console.log("FAKE " + JSON.stringify(o));
const print = (line) => (M.print ?? console.log)(line); // node-runner hooks Module.print only for its markers
M.ENV = {}; // the real glue replaces any Module.ENV as well
const NODEFS = {};
M.FS = { filesystems: { NODEFS }, mkdir() {}, chdir() {}, mount() { return {}; }, analyzePath: () => ({ exists: false }) };
const moduleKeys = { pthreadPoolSize: M.pthreadPoolSize ?? null, hasPthreadPoolSize: "pthreadPoolSize" in M };
for (const f of M.preRun ?? []) f();
report({ ...moduleKeys, env: M.ENV });
globalThis.PThread = { unusedWorkers: [{}, {}, {}], pthreads: { 64: {} } };
globalThis.leanPthreadPoolTarget = 3;
M._lean_wasm_task_manager_stat = (k) => [5, 4, 6, 2, 0, 1][k];
M._lean_wasm_engine_probes = () => 77;
M._lean_wasm_engine_guard_trips = (s) => [1, 0][s];
${body}
`;
function fakeArtifact(body) {
  const a = tmp();
  write(path.join(a, "bin", "lean.js"), FAKE_GLUE(body));
  write(path.join(a, "bin", "lean.wasm"), Buffer.from("not wasm"));
  fs.mkdirSync(path.join(a, "lib", "lean"), { recursive: true });
  return a;
}
const hermetic = (extra) => {
  const env = { ...process.env, LEAN4_WASM64_ARTIFACT: "", QED64_LEAN_ARTIFACT: "", QED64_COUNT_PTHREADS: "", QED64_PROFILE_INIT: "",
    QED64_ALLOW_LEGACY_IMPORTS: "", LEAN_COMPACTOR_RESERVE: "", LEAN4_WASM64_CWD: "", LEAN4_WASM64_PTHREAD_STACK_MB: "" };
  for (const k of [...FORWARDED_WASM_ENV, "LEAN4_WASM64_PTHREAD_POOL", "LEAN4_WASM64_RTSTATS"]) env[k] = "";
  return { ...env, ...extra };
};
const runTool = (script, args, extra) =>
  spawnSync(process.execPath, ["--stack-size=8192", path.join(pkg, script), ...args], { encoding: "utf8", env: hermetic(extra), timeout: 60_000, killSignal: "SIGKILL" });
const fakeLines = (out) => out.split("\n").filter((l) => l.startsWith("FAKE ")).map((l) => JSON.parse(l.slice(5)));

test("node-runner: the pool key and the forwarded knobs reach the glue; [rtstats?] is answered only with LEAN4_WASM64_RTSTATS", () => {
  const a = fakeArtifact('print("probe line [rtstats?]"); print("[pthreads?]"); process.exit(0);');
  let r = runTool("node-runner.mjs", ["--artifact", a, "--work", tmp(), "--", "/work/x.lean"],
    { LEAN4_WASM64_PTHREAD_POOL: "7", LEAN4_WASM64_RTSTATS: "1", LEAN_WASM_PARKED_DEDICATED: "4", LEAN_WASM_PARKED_IDLE_MS: "300", LEAN_WASM_STD_SURPLUS_EXIT: "1" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const [seen] = fakeLines(r.stdout);
  assert.equal(seen.pthreadPoolSize, "7");
  assert.deepEqual(seen.env, { LEAN_PATH: "/lib/lean", LEAN_WASM_PARKED_DEDICATED: "4", LEAN_WASM_PARKED_IDLE_MS: "300", LEAN_WASM_STD_SURPLUS_EXIT: "1" });
  const lines = r.stdout.split("\n");
  const at = lines.indexOf("probe line [rtstats?]");
  assert.ok(at >= 0, r.stdout);
  assert.match(lines[at + 1], /^\[rtstats\] \{/);
  assert.deepEqual(JSON.parse(lines[at + 1].slice("[rtstats] ".length)), {
    pool: { target: 3, unused: 3, live: 1 },
    tm: { liveStd: 5, stdCap: 4, liveStdPeak: 6, stdSurplusExits: 2, parked: 0, parkedIdleExits: 1 },
    guard: { probes: 77, trips: [1, 0] },
  });
  assert.doesNotMatch(r.stdout, /\[pthreads\] created=/); // QED64_COUNT_PTHREADS stays its own switch

  // all unset: no pool key, nothing forwarded, no answer
  r = runTool("node-runner.mjs", ["--artifact", a, "--work", tmp(), "--", "/work/x.lean"], {});
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const [bare] = fakeLines(r.stdout);
  assert.equal(bare.hasPthreadPoolSize, false);
  assert.deepEqual(bare.env, { LEAN_PATH: "/lib/lean" });
  assert.doesNotMatch(r.stdout, /\[rtstats\]/);
});

test("node-runner: with both QED64_COUNT_PTHREADS and LEAN4_WASM64_RTSTATS each marker gets its own answer", () => {
  const a = fakeArtifact('print("A [pthreads?]"); print("B [rtstats?]"); process.exit(0);');
  const r = runTool("node-runner.mjs", ["--artifact", a, "--work", tmp(), "--", "/work/x.lean"], { QED64_COUNT_PTHREADS: "1", LEAN4_WASM64_RTSTATS: "1" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const lines = r.stdout.split("\n").filter((l) => !l.startsWith("FAKE "));
  assert.equal(lines[0], "A [pthreads?]");
  assert.match(lines[1], /^\[pthreads\] created=\d+$/);
  assert.equal(lines[2], "B [rtstats?]");
  assert.match(lines[3], /^\[rtstats\] \{"pool":/);
});

test("persistent-probe and snapshot-probe pass the pool key and forward the knobs as node-runner does", () => {
  const a = fakeArtifact("process.exit(0);");
  const knobs = { LEAN4_WASM64_PTHREAD_POOL: "abc", LEAN_WASM_STACK_PROBE_SLOTS: "0", LEAN_WASM_STD_SURPLUS_EXIT: "1" };
  let r = runTool("persistent-probe.mjs", ["--artifact", a], knobs);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  let [seen] = fakeLines(r.stdout);
  assert.equal(seen.pthreadPoolSize, "abc");
  assert.deepEqual(seen.env, { LEAN_PATH: "/lib/lean", LEAN_WASM_STACK_PROBE_SLOTS: "0", LEAN_WASM_STD_SURPLUS_EXIT: "1" });
  const snap = path.join(tmp(), "x.snap");
  fs.writeFileSync(snap, "not a snapshot");
  r = runTool("snapshot-probe.mjs", ["--artifact", a, "--snap", snap, "--lib", path.join(a, "lib", "lean"), "--probe", "#check 1", "--watchdog-ms", "0"], knobs);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  [seen] = fakeLines(r.stdout);
  assert.equal(seen.pthreadPoolSize, "abc");
  assert.deepEqual(seen.env, { LEAN_PATH: "/lib/lean", LEAN_WASM_STACK_PROBE_SLOTS: "0", LEAN_WASM_STD_SURPLUS_EXIT: "1" });
});

// ---------- src/emscripten-pthread-pool.js ----------

// The library lives in the kernel's src/, beside the CMake link line that loads it; the package's
// CI checks out these three files with wasm64-build/ (.github/workflows/lean4-wasm64-js.yml), and
// an installed package has none of them.
const SRC = path.resolve(pkg, "..", "..", "src");
const LIB = path.join(SRC, "emscripten-pthread-pool.js");
const noLib = ["emscripten-pthread-pool.js", "CMakeLists.txt", "stdlib.make.in"].find((f) => !fs.existsSync(path.join(SRC, f)))
  ?.replace(/.*/, (f) => `${path.join(SRC, f)} is not checked out`) ?? false;

/** The library as emsdk loads it: the preprocessor lines (only the emsdk pin) off, then run with
    the two compile-time globals it uses. */
function loadPoolLibrary() {
  const lines = fs.readFileSync(LIB, "utf8").split("\n");
  const directives = lines.filter((l) => l.trimStart().startsWith("#"));
  assert.deepEqual(directives, [
    "#if EMSCRIPTEN_VERSION != '6.0.5'",
    `#error "src/emscripten-pthread-pool.js relies on emsdk 6.0.5's PTHREAD_POOL_SIZE emission and library order: re-check them, then move this pin"`,
    "#endif",
  ]);
  const library = {};
  const extraLibraryFuncs = [];
  new Function("addToLibrary", "extraLibraryFuncs", lines.filter((l) => !l.trimStart().startsWith("#")).join("\n"))(
    (items) => Object.assign(library, items), extraLibraryFuncs);
  return { library, extraLibraryFuncs };
}

/** What emsdk 6.0.5's jsifier writes for the two items (a named function declaration; `var x = …`
    for a '=' string), then the pool loop's first line from libpthread.js's initMainThread. */
function emitted(library) {
  const fn = library.$leanPoolInt.toString().replace(/function(?:\s+([^(]+))?\s*\(/, "function leanPoolInt(");
  return `${fn}\nvar leanPthreadPoolTarget = ${library.$leanPthreadPoolTarget.slice(1)};\nvar pthreadPoolSize = leanPthreadPoolTarget;\n`;
}

test("the pool library: one variable, '=leanPoolInt(Module[\"pthreadPoolSize\"], 24, 0, 64)', forced in, its parser its only dependency", { skip: noLib }, () => {
  const { library, extraLibraryFuncs } = loadPoolLibrary();
  assert.deepEqual(Object.keys(library).sort(), ["$leanPoolInt", "$leanPthreadPoolTarget", "$leanPthreadPoolTarget__deps"]);
  assert.equal(library.$leanPthreadPoolTarget, '=leanPoolInt(Module["pthreadPoolSize"], 24, 0, 64)');
  assert.deepEqual(library.$leanPthreadPoolTarget__deps, ["$leanPoolInt"]);
  assert.deepEqual(extraLibraryFuncs, ["$leanPthreadPoolTarget"]); // only the emitted pool loop names it
  assert.equal(typeof library.$leanPoolInt, "function"); // emitted as a hoisted declaration
});

test("the pool size the glue computes from Module.pthreadPoolSize: 0..64, else 24", { skip: noLib }, () => {
  const code = emitted(loadPoolLibrary().library);
  const poolFor = (...value) => {
    const ctx = vm.createContext({ Module: value.length ? { pthreadPoolSize: value[0] } : {} });
    vm.runInContext(code, ctx);
    return ctx.pthreadPoolSize;
  };
  assert.equal(poolFor(), 24); // absent: this build's pool since 0019
  for (const [v, want] of [[undefined, 24], [null, 24], ["", 24], ["  ", 24], ["abc", 24], [NaN, 24], [Infinity, 24], [-Infinity, 24], [{}, 24],
    ["8", 8], [8, 8], ["4", 4], [" 4 ", 4], [0, 0], ["0", 0], [-3, 0], ["-3", 0], [7.9, 7], ["7.9", 7], [64, 64], [65, 64], [100, 64], ["1e3", 64], [8n, 8]]) {
    assert.equal(poolFor(v), want, `pthreadPoolSize ${typeof v === "bigint" ? `${v}n` : JSON.stringify(v) ?? String(v)}`);
  }
});

test("the lean link names the library and sizes the pool with its variable (src/CMakeLists.txt, src/stdlib.make.in)", { skip: noLib }, () => {
  const cmake = fs.readFileSync(path.join(SRC, "CMakeLists.txt"), "utf8");
  assert.match(cmake, /-sPTHREAD_POOL_SIZE=leanPthreadPoolTarget --js-library=\$\{LEAN_SOURCE_DIR\}\/emscripten-pthread-pool\.js/);
  assert.doesNotMatch(cmake, /-sPTHREAD_POOL_SIZE=\d/);
  assert.match(cmake, /set\(LEAN_EXE_LINK_DEPS "\$\{LEAN_SOURCE_DIR\}\/emscripten-pthread-pool\.js /);
  assert.match(fs.readFileSync(path.join(SRC, "stdlib.make.in"), "utf8"), /^\$\(OUTBIN\)\/lean\$\(EXE\): .* \$\{LEAN_EXE_LINK_DEPS\}$/m);
});
