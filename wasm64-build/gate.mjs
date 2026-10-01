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
// Usage: node wasm64-build/gate.mjs --artifact <dir>

import { execFileSync } from "node:child_process";
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
const artifact = path.resolve(arg("artifact", ""));
if (!fs.existsSync(path.join(artifact, "bin/lean.js"))) {
  console.error(`gate: ${artifact}/bin/lean.js not found`);
  process.exit(2);
}
const runner = path.join(root, "node-runner.mjs");

function runLean(source, label, env = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-gate-"));
  fs.writeFileSync(path.join(work, "input.lean"), source);
  try {
    const stdout = execFileSync("node", [runner, "--artifact", artifact, "--work", work, "--", "/work/input.lean"],
      { timeout: 240_000, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } });
    return { stdout, status: 0, timedOut: false };
  } catch (error) {
    // Since the keepalive guard (patch 0020) and the resident transport
    // (0031), the one-shot CLI prints its output and then never exits — the
    // Emscripten runtime is kept alive for library-style use, which is what
    // the product relies on (snapshot loads and warm compiles before `main`).
    // Measured 2026-09-07 on the served 0032 runtime and on 0033 alike:
    // `#eval` prints 64, `rfl` elaborates, the process is killed by the
    // timeout. The CLI checks below are therefore judged by OUTPUT; a timeout
    // is reported, not failed. The exit path is not a product path.
    const timedOut = error.killed === true || error.signal === "SIGTERM";
    return { stdout: `${error.stdout ?? ""}\n${error.stderr ?? ""}`, status: error.status ?? (timedOut ? 124 : 1), timedOut };
  }
}
let failures = 0;
const gate = (ok, label, extra = "") => {
  console.log(`${ok ? " ok " : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures += 1;
};

const smoke = runLean("#eval System.Platform.numBits\nexample : (2 + 2 : Nat) = 4 := by rfl\n");
gate(/^64$/m.test(smoke.stdout) && !/error/i.test(smoke.stdout.replace(/\[DEBUG:PROGRESS\][^\n]*\n/g, "")),
  "numBits=64 + rfl proof (judged by output)", smoke.timedOut ? "CLI kept alive after main, killed by the timeout (patch 0020; expected)" : `exit ${smoke.status}`);

const bad = runLean("example : (1 + 1 : Nat) = 3 := by rfl\n");
gate(/input\.lean:1:\d+: error|"severity":\s*"error"/.test(bad.stdout), "false proof reports a positioned error (judged by output)", bad.timedOut ? "CLI kept alive, killed by the timeout (expected)" : `exit ${bad.status}`);

// The parse defect lives in the PERSISTENT path (lean_wasm_compile); the
// one-shot CLI has always reported parse errors. Drive the persistent probe
// and require its garbage compile to surface diagnostics.
let probeOut = "";
let probeStatus = 0;
try {
  probeOut = execFileSync("node",
    [path.join(root, "persistent-probe.mjs"), "--artifact", artifact],
    { timeout: 600_000, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (error) {
  probeOut = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
  probeStatus = error.status ?? 1;
}
gate(probeStatus === 0 && probeOut.includes("PERSISTENT PROBE PASS"), "persistent path: init, resident reuse, error reporting, survival");
const parseFixed = probeOut.includes("runtime defect is FIXED");

// MODULE-SEMANTICS GATES (qed64 HARDENING #51): the environment's own facts for a
// user file, not its messages. On Emscripten every import happens at
// `OLeanLevel.exported`; if the file's header flag is not threaded through,
// `importModules` derives `isModule` from the level and a legacy file elaborates
// as a module (private-by-default defs, `@[server_rpc_method]` rejected). The
// three legacy probes run as ONE file (they all `import Lean`); the `module`
// file runs alone. Probe sources: wasm64-build/probes/*.lean (from qed64
// tests/adversarial/kernel-probes).
const probes = path.join(root, "probes");
const readProbe = (name) => fs.readFileSync(path.join(probes, name), "utf8");
const stripDebug = (s) => s.replace(/\[(DEBUG:PROGRESS|WASM (DEBUG|LSP|PROFILE|INIT))\][^\n]*\n/g, "");
const legacySrc = "import Lean\n" + ["is-module.lean", "private-default.lean", "rpc-attr.lean"]
  .map((f) => readProbe(f).replace(/^import Lean\n/m, "")).join("\n");
const legacy = runLean(legacySrc);
const legacyOut = stripDebug(legacy.stdout);
gate(/isModule=false/.test(legacyOut) && !/isModule=true/.test(legacyOut), "legacy file: env.header.isModule = false",
  legacy.timedOut ? "CLI kept alive (expected)" : `exit ${legacy.status}`);
gate(/plainDef/.test(legacyOut) && !/_private/.test(legacyOut), "legacy file: plain `def` is not private by default");
gate(!/error/i.test(legacyOut), "legacy file: @[server_rpc_method] / attribute [tactic] / @[app_unexpander] on plain defs accepted",
  /error/i.test(legacyOut) ? legacyOut.split("\n").find((l) => /error/i.test(l))?.slice(0, 160) : "");
const moduleFile = runLean(readProbe("module-file.lean"));
const moduleOut = stripDebug(moduleFile.stdout);
gate(/isModule=true/.test(moduleOut) && !/error/i.test(moduleOut), "`module` file: env.header.isModule = true",
  moduleFile.timedOut ? "CLI kept alive (expected)" : `exit ${moduleFile.status}`);

// TASK-MANAGER STORM (patch 0035). Every shape of task traffic the language
// server produces, at volume (wasm64-build/probes/task-storm.lean): a forAsync
// chain of dedicated continuations, a fan-out released by one promise, a ladder
// of dedicated tasks that each block on the next (more live at once than the
// parked-thread cap; deadlocks if a dedicated task ever waits behind another),
// pool tasks blocked on dedicated ones, waitAny. Under Emscripten every
// pthread_create is a synchronous round trip to the main JS thread; the patch
// hands dedicated tasks to parked threads, so the storm must also show reuse.
const storm = runLean(readProbe("task-storm.lean"), "storm", { QED64_COUNT_PTHREADS: "1" });
const stormOut = stripDebug(storm.stdout);
const stormOk = /STORM OK dedicated=(\d+) checksum=(\d+)/.exec(stormOut);
gate(!!stormOk, "task-manager storm completes (chain, fan-out, ladder beyond the park cap, pool waits, waitAny)",
  stormOk ? `${stormOk[1]} dedicated tasks, checksum ${stormOk[2]}`
          : (/STORM FAIL[^\n]*/.exec(stormOut)?.[0] ?? (storm.timedOut ? "no result before the timeout — deadlock?" : `exit ${storm.status}`)));
const created = /\[pthreads\] created=(\d+)/.exec(stormOut);
gate(!!stormOk && !!created && Number(created[1]) * 4 <= Number(stormOk[1]),
  "task-manager storm: dedicated tasks reuse parked threads (at most 1 pthread created per 4 dedicated tasks)",
  created ? `${created[1]} pthreads created for ${stormOk ? stormOk[1] : "?"} dedicated tasks` : "pthread count unavailable");
// A reused thread must look fresh: a stderr redirection one dedicated task leaves
// installed must not capture a later task's output (native Lean: a fresh thread).
const leaked = /LEAKED-STDERR bytes=(\d+)/.exec(stormOut);
gate(!!leaked && leaked[1] === "0", "thread reuse: a later dedicated task does not inherit a leaked stream redirection",
  leaked ? `${leaked[1]} bytes reached the leaked buffer` : "no result");
gate(parseFixed, "THE PARSE GATE: lean_wasm_compile reports parser diagnostics",
  parseFixed ? "" : "persistent shell still swallows parse errors");

console.log(failures === 0 ? "\nGATE PASSED" : `\nGATE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
