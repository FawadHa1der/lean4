// The runtime's host knobs, without a runtime: runtime-knobs.mjs's forwarded wasm environment, how
// node-runner and persistent-probe use it (each on a FAKE artifact whose bin/lean.js reports what it
// was given), and the `lean` link's pthread pool of 24 (src/CMakeLists.txt, src/stdlib.make.in).
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
import { FORWARDED_WASM_ENV, forwardWasmEnv } from "../runtime-knobs.mjs";

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

// ---------- the tools on a fake artifact ----------

/** A fake glue: records Module's keys, runs preRun against a stub FS, then `body`. */
const FAKE_GLUE = (body) => `const M = globalThis.Module;
const report = (o) => console.log("FAKE " + JSON.stringify(o));
const print = (line) => (M.print ?? console.log)(line); // node-runner hooks Module.print only for its marker
M.ENV = {}; // the real glue replaces any Module.ENV as well
const NODEFS = {};
M.FS = { filesystems: { NODEFS }, mkdir() {}, chdir() {}, mount() { return {}; }, analyzePath: () => ({ exists: false }) };
const moduleKeys = { hasPthreadPoolSize: "pthreadPoolSize" in M, hooksPrint: typeof M.print === "function" };
for (const f of M.preRun ?? []) f();
report({ ...moduleKeys, env: M.ENV });
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
    LEAN_COMPACTOR_RESERVE: "", LEAN4_WASM64_CWD: "", LEAN4_WASM64_PTHREAD_STACK_MB: "" };
  for (const k of [...FORWARDED_WASM_ENV, ...Object.keys(GONE)]) env[k] = "";
  return { ...env, ...extra };
};
const runTool = (script, args, extra) =>
  spawnSync(process.execPath, ["--stack-size=8192", path.join(pkg, script), ...args], { encoding: "utf8", env: hermetic(extra), timeout: 60_000, killSignal: "SIGKILL" });
const fakeLines = (out) => out.split("\n").filter((l) => l.startsWith("FAKE ")).map((l) => JSON.parse(l.slice(5)));

test("node-runner: the forwarded knobs reach the glue; 0038's pool key and [rtstats?] answer are gone", () => {
  const a = fakeArtifact('print("probe line [rtstats?]"); print("[pthreads?]"); process.exit(0);');
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

test("persistent-probe forwards the knobs as node-runner does, and passes no pool key", () => {
  const a = fakeArtifact("process.exit(0);");
  const r = runTool("persistent-probe.mjs", ["--artifact", a], { LEAN_WASM_STACK_PROBE_SLOTS: "0", LEAN_WASM_SYMTAB_TRACE: "miss:", ...GONE });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const [seen] = fakeLines(r.stdout);
  assert.equal(seen.hasPthreadPoolSize, false);
  assert.deepEqual(seen.env, { LEAN_PATH: "/lib/lean", LEAN_WASM_STACK_PROBE_SLOTS: "0", LEAN_WASM_SYMTAB_TRACE: "miss:" });
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
