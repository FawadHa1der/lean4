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
// Usage: node gate.mjs --artifact <dir> [--baseline-exports <lean.wasm or name list>]
//   --baseline-exports: an earlier runtime's export names (its lean.wasm, read for them, or a list,
//   one per line): G7 then also fails on a lookup that missed one of them.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSeed, readWasm, staticChecks } from "./runtime-contract.mjs";

// The runner harnesses live alongside this gate (self-contained build dir).
const root = path.dirname(fileURLToPath(import.meta.url));
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("usage: gate.mjs --artifact <dir> [--baseline-exports <lean.wasm or name list>]\nThe release gate: every check must print ok. run as: lean4-wasm64 gate   (or: node --stack-size=8192 gate.mjs)\n--baseline-exports: an earlier runtime's export names (its lean.wasm, or one name per line): no lookup may miss one (0039's G7)\nexit codes: 0 GATE PASSED, 1 a check failed, 2 usage");
  process.exit(0);
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
if (arg("baseline-exports") && !fs.existsSync(arg("baseline-exports"))) {
  console.error(`gate: --baseline-exports ${arg("baseline-exports")} not found`);
  process.exit(2);
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
function runChild(args, timeoutMs, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...PINNED, ...env } });
    current = child;
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      current = null;
      // stderr always reaches the gate's log (ABORT, panics, probe diagnostics); a clean
      // exit is judged by stdout, anything else by both streams
      process.stderr.write(stderr);
      if (code === 0) resolve({ stdout, stderr, status: 0, timedOut });
      else resolve({ stdout: `${stdout}\n${stderr}`, stderr, status: code ?? (timedOut ? 124 : 1), timedOut });
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
// G7's optional baseline: an earlier runtime's exports, every name its interpreter could resolve
const baselineArg = arg("baseline-exports");
const baseline = (() => {
  if (!baselineArg) return null;
  const bytes = fs.readFileSync(path.resolve(baselineArg));
  const w = readWasm(bytes);
  if (w.ok) return new Set(w.exports.keys());
  return new Set(bytes.toString("utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
})();
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
  const std = n ? `live ${n.liveStd}, cap ${n.stdCap}, peak ${n.liveStdPeak}, surplus exits ${n.stdSurplusExits}` : "no sample";
  const mostParked = burst.length ? Math.max(...burst.map((x) => x.tm.parked)) : null;
  if (!on) {
    gate(!!n && n.stdSurplusExits === 0 && n.liveStd === n.liveStdPeak,
      `[0038] [${tag}] after a Task.get burst every standard worker stays (LEAN_WASM_STD_SURPLUS_EXIT unset)`, std);
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
const smokePool = { LEAN4_WASM64_PTHREAD_POOL: "-3", ...RTSTATS };
const smoke = await runLean("#eval System.Platform.numBits\nexample : (2 + 2 : Nat) = 4 := by rfl\n" + ASK, "smoke", smokePool);
poolTargets.push(["-3", 0, askedStats(smoke.stdout, "ASK")]);
gate(/^64$/m.test(smoke.stdout) && !/error/i.test(stripDebug(smoke.stdout)),
  "numBits=64 + rfl proof (judged by output)", smoke.timedOut ? "CLI kept alive after main, killed by the timeout (patch 0020; expected)" : `exit ${smoke.status}`);
// QED64's contract: callMain reaches main only through _emscripten_proxy_main, and a stock MAIN_MODULE
// glue returned silently when it could not resolve it. The CLI printing anything at all means main ran.
gate(/^64$/m.test(smoke.stdout), "callMain ran main (the one-shot CLI printed #eval's 64)",
  /^64$/m.test(smoke.stdout) ? "" : "no output: main never ran (is _emscripten_proxy_main exported and callMain's entry function bound?)");

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
// user file, not its messages. On Emscripten every import happens at
// `OLeanLevel.exported`; if the file's header flag is not threaded through,
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
// the runner's layout (lean4-wasm64 -r2): Lean runs at the VFS root, so /work/input.lean is
// module work.input — the layout under which a bake is byte-identical to QED64's runner
gate(/main=work\.input\b/.test(legacyOut), "the one-shot CLI runs at VFS cwd / (main module work.input; bakes byte-identical to QED64's runner)",
  (/main=\S+/.exec(legacyOut) ?? ["no main= line"])[0]);
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
  // G7: every lookup that found nothing asked for a name no earlier runtime could resolve either
  // (the `lean_*` half of G7 is judged over every run, at the end)
  const misses = [...new Set([...legacyTrace, ...moduleTrace].filter((t) => !t.hit).map((t) => t.name))];
  if (baseline) {
    const lost = misses.filter((n) => baseline.has(n));
    gate(traced && lost.length === 0, `[0039] G7 no lookup missed a name the baseline runtime exported (${misses.length} distinct misses)`,
      lost.length ? `missed: ${lost.slice(0, 5).join(", ")}${lost.length > 5 ? ", …" : ""}` : "");
  } else {
    console.log(`note  [0039] G7 ${misses.length} distinct lookups found nothing; no --baseline-exports to compare them with`);
  }
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
const stormRun = async (env, tag, after = "") => {
  const r = await runLean(readProbe("task-storm.lean") + after, "storm", { QED64_COUNT_PTHREADS: "1", ...env });
  const out = stripDebug(r.stdout);
  const ok = /STORM OK dedicated=(\d+) checksum=(\d+)/.exec(out);
  const created = /\[pthreads\] created=(\d+)/.exec(out);
  const leaked = /LEAKED-STDERR bytes=(\d+)/.exec(out);
  gate(!!ok, `task-manager storm completes [${tag}] (chain, fan-out, ladder, pool waits, waitAny)`,
    ok ? `${ok[1]} dedicated tasks, checksum ${ok[2]}${created ? `, ${created[1]} pthreads created` : ""}`
       : (/STORM FAIL[^\n]*/.exec(out)?.[0] ?? (r.timedOut ? "no result before the timeout — deadlock?" : `exit ${r.status}`)));
  gate(!!leaked && leaked[1] === "0", `[${tag}] a later dedicated task does not inherit a leaked stream redirection`,
    leaked ? `${leaked[1]} bytes reached the leaked buffer` : "no result");
  return { ok, created, stdout: r.stdout };
};
// The default run also carries probes/thread-knobs.lean with every knob unset (0038, G5/G6): the
// threads of its bursts stay, as before 0038.
judgeKnobs((await stormRun(RTSTATS, "default: no parking", `\n${readProbe("thread-knobs.lean")}`)).stdout, false, "knobs off");
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
const deepMetaRun = await runLean(readProbe("deep-recursion.lean") + GUARD, "deep", { ...CHROME, LEAN4_WASM64_PTHREAD_POOL: "abc", ...RTSTATS });
poolTargets.push(["abc", 24, askedStats(deepMetaRun.stdout, "GUARD")]);
const deepMeta = stripDebug(deepMetaRun.stdout);
gate(/maximum recursion depth has been reached/.test(deepMeta) && /DEEP SURVIVED/.test(deepMeta) && !overflowed(deepMeta),
  "deep recursion at Chrome's stack (Meta): Lean's max-recursion error, the thread survives",
  overflowed(deepMeta) ? "the engine's stack overflowed (RangeError)" : /DEEP SURVIVED/.test(deepMeta) ? "" : "no result");
const deepKernelRun = await runLean(readProbe("deep-recursion-kernel.lean") + GUARD, "deep-kernel", { ...CHROME, ...RTSTATS });
const deepKernel = stripDebug(deepKernelRun.stdout);
gate(/engine's stack is exhausted/.test(deepKernel) && /DEEP SURVIVED/.test(deepKernel) && !overflowed(deepKernel),
  "deep recursion at Chrome's stack (kernel): the kernel's error, the thread survives",
  overflowed(deepKernel) ? "the engine's stack overflowed (RangeError)" : /DEEP SURVIVED/.test(deepKernel) ? "" : "no result");
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
