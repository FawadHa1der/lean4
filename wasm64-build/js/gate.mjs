#!/usr/bin/env node
// Release gate for a freshly built wasm64 runtime artifact.
//
// Runs, in order, against --artifact <stage1 dir>:
//  1. numBits smoke      — #eval System.Platform.numBits must print 64
//  2. proof smoke        — a kernel-checked rfl example, exit 0
//  3. error smoke        — a false proof must produce a positioned error
//  4. the persistent path, module semantics (0034), the task-manager storm (0035),
//     deep recursion at a browser's stack (0036), and async elaboration through
//     lean_wasm_compile (0037: every message of an Elab.async declaration reported once)
//  5. THE PARSE GATE     — garbage input must produce >=1 error diagnostic
//  6. module files on a shared environment through lean_wasm_compile (0042: the public constant
//     map setIsModule builds), and imported docstrings/ranges (the `.server` import level)
//  7. R10, stock parity (kernel review §5 #3): environment facts against FIXED native stock v4.35.0
//     values with an explicit allowlist, in the exact cell (block 6's run) and the snapshot cell (an
//     init.snap this gate bakes itself and loads as the browser does); with the optional inputs below,
//     the Mathlib-header cell, the resident FileWorker and the covered cell (with their facts when the
//     resident probe has --probe-file). An input left out prints a note: `gate --artifact <dir>` alone
//     can still pass.
//  0038 (folded into the runs above, no runtime of its own): the glue's pool size from
//     Module.pthreadPoolSize, the opt-in exits of surplus standard workers and idle parked
//     threads, the engine-guard counters. Skipped, with a note, on a runtime before 0038.
//  0039 (static checks first, the rest folded into the runs above): the JavaScript export contract
//     and the glue surface hosts reach into (S2, S6: every runtime), no generated export and a
//     statically linked module (S1), the native-symbol table intact (G2), core initializers and
//     constant cells found in it (G3, G4), plain core functions run native (G5, 0039b), no lookup
//     lost (G7). Skipped, with a note, on a runtime before 0039.
// Every check prints ok or FAIL; exits nonzero if any failed.
//
// Usage: node gate.mjs --artifact <dir> [--mathlib-lib <olean tree>]
//          [--resident-probe <QED64 checkout>/pipeline/snapshot/resident-probe.mjs [--resident-snap-dir <dir>]]
//   --mathlib-lib: a complete olean tree paired with the artifact (Init through Mathlib: QED64's
//   lib-tree-slim), mounted as the only library of block 7's Mathlib-header cell.
//   --resident-probe: QED64's resident FileWorker driver (QED64's CLI-CONTRACT sets its tier; it runs from QED64's checkout, as it
//   imports public/workers/worker-constants.js, the page's argv), run on the gate's own init.snap.
//   --resident-snap-dir: a dir holding init.snap and mathlib.snap baked for this artifact (QED64's
//   adoption $W/snapshot): the same driver with --mathlib, block 7's covered cell. Needs --resident-probe.
//   The caller pairs them with --artifact: a snapshot records only its olean header, so the gate cannot.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSeed, staticChecks } from "./runtime-contract.mjs";

// The runner harnesses live alongside this gate (self-contained build dir).
const root = path.dirname(fileURLToPath(import.meta.url));
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("usage: gate.mjs --artifact <dir> [--mathlib-lib <olean tree>] [--resident-probe <resident-probe.mjs> [--resident-snap-dir <dir>]]\nThe release gate: every check must print ok. run as: lean4-wasm64 gate   (or: node --stack-size=8192 gate.mjs)\n--mathlib-lib: a complete olean tree paired with --artifact (Init through Mathlib; QED64's lib-tree-slim): block 7's Mathlib-header cell\n--resident-probe: QED64's pipeline/snapshot/resident-probe.mjs, run from its checkout: block 7's resident FileWorker check on the gate's own init.snap\n--resident-snap-dir: a dir with init.snap and mathlib.snap baked for --artifact (the caller pairs them; a snapshot of another runtime fails or crashes the cell): block 7's covered cell (needs --resident-probe)\nwithout them those cells print a note and the gate can still pass\nexit codes: 0 GATE PASSED, 1 a check failed, 2 usage");
  process.exit(0);
}
// Every option takes a value; an unknown one is refused, so a removed or misspelt input never
// skips a check silently (--baseline-exports went 2026-11-01).
const FLAGS = new Set(["artifact", "mathlib-lib", "resident-probe", "resident-snap-dir"]);
for (let i = 2; i < process.argv.length; i += 2) {
  const a = process.argv[i];
  if (!a.startsWith("--") || !FLAGS.has(a.slice(2))) {
    console.error(`gate: unknown argument ${a}\nusage: gate.mjs --artifact <dir> [--mathlib-lib <dir>] [--resident-probe <file> [--resident-snap-dir <dir>]]`);
    process.exit(2);
  }
  const v = process.argv[i + 1];
  if (v === undefined || v === "" || v.startsWith("--")) {
    console.error(`gate: ${a} needs a value`);
    process.exit(2);
  }
}
if (!arg("artifact")) {
  console.error("usage: gate.mjs --artifact <dir>   (bin/lean.js, bin/lean.wasm, lib/lean)");
  process.exit(2);
}
const artifact = path.resolve(arg("artifact"));
if (!fs.existsSync(path.join(artifact, "bin/lean.js"))) {
  console.error(`gate: ${artifact}/bin/lean.js not found`);
  process.exit(2);
}
// R10's optional inputs (block 7), refused (exit 2) before any child starts when given but unusable.
const R10_MATHLIB_OLEAN = "Mathlib/Basic/Real/Basic.olean"; // probes/parity-*-mathlib.lean's header: check its name at each Lean import
const mathlibLib = arg("mathlib-lib") ? path.resolve(arg("mathlib-lib")) : null;
const residentProbe = arg("resident-probe") ? path.resolve(arg("resident-probe")) : null;
const residentSnapDir = arg("resident-snap-dir") ? path.resolve(arg("resident-snap-dir")) : null;
const refuse = (why) => { console.error(`gate: ${why}`); process.exit(2); };
const sha256Of = (file) => { try { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; } };
if (mathlibLib) {
  if (!fs.existsSync(path.join(mathlibLib, R10_MATHLIB_OLEAN))) refuse(`--mathlib-lib ${mathlibLib} has no ${R10_MATHLIB_OLEAN} (a complete olean tree: Init through Mathlib)`);
  if (!fs.existsSync(path.join(mathlibLib, `${R10_MATHLIB_OLEAN}.server`))) refuse(`--mathlib-lib ${mathlibLib} has no ${R10_MATHLIB_OLEAN}.server: imports read the .server facets (0042), so a tree without them fails the docs facts`);
  // paired: the packs of one release share the build's Init/Prelude.olean with the artifact's lib/lean
  const own = path.join(artifact, "lib/lean/Init/Prelude.olean"), given = sha256Of(path.join(mathlibLib, "Init/Prelude.olean"));
  if (!given || given !== sha256Of(own)) refuse(`--mathlib-lib ${mathlibLib} is not paired with --artifact: its Init/Prelude.olean ${given ? "differs from" : "is missing, unlike"} ${own}`);
}
if (residentProbe && !fs.existsSync(residentProbe)) refuse(`--resident-probe ${residentProbe} not found`);
if (residentSnapDir) {
  if (!residentProbe) refuse("--resident-snap-dir needs --resident-probe (the covered cell runs it with --mathlib)");
  for (const f of ["init.snap", "mathlib.snap"]) if (!fs.existsSync(path.join(residentSnapDir, f))) refuse(`--resident-snap-dir ${residentSnapDir} has no ${f}`);
}
const runner = path.join(root, "node-runner.mjs");
const probes = path.join(root, "probes");
const readProbe = (name) => fs.readFileSync(path.join(probes, name), "utf8");
// The children boot the runtime: run them on this Node (PATH's `node` may be
// another version, or absent in a container) with the deep JS stack the
// runtime needs (HOSTING.md); --stack-size on the gate itself reaches no child.
const STACK = "--stack-size=8192";

// One child at a time, asynchronously: a gate killed by a signal kills the runtime
// it is waiting on (a blocking execFileSync could not, and the never-exiting
// runtime would outlive it).
let current = null;
// the gate's temp dirs: removed when their run ends, and by the handler on a signal
// (process.exit skips every pending `finally`)
const tempDirs = new Set();
const mkTemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tempDirs.add(d); return d; };
const rmTemp = (d) => { fs.rmSync(d, { recursive: true, force: true }); tempDirs.delete(d); };
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    if (current) current.kill("SIGKILL");
    for (const d of tempDirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    process.exit(128 + os.constants.signals[sig]);
  });
}
// The runner knobs at their defaults for every child unless a check sets one: the checks
// judge the runtime, not the caller's shell ("" counts as unset in node-runner).
const PINNED = {
  LEAN4_WASM64_CWD: "", LEAN4_WASM64_PTHREAD_STACK_MB: "", LEAN4_WASM64_PTHREAD_POOL: "", LEAN4_WASM64_RTSTATS: "",
  LEAN_WASM_STACK_PROBE_SLOTS: "", LEAN_WASM_PARKED_DEDICATED: "", LEAN_WASM_PARKED_IDLE_MS: "", LEAN_WASM_STD_SURPLUS_EXIT: "",
  LEAN_WASM_SYMTAB_TRACE: "",
};
// 0039's G7: every run traces the native-symbol lookups that miss a `lean_*` name (none may: the
// interpreter never asks for a C runtime function by name) unless a check traces more. Runtimes
// before 0039 ignore the variable.
const TRACE_LEAN = { LEAN_WASM_SYMTAB_TRACE: "miss:lean_" };
/** The `[symtab] …` lines of a run's stderr (persistent-probe prefixes them with `[lean:stderr] `). */
const symtabLines = (stderr) => String(stderr).split("\n").flatMap((l) => {
  const m = /\[symtab\] (miss -|hit \S+) (\S+)\s*$/.exec(l);
  return m ? [{ hit: m[1] !== "miss -", kind: m[1].startsWith("hit ") ? m[1].slice(4) : null, name: m[2] }] : [];
});
const missedLean = []; // [run, name]: G7
const noteMisses = (label, stderr) => { for (const t of symtabLines(stderr)) if (!t.hit && t.name.startsWith("lean_")) missedLean.push([label, t.name]); };
// `stopWhen(quietMs)`, polled every 250 ms with how long the child has printed nothing: true SIGKILLs
// the child, which resolves with `stopped: true` (block 7's bake: the one-shot CLI never exits, so a
// run that writes a file is stopped once that file is complete; stableFile below).
function runChild(args, timeoutMs, env = {}, stopWhen = null) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...PINNED, ...env } });
    current = child;
    let stdout = "", stderr = "", timedOut = false, stopped = false, lastOutput = Date.now();
    child.stdout.on("data", (d) => { stdout += d; lastOutput = Date.now(); });
    child.stderr.on("data", (d) => { stderr += d; lastOutput = Date.now(); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    const poll = stopWhen && setInterval(() => {
      if (!stopped && !timedOut && stopWhen(Date.now() - lastOutput)) { stopped = true; child.kill("SIGKILL"); }
    }, 250);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      current = null;
      // stderr always reaches the gate's log (ABORT, panics, probe diagnostics); a clean
      // exit is judged by stdout, anything else by both streams
      process.stderr.write(stderr);
      if (code === 0) resolve({ stdout, stderr, status: 0, timedOut, stopped });
      else resolve({ stdout: `${stdout}\n${stderr}`, stderr, status: code ?? (timedOut ? 124 : 1), timedOut, stopped });
    });
  });
}

// `leanFlags`: Lean's own options, before the file
async function runLean(source, label, env = {}, leanFlags = []) {
  const work = mkTemp("lean4-wasm64-gate-");
  fs.writeFileSync(path.join(work, "input.lean"), source);
  // Since the keepalive guard (patch 0020) and the resident transport (0031),
  // the one-shot CLI prints its output and then never exits — the Emscripten
  // runtime is kept alive for library-style use, which is what the product
  // relies on (snapshot loads and warm compiles before `main`). Measured
  // 2026-09-07 on the served 0032 runtime and on 0033 alike: `#eval` prints 64,
  // `rfl` elaborates, the process is killed by the timeout. The CLI checks below
  // are therefore judged by OUTPUT; a timeout is reported, not failed.
  try {
    const r = await runChild([STACK, runner, "--artifact", artifact, "--work", work, "--", ...leanFlags, "/work/input.lean"], 240_000, { ...TRACE_LEAN, ...env });
    noteMisses(label, r.stderr);
    return r;
  } finally {
    rmTemp(work);
  }
}
// the runtime's diagnostic lines, which no check judges ([symtab]: 0039's lookup trace)
const stripDebug = (s) => s.replace(/\[(DEBUG:PROGRESS|WASM (DEBUG|LSP|PROFILE|INIT)|symtab)\][^\n]*(?:\n|$)/g, "");
let failures = 0;
const gate = (ok, label, extra = "") => {
  console.log(`${ok ? " ok " : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures += 1;
};

// PATCH 0038, STATIC (G1): the glue sizes its pthread pool from Module.pthreadPoolSize
// (src/emscripten-pthread-pool.js, a JS library of the link). A link that silently lost the
// library would keep a fixed pool and pass every runtime check, so the glue's own text is checked.
// A runtime before 0038 has none of these names: its 0038 checks are skipped with a note.
const glue = fs.readFileSync(path.join(artifact, "bin/lean.js"), "utf8");
const KNOB_EXPORTS = ["_lean_wasm_task_manager_stat", "_lean_wasm_engine_probes", "_lean_wasm_engine_guard_trips"];
const poolGlue = {
  loop: /var pthreadPoolSize\s*=\s*leanPthreadPoolTarget\s*;/.test(glue),
  target: /var leanPthreadPoolTarget\s*=\s*leanPoolInt\(\s*Module\[\s*["']pthreadPoolSize["']\s*\]\s*,\s*24\s*,\s*0\s*,\s*64\s*\)/.test(glue),
  parse: /function leanPoolInt\(/.test(glue),
};
const knobExports = KNOB_EXPORTS.filter((n) => glue.includes(`Module["${n}"]`));
const is0038 = Object.values(poolGlue).some(Boolean) || knobExports.length > 0;
const skip0038 = (label) => console.log(`note  [0038] ${label}: skipped (a runtime before 0038)`);
if (is0038) {
  gate(Object.values(poolGlue).every(Boolean), "[0038] the glue's pthread pool is Module.pthreadPoolSize (var pthreadPoolSize=leanPthreadPoolTarget)",
    Object.entries(poolGlue).filter(([, ok]) => !ok).map(([k]) => `missing: ${k}`).join(", "));
  gate(knobExports.length === KNOB_EXPORTS.length, "[0038] the task-manager and engine-guard counters are exported",
    KNOB_EXPORTS.filter((n) => !knobExports.includes(n)).map((n) => `missing: ${n}`).join(", "));
} else {
  skip0038("the glue's pool size and the counter exports");
}

// PATCH 0039, STATIC (runtime-contract.mjs). S2 and S6 hold for every runtime: the exports hosts
// call, bound on Module to function exports (raw wasm names are minified since 0039, so they are
// checked through the glue's own bindings), and the glue internals QED64's worker and node-runner
// reach into. S1, from 0039 on: no generated Lean name exported, a small glue, a statically linked
// module. From the repository (import-release.sh gate-dir) S2 also checks src/emscripten-exports.seed.txt.
const seedFile = path.join(root, "..", "..", "src", "emscripten-exports.seed.txt");
const seed = fs.existsSync(seedFile) ? parseSeed(fs.readFileSync(seedFile, "utf8")) : null;
const statics = (() => {
  let wasmBytes;
  try { wasmBytes = fs.readFileSync(path.join(artifact, "bin/lean.wasm")); } catch { wasmBytes = new Uint8Array(0); }
  return staticChecks({ glue, wasmBytes, seed });
})();
const is0039 = statics.level === "0039";
for (const r of statics.results) {
  if (r.note) console.log(`note  ${r.label}`);
  else gate(r.ok, r.label, r.extra);
}
const skip0039 = (label) => console.log(`note  [0039] ${label}: skipped (a runtime before 0039)`);
// Patch 0039b put the plain functions into the table: G2 requires plain entries and G5 requires
// Lean.Name.append to run native. False gates a table built without them (gen-exports.py
// INCLUDE_PLAIN = False, 0039's, for an A/B): G5 then only reports which way the call went.
const EXPECT_PLAIN_NATIVE = true;

// The runtime's counters (LEAN4_WASM64_RTSTATS=1): node-runner answers a printed line containing
// `[rtstats?]` with `[rtstats] <json>` right after it (runtime-knobs.mjs runtimeStats).
const RTSTATS = { LEAN4_WASM64_RTSTATS: "1" };
const ASK = '#eval IO.println "ASK [rtstats?]"\n';
const rtstatsOf = (out) => {
  const lines = out.split("\n");
  return lines.flatMap((l, i) => {
    const m = /^\[rtstats\] (\{.*\})$/.exec(l);
    if (!m || i === 0) return [];
    try { return [{ asked: lines[i - 1], ...JSON.parse(m[1]) }]; } catch { return []; }
  });
};
const askedStats = (out, marker) => rtstatsOf(out).find((s) => s.asked.includes(`${marker} [rtstats?]`)) ?? null;
const poolTargets = [];

// G5/G6 judge probes/thread-knobs.lean, which samples the task manager every 100 ms for 3 s after
// a burst of blocking pool tasks (phase nest) and after a burst of dedicated tasks (phase burst):
// `KNOBS <phase>[-end] t=<ms since the burst> [rtstats?]`. With the knobs on (`on`) the surplus
// standard workers exit and parked threads leave after IDLE_MS; by default neither happens.
const IDLE_MS = 300;
function judgeKnobs(out, on, tag) {
  if (!is0038) return skip0038(`thread knobs [${tag}]`);
  const samples = rtstatsOf(out).flatMap((s) => {
    const m = /KNOBS (nest|burst)(?:-end)? t=(\d+) \[rtstats\?\]/.exec(s.asked);
    return m && s.tm ? [{ phase: m[1], t: Number(m[2]), tm: s.tm }] : [];
  });
  const nest = samples.filter((x) => x.phase === "nest"), burst = samples.filter((x) => x.phase === "burst");
  const n = nest.at(-1)?.tm, b = burst.at(-1)?.tm;
  const std = n ? `live ${n.liveStd}, cap ${n.stdCap}, peak ${n.liveStdPeak}, surplus exits ${n.stdSurplusExits}${n.stdSpawns == null ? "" : `, ${n.stdSpawns} started`}` : "no sample";
  const mostParked = burst.length ? Math.max(...burst.map((x) => x.tm.parked)) : null;
  if (!on) {
    // past the cap (--threads=2): with the burst inside the cap, "every worker stays" would hold whatever the runtime did
    gate(!!n && n.liveStdPeak > n.stdCap && n.stdSurplusExits === 0 && n.liveStd === n.liveStdPeak,
      `[0038] [${tag}] after a Task.get burst past the cap every standard worker stays (LEAN_WASM_STD_SURPLUS_EXIT unset)`, std);
    gate(!!b && mostParked === 0 && b.parkedIdleExits === 0,
      `[0038] [${tag}] after a burst of dedicated tasks no thread parks or leaves idle (parking unset)`,
      b ? `parked at most ${mostParked}, idle exits ${b.parkedIdleExits}` : "no sample");
    return;
  }
  gate(!!n && n.liveStdPeak > n.stdCap && n.liveStd <= n.stdCap && n.stdSurplusExits >= n.liveStdPeak - n.stdCap,
    `[0038] [${tag}] LEAN_WASM_STD_SURPLUS_EXIT=1: after a Task.get burst the standard workers fall back to the cap`, std);
  const first = burst.findIndex((x) => x.tm.parked > 0);
  const gone = first < 0 ? -1 : burst.findIndex((x, i) => i > first && x.tm.parked === 0);
  gate(first >= 0 && gone >= 0 && burst[gone].t <= IDLE_MS + 1000 && b.parked === 0 && b.parkedIdleExits >= 1,
    `[0038] [${tag}] LEAN_WASM_PARKED_IDLE_MS=${IDLE_MS}: parked dedicated threads leave once idle that long (1 s slack)`,
    !b ? "no sample" : first < 0 ? "no thread parked" : gone < 0 ? `${b.parked} still parked ${burst.at(-1).t} ms after the burst`
      : `${mostParked} parked, none ${burst[gone].t} ms after the burst; idle exits ${b.parkedIdleExits}`);
}

// G3 rides on three runs, this one (-3), the legacy file (4) and the Meta deep recursion (abc):
// LEAN4_WASM64_PTHREAD_POOL is Module.pthreadPoolSize, which the glue reads as 0, 4 and 24 (the
// default). The pool size changes only how many Workers exist before a thread needs one, so the
// runs' own checks hold at any size.
// THREAD KNOBS OFF (0038, G5/G6) ride on this run too: probes/thread-knobs.lean after it, with
// every knob unset and the standard-worker cap at 2 (--threads=2), so its Task.get burst goes past
// the cap; the workers beyond it stay and no dedicated thread parks, as before 0038.
const smokePool = { LEAN4_WASM64_PTHREAD_POOL: "-3", ...RTSTATS };
const smoke = await runLean("#eval System.Platform.numBits\nexample : (2 + 2 : Nat) = 4 := by rfl\n" + ASK + readProbe("thread-knobs.lean"),
  "smoke", smokePool, ["--threads=2"]);
poolTargets.push(["-3", 0, askedStats(smoke.stdout, "ASK")]);
// as before 0038, only the progress lines are set aside (and 0039's lookup trace), not every diagnostic line
const smokeOut = smoke.stdout.replace(/\[(DEBUG:PROGRESS|symtab)\][^\n]*(?:\n|$)/g, "");
gate(/^64$/m.test(smoke.stdout) && !/error/i.test(smokeOut),
  "numBits=64 + rfl proof (judged by output)", smoke.timedOut ? "CLI kept alive after main, killed by the timeout (patch 0020; expected)" : `exit ${smoke.status}`);
// QED64's contract: callMain reaches main only through _emscripten_proxy_main, and a stock MAIN_MODULE
// glue returned silently when it could not resolve it. The CLI printing anything at all means main ran.
gate(/^64$/m.test(smoke.stdout), "callMain ran main (the one-shot CLI printed #eval's 64)",
  /^64$/m.test(smoke.stdout) ? "" : "no output: main never ran (is _emscripten_proxy_main exported and callMain's entry function bound?)");
judgeKnobs(smoke.stdout, false, "knobs off");

// THREAD KNOBS ON (0038, G5/G6) ride on the false proof: probes/thread-knobs.lean after it, with
// the standard-worker cap at 2 (--threads=2), surplus standard workers exiting, and parked
// dedicated threads (8) leaving after 300 ms idle. The proof's error is on line 1 whatever follows.
const KNOBS_ON = { LEAN_WASM_STD_SURPLUS_EXIT: "1", LEAN_WASM_PARKED_DEDICATED: "8", LEAN_WASM_PARKED_IDLE_MS: "300", ...RTSTATS };
const bad = await runLean("example : (1 + 1 : Nat) = 3 := by rfl\n" + readProbe("thread-knobs.lean"), "bad", KNOBS_ON, ["--threads=2"]);
gate(/input\.lean:1:\d+: error|"severity":\s*"error"/.test(bad.stdout), "false proof reports a positioned error (judged by output)", bad.timedOut ? "CLI kept alive, killed by the timeout (expected)" : `exit ${bad.status}`);
judgeKnobs(bad.stdout, true, "knobs on");

// The parse defect lives in the PERSISTENT path (lean_wasm_compile); the
// one-shot CLI has always reported parse errors. Drive the persistent probe
// and require its garbage compile to surface diagnostics.
const probe = await runChild([STACK, path.join(root, "persistent-probe.mjs"), "--artifact", artifact], 600_000, TRACE_LEAN);
noteMisses("persistent", probe.stderr);
const probeOut = probe.stdout;
const probeStatus = probe.status;
gate(probeStatus === 0 && probeOut.includes("PERSISTENT PROBE PASS"), "persistent path: init, resident reuse, error reporting, survival");
const parseFixed = probeOut.includes("runtime defect is FIXED");

// G2 (0039): the native-symbol table is intact in the running module and in use. The probe prints
// `SYMTAB {json}` after its compiles (runtime-knobs.mjs symtabStats): a fresh self-check (a full
// decode: order, kinds, addresses, FNV), the entries by kind, the lookups. Against the build's own
// manifest when the artifact is a build tree (lib/temp/lean_wasm_symtab.json: gate-dir).
if (is0039) {
  const m = /^SYMTAB (\{.*\})$/m.exec(probeOut);
  let st = null;
  try { st = m ? JSON.parse(m[1]) : null; } catch { st = null; }
  const manifestFile = path.join(artifact, "lib/temp/lean_wasm_symtab.json");
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")); } catch { manifest = null; }
  const problems = [];
  if (!st) problems.push("no SYMTAB line from the persistent probe");
  else {
    const sum = Object.values(st.kinds).reduce((a, n) => a + n, 0);
    const hits = Object.values(st.hits).reduce((a, n) => a + n, 0);
    if (st.status !== 0 || st.cachedStatus !== 0) problems.push(`self-check status ${st.status} (cached ${st.cachedStatus}), not 0`);
    if (sum !== st.count) problems.push(`its kinds add up to ${sum}, not its ${st.count} entries`);
    for (const k of ["boxed", "export", "cell", "init", "init_rt", "init_meta"]) if (!(st.kinds[k] > 0)) problems.push(`no ${k} entry`);
    if (EXPECT_PLAIN_NATIVE ? !(st.kinds.plain > 0) : st.kinds.plain !== 0)
      problems.push(EXPECT_PLAIN_NATIVE ? "no plain entry (0039b: gen-exports.py INCLUDE_PLAIN)" : `${st.kinds.plain} plain entries, with EXPECT_PLAIN_NATIVE off`);
    if (manifest) {
      if (st.count !== manifest.count) problems.push(`${st.count} entries, the manifest ${manifest.count}`);
      for (const [k, n] of Object.entries(manifest.counts ?? {})) if (st.kinds[k] !== n) problems.push(`${k} ${st.kinds[k]}, the manifest ${n}`);
      if (st.fnv !== manifest.fnv1a64) problems.push(`fnv ${st.fnv}, the manifest ${manifest.fnv1a64}`);
    }
    if (hits === 0) problems.push("no lookup found an entry");
  }
  gate(problems.length === 0, `[0039] G2 the native-symbol table is intact (self-check, kinds${manifest ? ", the build's manifest" : ""}) and in use`,
    problems.length ? problems.join("; ")
      : `${st.count} entries, fnv ${st.fnv}; found ${Object.entries(st.hits).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ")}; ${st.misses} not found`);
} else {
  skip0039("G2 the native-symbol table");
}

// MODULE-SEMANTICS GATES (qed64 HARDENING #51): the environment's own facts for a
// user file, not its messages. On Emscripten every import happens at one level
// (`.server` since 0042); if the file's header flag is not threaded through,
// `importModules` derives `isModule` from the level and a legacy file elaborates
// as a module (private-by-default defs, `@[server_rpc_method]` rejected). The
// three legacy probes run as ONE file (they all `import Lean`); the `module`
// file runs alone. Probe sources: probes/*.lean next to this file (from qed64
// tests/adversarial/kernel-probes).
const legacySrc = "import Lean\n" + ["is-module.lean", "private-default.lean", "rpc-attr.lean"]
  .map((f) => readProbe(f).replace(/^import Lean\n/m, "")).join("\n");
// 0039 rides on this run too (G3, G4, G5, G6, G7): probes/symtab.lean after the legacy probes, and the
// runtime traces every lookup that found nothing plus those that found the probe's names.
const SYMTAB_HITS = ["l_Lean_versionString", "l_Lean_Meta_simpExtension", "l_Lean_Name_append"];
const legacy = await runLean(legacySrc + ASK + "\n" + readProbe("symtab.lean"), "legacy",
  { LEAN4_WASM64_PTHREAD_POOL: "4", ...RTSTATS, LEAN_WASM_SYMTAB_TRACE: `miss:;hit:${SYMTAB_HITS.join(",")}` });
poolTargets.push(["4", 4, askedStats(legacy.stdout, "ASK")]);
const legacyOut = stripDebug(legacy.stdout);
gate(/isModule=false/.test(legacyOut) && !/isModule=true/.test(legacyOut), "legacy file: env.header.isModule = false",
  legacy.timedOut ? "CLI kept alive (expected)" : `exit ${legacy.status}`);
gate(/plainDef/.test(legacyOut) && !/_private/.test(legacyOut), "legacy file: plain `def` is not private by default");
gate(!/error/i.test(legacyOut), "legacy file: @[server_rpc_method] / attribute [tactic] / @[app_unexpander] on plain defs accepted",
  /error/i.test(legacyOut) ? legacyOut.split("\n").find((l) => /error/i.test(l))?.slice(0, 160) : "");
const moduleFile = await runLean(readProbe("module-file.lean"), "module", { LEAN_WASM_SYMTAB_TRACE: "miss:" });
const moduleOut = stripDebug(moduleFile.stdout);
gate(/isModule=true/.test(moduleOut) && !/error/i.test(moduleOut), "`module` file: env.header.isModule = true",
  moduleFile.timedOut ? "CLI kept alive (expected)" : `exit ${moduleFile.status}`);

// THE NATIVE-SYMBOL TABLE AT WORK (0039), from the two runs above: every lookup that found nothing,
// and the hits on probes/symtab.lean's names, traced on stderr.
if (is0039) {
  const legacyTrace = symtabLines(legacy.stderr), moduleTrace = symtabLines(moduleFile.stderr);
  const traced = legacyTrace.some((t) => !t.hit) && moduleTrace.some((t) => !t.hit);
  // G3: Init/Std/Lean's module initializers (initialize_ in the legacy file, runtime_/meta_initialize_
  // in the module) are all native: a miss would replay their [init] decls interpreted
  const CORE_INIT = /^(runtime_|meta_)?initialize_(Init|Std|Lean)(_|$)/;
  const initMisses = [...legacyTrace, ...moduleTrace].filter((t) => !t.hit && CORE_INIT.test(t.name)).map((t) => t.name);
  const replayed = /already (exists|been initialized)/.test(legacy.stdout + moduleFile.stdout);
  gate(traced && initMisses.length === 0 && !replayed,
    "[0039] G3 Init/Std/Lean's module initializers are found in the table (legacy and `module` files: no initializer miss, no replay)",
    !traced ? "no lookup was traced: LEAN_WASM_SYMTAB_TRACE did not reach the runtime"
      : initMisses.length ? `${initMisses.length} missed, e.g. ${initMisses.slice(0, 3).join(", ")}` : replayed ? "an initializer ran twice" : "");
  // G4: interpreted code reads constants from their native cells
  const hitAs = (name) => legacyTrace.find((t) => t.hit && t.name === name)?.kind ?? null;
  const cells = ["l_Lean_versionString", "l_Lean_Meta_simpExtension"].map((n) => [n, hitAs(n)]);
  const g4out = /^SYMTAB G4 versionString \S/m.test(legacyOut) && /^SYMTAB G4 simpExtension has Nat\.add_zero: true$/m.test(legacyOut);
  gate(cells.every(([, k]) => k === "cell") && g4out, "[0039] G4 interpreted code reads constants from their native cells (versionString, simpExtension)",
    cells.map(([n, k]) => `${n}: ${k ? `hit ${k}` : "not found"}`).join(", ") + (g4out ? "" : "; the probe's output is missing"));
  // G5: an interpreted function calling plain (all-object, unboxed) core functions
  const append = hitAs("l_Lean_Name_append");
  const g5out = /^SYMTAB G5 x0\.x1\.x2$/m.test(legacyOut);
  if (EXPECT_PLAIN_NATIVE) {
    gate(append === "plain" && g5out, "[0039b] G5 interpreted code calls a plain core function natively (Lean.Name.append)",
      `${append ? `hit ${append}` : "not found: interpreted"}${g5out ? "" : "; the probe's output is wrong"}`);
  } else {
    gate(g5out, "[0039] G5 interpreted code calling plain core functions computes the right value", g5out ? "" : "the probe's output is wrong");
    console.log(`note  [0039] G5 Lean.Name.append ran ${append ? `native (hit ${append})` : "interpreted (plain functions are not in the table)"}`);
  }
  // G6 (informational): the same function 20,000 times
  console.log(`note  [0039] G6 symtabProbe 20000: ${(/^SYMTAB G6 parts=(\d+) ms=(\d+)$/m.exec(legacyOut) ?? [, "?", "?"]).slice(1).join(" parts, ")} ms`);
  // G7 here is a count (its check, no lookup missed a `lean_*` name, is judged over every run, at the end)
  const misses = new Set([...legacyTrace, ...moduleTrace].filter((t) => !t.hit).map((t) => t.name));
  console.log(`note  [0039] G7 ${misses.size} distinct lookups found nothing`);
} else {
  skip0039("G3-G7 the native-symbol table at work");
}

// TASK-MANAGER STORM (patch 0035). Every shape of task traffic the language
// server produces, at volume (probes/task-storm.lean): a forAsync
// chain of dedicated continuations, a fan-out released by one promise, a ladder
// of dedicated tasks that each block on the next (deadlocks if a dedicated task
// ever waits behind another), pool tasks blocked on dedicated ones, waitAny.
// Threads are created with the task-manager lock released (under Emscripten
// every pthread_create is a synchronous round trip to the main JS thread).
// Run twice: the DEFAULT (no parking — qed64 L9) as served, and with parking
// enabled (LEAN_WASM_PARKED_DEDICATED=8) so the opt-in path stays verified.
const stormRun = async (env, tag) => {
  const r = await runLean(readProbe("task-storm.lean"), "storm", { QED64_COUNT_PTHREADS: "1", ...env });
  const out = stripDebug(r.stdout);
  const ok = /STORM OK dedicated=(\d+) checksum=(\d+)/.exec(out);
  const created = /\[pthreads\] created=(\d+)/.exec(out);
  const leaked = /LEAKED-STDERR bytes=(\d+)/.exec(out);
  gate(!!ok, `task-manager storm completes [${tag}] (chain, fan-out, ladder, pool waits, waitAny)`,
    ok ? `${ok[1]} dedicated tasks, checksum ${ok[2]}${created ? `, ${created[1]} pthreads created` : ""}`
       : (/STORM FAIL[^\n]*/.exec(out)?.[0] ?? (r.timedOut ? "no result before the timeout — deadlock?" : `exit ${r.status}`)));
  gate(!!leaked && leaked[1] === "0", `[${tag}] a later dedicated task does not inherit a leaked stream redirection`,
    leaked ? `${leaked[1]} bytes reached the leaked buffer` : "no result");
  return { ok, created };
};
await stormRun({}, "default: no parking");
const parked = await stormRun({ LEAN_WASM_PARKED_DEDICATED: "8" }, "parking 8");
gate(!!parked.ok && !!parked.created && Number(parked.created[1]) * 4 <= Number(parked.ok[1]),
  "[parking 8] dedicated tasks reuse parked threads (at most 1 pthread created per 4 dedicated tasks)",
  parked.created ? `${parked.created[1]} pthreads created for ${parked.ok ? parked.ok[1] : "?"} dedicated tasks` : "pthread count unavailable");
// DEEP RECURSION AT A BROWSER'S STACK (patch 0036, qed64 HARDENING #60). Wasm frames run on the
// engine's stack — a Chrome Worker gets 500 KiB, Node's pthreads 4 MiB — which Lean's own guards
// never measured: running out threw a RangeError that killed the thread. The node-runner knob
// LEAN4_WASM64_PTHREAD_STACK_MB=0.68 gives the pthreads Chrome's budget (Node keeps ~192 KiB of it).
const CHROME = { LEAN4_WASM64_PTHREAD_STACK_MB: "0.68" };
const overflowed = (out) => /Maximum call stack size exceeded|too much recursion/.test(out);
// G7 (0038): each run then asks for the engine guard's counters (GUARD); the Meta one also carries
// G3's third pool size, abc (the default, 24: no change for this run).
const GUARD = '#eval IO.println "GUARD [rtstats?]"\n';
const guardOf = (out) => askedStats(out, "GUARD")?.guard ?? null;
// 0036's two messages in full: consumers recognise the guard by these words (QED64's lib/stack-limit.ts,
// PATCHES.md 0036), so a reword has to stop here, not reach a release. Each is checked whole: the Meta one's
// first words are also plain maxRecDepth's.
const GUARD_TEXT_META = "maximum recursion depth has been reached: the WebAssembly runtime's stack is exhausted (a browser gives it far less stack than native Lean has; raising maxRecDepth does not help, and the same code may succeed natively)";
const GUARD_TEXT_KERNEL = "the WebAssembly engine's stack is exhausted: this proof recurses deeper than a browser allows (the same proof may check natively)";
const GUARD_REWORDED = "not 0036's exact words: consumers match them, so a reword needs a matching QED64 change and a release-notes line (PATCHES.md 0036)";
const deepMetaRun = await runLean(readProbe("deep-recursion.lean") + GUARD, "deep", { ...CHROME, LEAN4_WASM64_PTHREAD_POOL: "abc", ...RTSTATS });
poolTargets.push(["abc", 24, askedStats(deepMetaRun.stdout, "GUARD")]);
const deepMeta = stripDebug(deepMetaRun.stdout);
gate(deepMeta.includes(GUARD_TEXT_META) && /DEEP SURVIVED/.test(deepMeta) && !overflowed(deepMeta),
  "deep recursion at Chrome's stack (Meta): 0036's message in full, the thread survives",
  overflowed(deepMeta) ? "the engine's stack overflowed (RangeError)" : !/DEEP SURVIVED/.test(deepMeta) ? "no result" : deepMeta.includes(GUARD_TEXT_META) ? "" : GUARD_REWORDED);
const deepKernelRun = await runLean(readProbe("deep-recursion-kernel.lean") + GUARD, "deep-kernel", { ...CHROME, ...RTSTATS });
const deepKernel = stripDebug(deepKernelRun.stdout);
gate(deepKernel.includes(GUARD_TEXT_KERNEL) && /DEEP SURVIVED/.test(deepKernel) && !overflowed(deepKernel),
  "deep recursion at Chrome's stack (kernel): 0036's message in full, the thread survives",
  overflowed(deepKernel) ? "the engine's stack overflowed (RangeError)" : !/DEEP SURVIVED/.test(deepKernel) ? "no result" : deepKernel.includes(GUARD_TEXT_KERNEL) ? "" : GUARD_REWORDED);
const deepRoomyRun = await runLean(readProbe("deep-recursion.lean") + GUARD, "deep-roomy", RTSTATS);
const deepRoomy = stripDebug(deepRoomyRun.stdout);
gate(/DEEP SURVIVED/.test(deepRoomy) && !/error/i.test(deepRoomy),
  "the same Meta proof at the default stack still checks (the probe does not cost valid proofs)",
  /error/i.test(deepRoomy) ? deepRoomy.split("\n").find((l) => /error/i.test(l))?.slice(0, 160) : "");
// G7: counters only (the guard itself is 0036's): a question is counted at each probe point of
// the two guard sites, a refusal by site (0 the kernel's depth guard, 1 Core.checkSystem)
if (is0038) {
  const shownGuard = (g) => (g ? `probes ${g.probes}, refused: kernel ${g.trips[0]}, checkSystem ${g.trips[1]}` : "no sample");
  const gMeta = guardOf(deepMetaRun.stdout), gKernel = guardOf(deepKernelRun.stdout), gRoomy = guardOf(deepRoomyRun.stdout);
  gate(!!gMeta && gMeta.trips[1] >= 1, "[0038] engine-guard counters at Chrome's stack (Meta): Core.checkSystem's refusal is counted", shownGuard(gMeta));
  gate(!!gKernel && gKernel.trips[0] >= 1, "[0038] engine-guard counters at Chrome's stack (kernel): the kernel guard's refusal is counted", shownGuard(gKernel));
  gate(!!gRoomy && gRoomy.probes > 0 && gRoomy.trips[0] === 0 && gRoomy.trips[1] === 0,
    "[0038] engine-guard counters at the default stack: the guard asked, and refused nothing", shownGuard(gRoomy));
  gate(poolTargets.every(([, want, x]) => x?.pool?.target === want),
    "[0038] LEAN4_WASM64_PTHREAD_POOL is the glue's pool size: -3, 4, abc give 0, 4, 24",
    poolTargets.map(([v, want, x]) => `${v}: ${x?.pool?.target ?? "no sample"}${x?.pool?.target === want ? "" : ` (want ${want})`}`).join(", "));
} else {
  skip0038("the engine-guard counters and the pool sizes");
}
// ASYNC ELABORATION THROUGH lean_wasm_compile (patch 0037; qed64 probe-neg N6, N6b, N7). With
// `Elab.async` on, a theorem's proof, kernel check and (when the whole command is async) linters
// run in tasks whose messages live only in `Command.State.snapshotTasks`; the persistent shell
// read only `messages`, so a false proof compiled with errors=0. The CLI checks above cannot see
// this (runFrontend reports the whole snapshot tree), so these cases run through the persistent
// path, twice each, in one resident runtime. Every case also runs as a synchronous twin
// (`Elab.async true` -> `false`, line numbers kept): the async compile must report what its twin
// reports. Init-only cases first, then the `import Lean` ones (one import, then cache hits).
const ASYNC = ["async-unknown-id", "async-unsolved", "async-term-mismatch", "async-global", "async-ok-in",
  "async-sorry", "async-guard-msgs",
  "async-nested-scope", "async-nested-ok", "async-multi", "async-kernel", "async-fanout"];
const ASYNC_INFO = ["async-mixed-lint"]; // printed, not gated (upstream mixed-mode linting)
const twinDir = mkTemp("lean4-wasm64-gate-async-");
let asyncRun;
try {
  const files = [...ASYNC, ...ASYNC_INFO].map((n) => path.join(probes, `${n}.lean`));
  for (const n of ASYNC) {
    const twin = path.join(twinDir, `${n}.sync.lean`);
    fs.writeFileSync(twin, readProbe(`${n}.lean`).replaceAll("Elab.async true", "Elab.async false"));
    files.push(twin);
  }
  asyncRun = await runChild([STACK, path.join(root, "persistent-probe.mjs"), "--artifact", artifact,
    "--cases", files.join(","), "--passes", "2"], 900_000, TRACE_LEAN);
  noteMisses("async cases", asyncRun.stderr);
} finally {
  rmTemp(twinDir);
}
const cases = [...asyncRun.stdout.matchAll(/^CASE (\{.*\})$/gm)].flatMap((m) => { try { return [JSON.parse(m[1])]; } catch { return []; } });
const caseCount = (ASYNC.length * 2 + ASYNC_INFO.length) * 2 + 2;
gate(asyncRun.status === 0 && /^CASES DONE$/m.test(asyncRun.stdout) && cases.length === caseCount,
  "[0037] async cases: every lean_wasm_compile returned (no hang, abort or IO error)",
  `${cases.length}/${caseCount} compiles${asyncRun.timedOut ? ", killed by the timeout" : ""}`);
const caseOf = (name, pass = 1) => cases.find((c) => c.name === name && c.pass === pass);
const brief = (d) => `${d.pos?.line}:${d.pos?.column} ${d.severity} ${String(d.data).split("\n")[0].slice(0, 70)}`;
const shown = (c) => (c ? `return=${c.scalar} [${c.diags.map(brief).join(" | ")}]` : "no result");
const dkey = (d) => JSON.stringify([d.severity, d.pos, d.endPos, d.kind, d.data]);
const dupsOf = (c) => c.diags.filter((d, i) => c.diags.findIndex((e) => dkey(e) === dkey(d)) !== i);
const foreignOf = (c) => c.diags.filter((d) => d.fileName !== c.fileName);
// 1-based line of the probe line equal to (or, with `has`, containing) `text`; 0-based codepoint column of `needle` on it
const srcLines = (n) => readProbe(`${n}.lean`).split("\n");
const lineOf = (n, text, has = false) => srcLines(n).findIndex((l) => (has ? l.includes(text) : l === text)) + 1;
const colOf = (n, text, needle) => { const l = srcLines(n).find((x) => x.includes(text)) ?? ""; return [...l.slice(0, l.indexOf(needle))].length; };
const msg = (severity, re, line, column) => (d) =>
  d.severity === severity && re.test(String(d.data)) && d.pos?.line === line && (column === undefined || d.pos?.column === column);
// exactly these messages, in this order, and this return value (0/1) — from the async compile AND
// its synchronous twin. A twin that misses is a wrong expectation, not a runtime defect: calibrate
// on a runtime without 0037, whose synchronous path already reports correctly.
// Only a twin that ran and returned can show a wrong expectation; a run that stopped early is
// the async-cases check's failure, not the expectations'.
const verdictOf = (ok, a, s) => !s ? `no sync-twin result (the run stopped early: ${cases.length}/${caseCount} compiles)`
  : ok(s) ? shown(a) : s.tag !== 0 ? `sync twin failed: IO error tag=${s.tag}` : `EXPECTATION WRONG, sync twin: ${shown(s)}`;
const expectCase = (n, ret, preds, label) => {
  const ok = (c) => !!c && c.scalar === ret && c.diags.length === preds.length && preds.every((p, i) => p(c.diags[i]));
  const a = caseOf(n), s = caseOf(`${n}.sync`);
  gate(ok(a) && ok(s), label, verdictOf(ok, a, s));
};

const insane = cases.filter((c) => c.tag !== 0 || dupsOf(c).length > 0 || foreignOf(c).length > 0);
gate(cases.length > 0 && insane.length === 0,
  "[0037] every compile: IO.ok, no message reported twice, no message of another compile",
  insane.map((c) => `${c.name}#${c.pass}: tag=${c.tag} dups=${dupsOf(c).length} foreign=${foreignOf(c).length}`).join("; "));

let pn = "async-unknown-id";
expectCase(pn, 1, [msg("error", /^Unknown identifier `foo`$/, lineOf(pn, "exact foo", true), colOf(pn, "exact foo", "foo"))],
  "[0037] async theorem: unknown identifier reported once, at `foo`");
pn = "async-unsolved";
expectCase(pn, 1, [msg("error", /^unsolved goals\n[\s\S]*⊢ n = n \+ 1$/, lineOf(pn, "by skip", true), colOf(pn, "by skip", "by"))],
  "[0037] async theorem: unsolved goals reported once");
pn = "async-term-mismatch";
{
  const line = lineOf(pn, "theorem asyncTermMismatch", true);
  // both errors, columns and order free: the body's type mismatch (only in the proof task when
  // async) and `:= rfl`'s defeq-attribute check (the command's own message; col 0 when async)
  const has = (c, re) => c.diags.some((d) => re.test(String(d.data)));
  const ok = (c) => !!c && c.scalar === 1 && c.diags.length === 2 && c.diags.every((d) => d.severity === "error" && d.pos?.line === line)
    && has(c, /^Type mismatch\n/) && has(c, /^Not a definitional equality/);
  const a = caseOf(pn), s = caseOf(`${pn}.sync`);
  gate(ok(a) && ok(s), "[0037] async term-mode body: its elaboration errors are reported", verdictOf(ok, a, s));
}
pn = "async-global";
expectCase(pn, 0, [
  msg("warning", /^Variable name `h` is not explicitly referenced\./, lineOf(pn, "theorem asyncUnusedH", true), colOf(pn, "theorem asyncUnusedH", "(h :") + 1),
  msg("information", /^asyncUsesH /, lineOf(pn, "#check asyncUsesH")),
], "[0037] file-wide Elab.async: the linter task's warning is reported, and a variable used in an async body is not");
expectCase("async-ok-in", 0, [], "[0037] valid async proof (qed64 P8 shape): nothing reported");
pn = "async-sorry";
expectCase(pn, 0, [msg("warning", /^declaration uses `sorry`$/, lineOf(pn, "theorem asyncSorry", true))],
  "[0037] async theorem proved by sorry: the kernel task's `declaration uses sorry` is reported");
pn = "async-guard-msgs";
expectCase(pn, 1, [msg("error", /^Unknown identifier `foo`$/, lineOf(pn, "theorem asyncBeforeGuard", true), colOf(pn, "theorem asyncBeforeGuard", "foo"))],
  "[0037] #guard_msgs consumes its own async messages and only those (per-command reset)");
pn = "async-nested-scope";
expectCase(pn, 1, [msg("error", /^Unknown identifier `foo✝`$/, lineOf(pn, "probe_async_scope"), 0)],
  "[0037] elabCommand under withScope + Elab.async (lean4game Runner shape): its error is reported once");
expectCase("async-nested-ok", 0, [], "[0037] the Runner shape with a valid proof: nothing reported");
pn = "async-multi";
{
  const at = lineOf(pn, "probe_marker_then_async");
  expectCase(pn, 1, [
    msg("warning", /^0037-sync-marker$/, at, 0),
    msg("error", /^unsolved goals\n/, at),
    msg("information", /^Nat : Type$/, lineOf(pn, "#check Nat")),
    msg("error", /^Unknown identifier `foo`$/, lineOf(pn, "exact foo", true), colOf(pn, "exact foo", "foo")),
    msg("information", /^Nat\.succ/, lineOf(pn, "#check Nat.succ")),
  ], "[0037] several commands: each message once, command by command, a command's own messages before its tasks'");
}
pn = "async-kernel";
expectCase(pn, 1, [msg("error", /^\(kernel\) declaration type mismatch, 'asyncKernelBad' has type/, lineOf(pn, "probe_async_kernel"), 0)],
  "[0037] a kernel error from addDecl's async kernel-check task is reported");
pn = "async-fanout";
expectCase(pn, 1, [msg("error", /43 % 7 = 0/, lineOf(pn, "probe_async_fanout"))],
  "[0037] 41 async proofs started by one command: all joined, the one false proof reported once");
console.log(`note  [0037] fan-out elapsed: async ${caseOf(pn)?.elapsedMs ?? "?"} ms, sync twin ${caseOf(`${pn}.sync`)?.elapsedMs ?? "?"} ms`);

// PARITY: the async compile reports the same messages (as a set: sync and async interleave
// differently inside one command) and the same return value as its synchronous twin. Lines, not
// columns: upstream places some messages differently under async — `:= rfl`'s defeq-attribute
// check (DefEqAttrib.lean) reports at the command (col 0) when async, at the name when not; the
// cases above pin every column that matters.
const asSet = (c) => JSON.stringify(c.diags.map((d) => JSON.stringify([d.severity, d.pos?.line,
  String(d.data).replace(/\?(m|u)\.\d+/g, "?$1")])).sort());
const parityOff = ASYNC.filter((a) => { const x = caseOf(a), s = caseOf(`${a}.sync`); return !x || !s || x.scalar !== s.scalar || asSet(x) !== asSet(s); });
gate(cases.length > 0 && parityOff.length === 0, "[0037] each async case reports what its synchronous twin reports",
  parityOff.map((a) => `${a}: async ${shown(caseOf(a))} vs sync ${shown(caseOf(`${a}.sync`))}`).join("; "));

// DETERMINISM: messages come out in tree order, not task-completion order (the slim/fat
// differential audit compares two runs' messages byte for byte)
const sameRun = (c) => JSON.stringify(c.diags.map(({ fileName, ...d }) => d));
const unstable = [...ASYNC, ...ASYNC.map((a) => `${a}.sync`)]
  .filter((a) => !caseOf(a, 1) || !caseOf(a, 2) || sameRun(caseOf(a, 1)) !== sameRun(caseOf(a, 2)));
gate(cases.length > 0 && unstable.length === 0, "[0037] a second compile of each file prints the same messages in the same order",
  unstable.join(", "));

// REUSE: plain compiles after all the async ones still work (the old Shell.lean comment's fear)
const reErr = caseOf("reuse-error", 0), reOk = caseOf("reuse-clean", 0);
gate(!!reErr && !!reOk && reErr.scalar === 1 && reErr.diags.some((d) => d.severity === "error") && reOk.scalar === 0 && reOk.diags.length === 0,
  "[0037] after the async compiles, an error compile reports its error and a clean compile is clean",
  `error compile ${shown(reErr)}; clean compile ${shown(reOk)}`);
console.log(`note  [0037] mixed-mode linting (option scoped by \`in\`; informational): ${shown(caseOf("async-mixed-lint"))}`);
gate(parseFixed, "THE PARSE GATE: lean_wasm_compile reports parser diagnostics",
  parseFixed ? "" : "persistent shell still swallows parse errors");

// MODULE FILES ON A SHARED ENVIRONMENT (patch 0042). wasmCompile's cache and the snapshots import
// once, as for a legacy file, and `setIsModule` gives each file its own flag. Stock `finalizeImport`
// builds the public constant map only for a `module` importer, so a `module` file served such an
// environment resolved no imported name in a public declaration ("Unknown identifier `Nat`"); the
// CLI run above imports per file and never had the bug. Entering the module system now treats every
// imported module as publicly imported in both phases (a superset of stock). Through
// lean_wasm_compile, in one runtime, twice each: a `module` file importing Lean PRIVATELY first (it
// creates the cache entry the next files reuse; stock rejects its public use of Lean.Expr, the shared
// environment accepts it), a `public meta import` of the same modules, the CLI's module file, Init
// alone, the legacy probes (a legacy file after module files), and a legacy file's imported docs.
const PUB = /isModule=(\w+) publicScope=(\d+) importedDocs=(\w+) importedRanges=(\w+)/;
const MOD_CASES = ["module-private-import", "module-meta", "module-file", "module-no-import", "legacy-after-module", "legacy-docs"];
// R10's exact cell (block 7) rides on this run: its parity probes come after the 0042 cases, so each is
// served a cache entry another file's import created (#[Init] by module-no-import, #[Init, Lean] by
// module-private-import)
const PARITY_EXACT = ["parity-legacy-init", "parity-module-init", "parity-legacy-lean", "parity-module-lean", "parity-module-private-lean"];
const modDir = mkTemp("lean4-wasm64-gate-0042-");
let modRun;
try {
  fs.writeFileSync(path.join(modDir, "legacy-after-module.lean"), legacySrc);
  const files = [...MOD_CASES, ...PARITY_EXACT].map((n) => path.join(n === "legacy-after-module" ? modDir : probes, `${n}.lean`));
  modRun = await runChild([STACK, path.join(root, "persistent-probe.mjs"), "--artifact", artifact,
    "--cases", files.join(","), "--passes", "2"], 900_000, TRACE_LEAN);
  noteMisses("0042 cases", modRun.stderr);
} finally {
  rmTemp(modDir);
}
const modCases = [...modRun.stdout.matchAll(/^CASE (\{.*\})$/gm)].flatMap((m) => { try { return [JSON.parse(m[1])]; } catch { return []; } });
const modCase = (name, pass = 1) => modCases.find((c) => c.name === name && c.pass === pass);
const errorsOf = (c) => (c ? c.diags.filter((d) => d.severity === "error") : []);
const textOf = (c) => (c ? c.diags.map((d) => String(d.data)).join("\n") : "");
const modCount = (MOD_CASES.length + PARITY_EXACT.length) * 2 + 2;
gate(modRun.status === 0 && /^CASES DONE$/m.test(modRun.stdout) && modCases.length === modCount,
  "[0042] module cases: every lean_wasm_compile returned", `${modCases.length}/${modCount} compiles${modRun.timedOut ? ", killed by the timeout" : ""}`);
const modClean = ["module-private-import", "module-meta", "module-file", "module-no-import"]
  .flatMap((n) => [1, 2].map((p) => [`${n}#${p}`, modCase(n, p)]));
gate(modClean.every(([, c]) => c && c.scalar === 0 && errorsOf(c).length === 0),
  "[0042] lean_wasm_compile: `module` files on a shared environment compile (public names from public and private imports, a `meta` import after a plain one, Init alone, cache hits)",
  modClean.filter(([, c]) => !c || c.scalar !== 0 || errorsOf(c).length).map(([n, c]) => `${n}: ${shown(c)}`).join("; "));
const cliPub = PUB.exec(moduleOut), wcPub = PUB.exec(textOf(modCase("module-file")));
gate(!!cliPub && !!wcPub && Number(cliPub[2]) > 0 && Number(wcPub[2]) >= Number(cliPub[2]),
  "[0042] the public scope setIsModule builds contains the CLI's `module` import's (every loaded module counts as public)",
  `lean_wasm_compile ${wcPub?.[2] ?? "no count"}, CLI ${cliPub?.[2] ?? "no count"}`);
const after = modCase("legacy-after-module"), afterText = textOf(after);
gate(!!after && errorsOf(after).length === 0 && /isModule=false/.test(afterText) && /plainDef/.test(afterText) && !/_private/.test(afterText),
  "[0042] lean_wasm_compile: a legacy file after `module` files elaborates as legacy (plain defs public, rpc/tactic attributes accepted)",
  shown(after));
const docsIn = (s) => /importedDocs=true importedRanges=true/.test(s);
const docsVerdict = `CLI module ${docsIn(moduleOut)}, compile module ${docsIn(textOf(modCase("module-file")))}, compile legacy ${docsIn(textOf(modCase("legacy-docs")))}`;
// the docs live in `.olean.server`: a tree without it (none ships so) has nothing to load
if (fs.existsSync(path.join(artifact, "lib/lean/Init/Prelude.olean.server"))) {
  gate(docsIn(moduleOut) && docsIn(textOf(modCase("module-file"))) && docsIn(textOf(modCase("legacy-docs"))),
    "[0042] imported docstrings and declaration ranges are loaded (the `.server` level: CLI and lean_wasm_compile, module and legacy files)", docsVerdict);
} else {
  console.log(`note  [0042] the artifact's tree has no .olean.server facets: imported docs not judged (${docsVerdict})`);
}
console.log(`note  [0042] legacy \`decide\` on Nat.toDigits (stock passes at .private; a known deviation): ${errorsOf(modCase("legacy-docs")).length ? "fails" : "passes"}`);

// R10: STOCK PARITY, AND THE PATHS EVERY BROWSER APP RUNS (kernel review §5 #3; QED64 review R10).
// HARDENING #51 and #80 shipped because no check asked a SHARED environment (wasmCompile's cache, a
// snapshot, the resident FileWorker's registry) for its own facts when it served a file of another
// module-ness. Each fact is asserted against a FIXED value of native stock v4.35.0 (eb6cafb729),
// computed on 2026-11-01 from these probe files (`lean <file>`, the editor level with
// -DElab.inServer=true, Mathlib 56a00585 from stock-built oleans), never against this runtime's CLI,
// which shares the fork's import level. A fact passes on its stock value unless R10_ALLOW names the
// deviation; then only the listed value passes, so a deviation that disappears fails until its entry
// goes (a `>= stock` bound, the public scope, also passes the stock value). The cells: exact (block 6's run: an environment of wasmCompile's cache imported for another
// file), snapshot (an init.snap this gate bakes itself and loads as the browser does, an EMPTY library
// mounted, so every compile is served by the snapshot), and from the optional inputs Mathlib
// (--mathlib-lib: a real `import Mathlib.…` header through lean_wasm_compile), resident
// (--resident-probe: QED64's FileWorker driver on the gate's init.snap) and covered
// (--resident-snap-dir: the same driver on QED64's init + umbrella snapshots). An input left out
// prints a note, never a FAIL.
const r10Start = Date.now(), r10Times = [];
const r10Timed = async (label, f) => { const t = Date.now(); try { return await f(); } finally { r10Times.push(`${label} ${Math.round((Date.now() - t) / 1000)} s`); } };
const R10_ALLOW = {
  superset: "a `module` file served a shared environment sees every loaded module as public, a superset of stock (0042; the user, 2026-10-22)",
  unexposed: "every file imports at `.server`, where stock reads a legacy file's imports at `.private`: bodies a module does not expose stay closed (PATCHES.md 0042, \"Unchanged on purpose\")",
  serverDocs: "every file imports at `.server`, stock's editor level for a `module` file, whose command line (`.exported`) loads no docstrings (0042)",
  covered: "the umbrella's environment serves any header it covers, with every module of the umbrella in scope (0032; QED64 HARDENING #80)",
};
for (const [k, why] of Object.entries(R10_ALLOW)) console.log(`note  [R10] allowlist ${k}: ${why}`);
const atLeast = (n) => Object.assign((v) => typeof v === "number" && v >= n, { shown: `>= ${n}` });
// probe → fact → [stock v4.35.0, allowlist key, what passes in its place]
const R10_FACTS = {
  "parity-legacy-init": { plainPrivate: [false], importedDocs: [true], attrUse: [true], decide: [true, "unexposed", false] },
  "parity-module-init": { plainPrivate: [true], publicUse: [true], attrUse: [false] },
  "parity-legacy-lean": { isModule: [false], plainPrivate: [false], importedDocs: [true], decide: [true, "unexposed", false] },
  "parity-module-lean": { isModule: [true], plainPrivate: [true], publicUse: [true], importedDocs: [false, "serverDocs", true],
    publicScope: [127639, "superset", atLeast(127639)] },
  "parity-module-private-lean": { publicUse: [false, "superset", true] },
  "parity-legacy-mathlib": { isModule: [false], plainPrivate: [false], importedDocs: [true], realDocs: [true], mathlibUse: [true],
    decide: [true, "unexposed", false] },
  "parity-module-mathlib": { isModule: [true], plainPrivate: [true], publicUse: [true], importedDocs: [false, "serverDocs", true],
    realDocs: [false, "serverDocs", true], publicScope: [153957, "superset", atLeast(153957)] },
  "parity-module-private-mathlib": { publicUse: [false, "superset", true] },
};
for (const [probe, fs_] of Object.entries(R10_FACTS)) for (const [fact, [, allow]] of Object.entries(fs_))
  if (allow && !(allow in R10_ALLOW)) throw new Error(`R10_FACTS ${probe}.${fact}: allowlist ${allow} is not in R10_ALLOW`);
const R10_SNAPSHOT = ["parity-legacy-init", "parity-module-init"];
const R10_MATHLIB = ["parity-legacy-mathlib", "parity-module-mathlib", "parity-module-private-mathlib"];
/** A compile's facts: its `PARITY k=v …` line, and each line its probe marks `-- R10:<fact>`: `print`,
 *  the privacy its `#print plainDef` shows; `doc`, no "does not have a doc string" warning there (the
 *  check `@[inherit_doc]` runs in a legacy file); any other fact, no error on that line. */
function r10FactsOf(name, c) {
  if (!c || (c.tag ?? 0) !== 0) return null; // a lean_wasm_compile that threw elaborated nothing
  const lines = readProbe(`${name}.lean`).split("\n");
  const on = (i) => c.diags.filter((d) => d.pos?.line === i + 1);
  // Every probe ends with `#check Nat  -- R10:reached`. Without its message the file was not elaborated
  // to its end (a refused header, a lost compile), and a mark judged by the absence of an error would
  // hold vacuously: no facts at all.
  const reached = lines.findIndex((l) => /-- R10:reached\s*$/.test(l));
  if (reached < 0 || !on(reached).some((d) => d.severity === "information")) return null;
  const facts = {};
  for (const [, k, v] of (/PARITY ([^\n]*)/.exec(textOf(c))?.[1] ?? "").matchAll(/(\w+)=(\S+)/g))
    facts[k] = /^\d+$/.test(v) ? Number(v) : v === "true" ? true : v === "false" ? false : v;
  lines.forEach((l, i) => {
    const mark = /-- R10:(\w+)\s*$/.exec(l)?.[1];
    if (!mark || mark === "reached") return;
    if (mark === "print") {
      const p = on(i).find((d) => d.severity === "information");
      if (p) facts.plainPrivate = String(p.data).startsWith("private ");
    } else if (mark === "doc") facts.importedDocs = !on(i).some((d) => /does not have a doc string/.test(String(d.data)));
    else facts[mark] = !on(i).some((d) => d.severity === "error");
  });
  return facts;
}
// Stock at the editor level (-DElab.inServer=true) where it differs from the command line's: the
// resident FileWorker runs in the server, where a `module` file's imports carry their docstrings.
const R10_EDITOR = { "parity-module-lean": { importedDocs: true }, "parity-module-mathlib": { importedDocs: true, realDocs: true } };
// The covered cell's environment is the umbrella's, with more modules than the header imports.
const R10_COVERED = { modules: [2388, "covered", atLeast(2389)] }; // the umbrella's, more than the header's
/** One gate line per fact of probe `name` in `cell`; every pass of its compile must hold it.
 *  `editor`: judge against stock's editor level; `extra`: facts this cell adds. */
function judgeR10(cell, name, caseOf, { passes = [1, 2], editor = false, extra = {} } = {}) {
  const fsOf = passes.map((p) => r10FactsOf(name, caseOf(name, p)));
  for (const [fact, entry] of Object.entries({ ...R10_FACTS[name], ...extra })) {
    let [stock, allow, instead] = entry;
    const ed = editor ? R10_EDITOR[name]?.[fact] : undefined;
    if (ed !== undefined) { stock = ed; if (ed === instead) allow = instead = undefined; }
    const want = allow ? instead : stock;
    const holds = (v) => (typeof want === "function" ? want(v) : v === want);
    const vs = fsOf.map((f) => f?.[fact]);
    const ok = fsOf.every(Boolean) && vs.every(holds);
    gate(ok, `[R10] ${cell} · ${name} · ${fact} ${typeof want === "function" ? want.shown : `= ${want}`} (stock${editor ? ", editor level" : ""} ${stock}${allow ? `; allowlist ${allow}` : ""})`,
      !fsOf.every(Boolean) ? "no result" : !ok && allow && vs[0] === stock ? `${vs[0]}, the stock value: the deviation is gone, or the runtime lost the superset (see the other ${fact} facts); remove the entry only if that was deliberate`
        : vs.every((v) => v === vs[0]) ? String(vs[0]) : vs.map((v, i) => `pass ${passes[i]} ${v}`).join(", "));
  }
}
/** persistent-probe over parity probes, two passes each, in one runtime. */
async function r10Run(cell, names, extra, timeoutMs) {
  const r = await runChild([STACK, path.join(root, "persistent-probe.mjs"), "--artifact", artifact, ...extra,
    "--cases", names.map((n) => path.join(probes, `${n}.lean`)).join(","), "--passes", "2"], timeoutMs, TRACE_LEAN);
  noteMisses(`R10 ${cell}`, r.stderr);
  const cs = [...r.stdout.matchAll(/^CASE (\{.*\})$/gm)].flatMap((m) => { try { return [JSON.parse(m[1])]; } catch { return []; } });
  const want = names.length * 2 + 2;
  gate(r.status === 0 && /^CASES DONE$/m.test(r.stdout) && cs.length === want, `[R10] ${cell} cell: every lean_wasm_compile returned`,
    `${cs.length}/${want} compiles${r.timedOut ? ", killed by the timeout" : ""}`);
  return { r, caseOf: (n, p = 1) => cs.find((c) => c.name === n && c.pass === p) };
}
/** runChild's stopWhen for a CLI writing `file`: true once it exists, has kept its size for stableMs and the child has been silent for quietMs. */
const stableFile = (file, stableMs, quietMs) => {
  let size = -1, since = Date.now();
  return (quietFor) => {
    let now = -1;
    try { now = fs.statSync(file).size; } catch { /* not yet */ }
    if (now !== size) { size = now; since = Date.now(); }
    return size > 0 && Date.now() - since >= stableMs && quietFor >= quietMs;
  };
};
// QED64's resident FileWorker driver (run from QED64's checkout): the page's argv, thread budget
// and parking from its public/workers/worker-constants.js; its experiment switches (environment) off.
const RESIDENT_ENV = { PROBE_HEADER: "", PROBE_MINIMAL: "", SKIP_TASK_MANAGER: "", DUMP_MSGS: "", RAW_TAP: "" };
async function residentRun(args, timeoutMs) {
  const r = await runChild([STACK, residentProbe, "--artifact", artifact, ...args], timeoutMs, RESIDENT_ENV);
  let v = null;
  try { v = JSON.parse(/^RESIDENT PROBE (?:PASS|FAIL) (\{.*\})$/m.exec(r.stdout)?.[1] ?? "null"); } catch { v = null; }
  const header = /\[WASM LSP\] header (\w+): key=(#\[[^\]]*\])/.exec(r.stdout);
  return { pass: r.status === 0 && /^RESIDENT PROBE PASS /m.test(r.stdout), v, header,
    shown: v ? `${v.why}; ${v.diagnostics} diagnostics, ${v.frames} frames, ${v.nonFrameStdoutBytes} non-frame stdout bytes, ${v.wallMs} ms${header ? `; header ${header[1]} ${header[2]}` : ""}`
      : `no verdict (exit ${r.status}${r.timedOut ? ", killed by the timeout" : ""})` };
}

// The same driver's file mode (--probe-file, QED64 review R4; detected by its text): one probe
// as the page runs a document, act 1 only; its final diagnostics, one {"caption":"",severity,pos,endPos,
// data} line each, are judged at the editor level, one pass.
const residentFiles = !!residentProbe && fs.readFileSync(residentProbe, "utf8").includes("--probe-file");
async function residentFacts(cell, names, args, timeoutMs, extraOf = () => ({})) {
  for (const n of names) {
    const r = await runChild([STACK, residentProbe, "--artifact", artifact, ...args, "--probe-file", path.join(probes, `${n}.lean`), "--dump-messages"],
      timeoutMs, RESIDENT_ENV);
    const diags = [...r.stdout.matchAll(/^(\{"caption":.*\})$/gm)].flatMap((m) => { try { return [JSON.parse(m[1])]; } catch { return []; } });
    const settled = r.status === 0 && /^compile: tag=0 /m.test(r.stdout);
    gate(settled, `[R10] ${cell} cell · ${n}: the resident FileWorker settled`,
      settled ? `${diags.length} diagnostics` : `exit ${r.status}${r.timedOut ? ", killed by the timeout" : ""}`);
    judgeR10(cell, n, (_, p) => (settled && p === 1 ? { diags } : null), { passes: [1], editor: true, extra: extraOf(n) });
  }
}

// THE EXACT CELL: block 6's run
for (const n of PARITY_EXACT) judgeR10("exact", n, modCase);

const r10Dir = mkTemp("lean4-wasm64-gate-r10-");
try {
  // THE GATE'S OWN init.snap (D4 (a): no bake tool, no index, no gzip, nothing of QED64's): node-runner
  // with --incr-header-save at the VFS root. The one-shot CLI never exits, so it is stopped once
  // init.snap has kept its size for 3 s with the runner silent for 3 s: the save writes
  // <file>.tmp.<pid> and renames it, after the frontend's last message (src/library/module.cpp
  // lean_compacted_region_save; src/Lean/Elab/Frontend.lean), so a stable init.snap is a whole one.
  const initSnap = path.join(r10Dir, "init.snap");
  // node-runner forwards these from the shell (node-runner.mjs); the gate's bake takes their defaults
  const BAKE_PINNED = { LEAN_COMPACTOR_RESERVE: "", QED64_ALLOW_LEGACY_IMPORTS: "", QED64_PROFILE_INIT: "" };
  fs.writeFileSync(path.join(r10Dir, "probe.lean"), "#check (2 + 2 : Nat)\n");
  const bake = await r10Timed("bake", () => runChild([STACK, runner, "--artifact", artifact, "--work", r10Dir, "--",
    "--incr-header-save=/work/init.snap", "/work/probe.lean"], 600_000, { ...TRACE_LEAN, ...BAKE_PINNED }, stableFile(initSnap, 3000, 3000)));
  noteMisses("R10 bake", bake.stderr);
  let snapBytes = 0;
  try { snapBytes = fs.statSync(initSnap).size; } catch { /* none */ }
  const baked = snapBytes > 0 && (bake.stopped || bake.status === 0);
  gate(baked && /^2 \+ 2 : Nat$/m.test(bake.stdout), "[R10] the gate bakes its own init.snap (node-runner --incr-header-save=/work/init.snap, stopped once stable)",
    `${snapBytes} bytes${bake.stopped || bake.status === 0 ? "" : bake.timedOut ? "; killed by the timeout before init.snap was stable" : `; the runner exited ${bake.status} first`}`);

  // THE SNAPSHOT CELL: init.snap through lean_wasm_load_snapshot_mem (the browser's loader) before any
  // compile, an empty directory as the library: no olean could have served these compiles
  if (baked) {
    const emptyLib = mkTemp("lean4-wasm64-gate-r10-lib-");
    try {
      const snap = await r10Timed("snapshot cell", () => r10Run("snapshot", R10_SNAPSHOT, ["--lib", emptyLib, "--snapshot", initSnap], 600_000));
      let s = null;
      try { s = JSON.parse(/^SNAPSHOT (\{.*\})$/m.exec(snap.r.stdout)?.[1] ?? "null"); } catch { s = null; }
      gate(!!s && s.tag === 0 && s.scalar === 0 && s.key === "#[Init]",
        "[R10] snapshot cell: init.snap loads through lean_wasm_load_snapshot_mem and is cached under #[Init]",
        s ? `${s.bytes} bytes in ${s.loadMs} ms, key ${s.key ?? "not printed"}${s.tag !== 0 || s.scalar !== 0 ? `, tag ${s.tag} result ${s.scalar}` : ""}` : "no SNAPSHOT line");
      for (const n of R10_SNAPSHOT) judgeR10("snapshot", n, snap.caseOf);
    } finally {
      rmTemp(emptyLib);
    }
  } else {
    gate(false, "[R10] snapshot cell", "not run: no init.snap (the bake above)");
  }

  // THE RESIDENT FILEWORKER: QED64's Init probe on the gate's init.snap (its --snap-dir names init.snap)
  if (!residentProbe) {
    console.log("note  [R10] resident FileWorker: skipped (no --resident-probe <QED64 checkout>/pipeline/snapshot/resident-probe.mjs; an adoption passes it to run this cell)");
  } else if (!baked) {
    gate(false, "[R10] resident FileWorker", "not run: no init.snap (the bake above)");
  } else {
    const x = await r10Timed("resident", () => residentRun(["--snap-dir", r10Dir, "--budget-ms", "180000"], 300_000));
    gate(x.pass && x.v?.nonFrameStdoutBytes === 0,
      "[R10] resident FileWorker on the gate's init.snap (QED64's resident-probe, the page's argv): the document's error published, progress drained, a clean shutdown, only LSP frames on stdout",
      x.shown);
    if (x.v?.argv) console.log(`note  [R10] resident FileWorker argv ${JSON.stringify(x.v.argv)}`);
    if (residentFiles) await r10Timed("resident facts", () => residentFacts("resident", R10_SNAPSHOT, ["--snap-dir", r10Dir, "--snapshots", "init", "--budget-ms", "180000"], 300_000));
    else console.log("note  [R10] resident facts: skipped (this resident-probe has no --probe-file, QED64 review R4)");
  }

  // THE MATHLIB-HEADER CELL: a real `import Mathlib.…` header through lean_wasm_compile, --mathlib-lib the only library
  if (!mathlibLib) {
    console.log("note  [R10] Mathlib-header cell: skipped (no --mathlib-lib <a complete olean tree paired with --artifact>; an adoption passes its lib-tree-slim to run this cell)");
  } else {
    const ml = await r10Timed("Mathlib cell", () => r10Run("Mathlib", R10_MATHLIB, ["--lib", mathlibLib], 1_200_000));
    for (const n of R10_MATHLIB) judgeR10("Mathlib", n, ml.caseOf);
    const mods = (n) => r10FactsOf(n, ml.caseOf(n))?.modules ?? "?";
    console.log(`note  [R10] Mathlib: ${mods("parity-legacy-mathlib")} modules for the legacy file, ${mods("parity-module-mathlib")} for the \`module\` file (stock: 2388; a \`module\` file 2380 at the command line's .exported, 2388 at the editor's .server)`);
  }

  // THE COVERED CELL: the same driver with --mathlib on QED64's init + umbrella snapshots: a legacy
  // `import Mathlib.Data.Real.Basic` served by the umbrella's environment, which covers it
  if (!residentSnapDir) {
    console.log("note  [R10] covered cell: skipped (no --resident-snap-dir <dir with init.snap and mathlib.snap baked for --artifact>)");
  } else {
    const x = await r10Timed("covered cell", () => residentRun(["--snap-dir", residentSnapDir, "--mathlib", "--budget-ms", "600000"], 900_000));
    gate(x.pass, "[R10] covered cell: the resident FileWorker serves `import Mathlib.Data.Real.Basic` from the umbrella snapshot with no error at drain (allowlist covered)", x.shown);
    if (residentFiles) await r10Timed("covered facts", () => residentFacts("covered", R10_MATHLIB, ["--snap-dir", residentSnapDir, "--budget-ms", "600000"], 900_000,
      (n) => (n === "parity-module-private-mathlib" ? {} : R10_COVERED)));
    else console.log("note  [R10] covered facts: skipped (this resident-probe has no --probe-file, QED64 review R4)");
  }
} finally {
  rmTemp(r10Dir);
}
console.log(`note  [R10] block 7: ${Math.round((Date.now() - r10Start) / 1000)} s (${r10Times.join(", ")})`);

// G7 (0039), over every run: no lookup missed a `lean_*` name. The interpreter's keys are Lean
// names (boxed wrappers, @[export] names, cells, initializers); the C runtime's lean_* functions
// left the export list with 0039 and must never have been one.
if (is0039) {
  gate(missedLean.length === 0, "[0039] G7 no lookup in any run missed a lean_* name",
    missedLean.slice(0, 5).map(([run, n]) => `${run}: ${n}`).join(", "));
} else {
  skip0039("G7 the lean_* lookups");
}

console.log(failures === 0 ? "\nGATE PASSED" : `\nGATE FAILED (${failures})`);
// exitCode, not process.exit(): see fetch-release.mjs (shutdown deadlock after heavy JIT work)
process.exitCode = failures === 0 ? 0 : 1;
