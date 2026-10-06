#!/usr/bin/env node
// Release gate for a freshly built wasm64 runtime artifact.
//
// Runs, in order, against --artifact <stage1 dir>:
//  1. numBits smoke      — #eval System.Platform.numBits must print 64
//  2. proof smoke        — a kernel-checked rfl example, exit 0
//  3. error smoke        — a false proof must produce a positioned error
//  4. THE PARSE GATE     — garbage input must produce >=1 error diagnostic
//                          (the defect motivating the rebuild)
// Exits nonzero on the first failing gate.
//
// Usage: node gate.mjs --artifact <dir>   (lean4-wasm64 gate --artifact <dir>)

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The runner harnesses live alongside this gate (self-contained build dir).
const root = path.dirname(fileURLToPath(import.meta.url));
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("usage: gate.mjs --artifact <dir>\nThe release gate: every check must print ok. run as: lean4-wasm64 gate   (or: node --stack-size=8192 gate.mjs)\nexit codes: 0 GATE PASSED, 1 a check failed, 2 usage");
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
const runner = path.join(root, "node-runner.mjs");
// The children boot the runtime: run them on this Node (PATH's `node` may be
// another version, or absent in a container) with the deep JS stack the
// runtime needs (HOSTING.md); --stack-size on the gate itself reaches no child.
const STACK = "--stack-size=8192";

// One child at a time, asynchronously: a gate killed by a signal kills the runtime
// it is waiting on (a blocking execFileSync could not, and the never-exiting
// runtime would outlive it).
let current = null;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    if (current) current.kill("SIGKILL");
    process.exit(128 + os.constants.signals[sig]);
  });
}
function runChild(args, timeoutMs, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
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
      if (code === 0) resolve({ stdout, status: 0, timedOut });
      else resolve({ stdout: `${stdout}\n${stderr}`, status: code ?? (timedOut ? 124 : 1), timedOut });
    });
  });
}

async function runLean(source, label, env = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "lean4-wasm64-gate-"));
  fs.writeFileSync(path.join(work, "input.lean"), source);
  // Since the keepalive guard (patch 0020) and the resident transport (0031),
  // the one-shot CLI prints its output and then never exits — the Emscripten
  // runtime is kept alive for library-style use, which is what the product
  // relies on (snapshot loads and warm compiles before `main`). Measured
  // 2026-09-07 on the served 0032 runtime and on 0033 alike: `#eval` prints 64,
  // `rfl` elaborates, the process is killed by the timeout. The CLI checks below
  // are therefore judged by OUTPUT; a timeout is reported, not failed.
  try {
    return await runChild([STACK, runner, "--artifact", artifact, "--work", work, "--", "/work/input.lean"], 240_000, env);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
let failures = 0;
const gate = (ok, label, extra = "") => {
  console.log(`${ok ? " ok " : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures += 1;
};

const smoke = await runLean("#eval System.Platform.numBits\nexample : (2 + 2 : Nat) = 4 := by rfl\n");
gate(/^64$/m.test(smoke.stdout) && !/error/i.test(smoke.stdout.replace(/\[DEBUG:PROGRESS\][^\n]*\n/g, "")),
  "numBits=64 + rfl proof (judged by output)", smoke.timedOut ? "CLI kept alive after main, killed by the timeout (patch 0020; expected)" : `exit ${smoke.status}`);

const bad = await runLean("example : (1 + 1 : Nat) = 3 := by rfl\n");
gate(/input\.lean:1:\d+: error|"severity":\s*"error"/.test(bad.stdout), "false proof reports a positioned error (judged by output)", bad.timedOut ? "CLI kept alive, killed by the timeout (expected)" : `exit ${bad.status}`);

// The parse defect lives in the PERSISTENT path (lean_wasm_compile); the
// one-shot CLI has always reported parse errors. Drive the persistent probe
// and require its garbage compile to surface diagnostics.
const probe = await runChild([STACK, path.join(root, "persistent-probe.mjs"), "--artifact", artifact], 600_000);
const probeOut = probe.stdout;
const probeStatus = probe.status;
gate(probeStatus === 0 && probeOut.includes("PERSISTENT PROBE PASS"), "persistent path: init, resident reuse, error reporting, survival");
const parseFixed = probeOut.includes("runtime defect is FIXED");

// MODULE-SEMANTICS GATES (qed64 HARDENING #51): the environment's own facts for a
// user file, not its messages. On Emscripten every import happens at
// `OLeanLevel.exported`; if the file's header flag is not threaded through,
// `importModules` derives `isModule` from the level and a legacy file elaborates
// as a module (private-by-default defs, `@[server_rpc_method]` rejected). The
// three legacy probes run as ONE file (they all `import Lean`); the `module`
// file runs alone. Probe sources: probes/*.lean next to this file (from qed64
// tests/adversarial/kernel-probes).
const probes = path.join(root, "probes");
const readProbe = (name) => fs.readFileSync(path.join(probes, name), "utf8");
const stripDebug = (s) => s.replace(/\[(DEBUG:PROGRESS|WASM (DEBUG|LSP|PROFILE|INIT))\][^\n]*\n/g, "");
const legacySrc = "import Lean\n" + ["is-module.lean", "private-default.lean", "rpc-attr.lean"]
  .map((f) => readProbe(f).replace(/^import Lean\n/m, "")).join("\n");
const legacy = await runLean(legacySrc);
const legacyOut = stripDebug(legacy.stdout);
gate(/isModule=false/.test(legacyOut) && !/isModule=true/.test(legacyOut), "legacy file: env.header.isModule = false",
  legacy.timedOut ? "CLI kept alive (expected)" : `exit ${legacy.status}`);
gate(/plainDef/.test(legacyOut) && !/_private/.test(legacyOut), "legacy file: plain `def` is not private by default");
gate(!/error/i.test(legacyOut), "legacy file: @[server_rpc_method] / attribute [tactic] / @[app_unexpander] on plain defs accepted",
  /error/i.test(legacyOut) ? legacyOut.split("\n").find((l) => /error/i.test(l))?.slice(0, 160) : "");
const moduleFile = await runLean(readProbe("module-file.lean"));
const moduleOut = stripDebug(moduleFile.stdout);
gate(/isModule=true/.test(moduleOut) && !/error/i.test(moduleOut), "`module` file: env.header.isModule = true",
  moduleFile.timedOut ? "CLI kept alive (expected)" : `exit ${moduleFile.status}`);

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
gate(parseFixed, "THE PARSE GATE: lean_wasm_compile reports parser diagnostics",
  parseFixed ? "" : "persistent shell still swallows parse errors");

console.log(failures === 0 ? "\nGATE PASSED" : `\nGATE FAILED (${failures})`);
// exitCode, not process.exit(): see fetch-release.mjs (shutdown deadlock after heavy JIT work)
process.exitCode = failures === 0 ? 0 : 1;
