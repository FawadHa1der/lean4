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
// Every check prints ok or FAIL; exits nonzero if any failed.
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
const PINNED = { LEAN4_WASM64_CWD: "", LEAN4_WASM64_PTHREAD_STACK_MB: "", LEAN_WASM_STACK_PROBE_SLOTS: "", LEAN_WASM_PARKED_DEDICATED: "" };
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
      if (code === 0) resolve({ stdout, status: 0, timedOut });
      else resolve({ stdout: `${stdout}\n${stderr}`, status: code ?? (timedOut ? 124 : 1), timedOut });
    });
  });
}

async function runLean(source, label, env = {}) {
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
    return await runChild([STACK, runner, "--artifact", artifact, "--work", work, "--", "/work/input.lean"], 240_000, env);
  } finally {
    rmTemp(work);
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
// the runner's layout (lean4-wasm64 -r2): Lean runs at the VFS root, so /work/input.lean is
// module work.input — the layout under which a bake is byte-identical to QED64's runner
gate(/main=work\.input\b/.test(legacyOut), "the one-shot CLI runs at VFS cwd / (main module work.input; bakes byte-identical to QED64's runner)",
  (/main=\S+/.exec(legacyOut) ?? ["no main= line"])[0]);
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
// DEEP RECURSION AT A BROWSER'S STACK (patch 0036, qed64 HARDENING #60). Wasm frames run on the
// engine's stack — a Chrome Worker gets 500 KiB, Node's pthreads 4 MiB — which Lean's own guards
// never measured: running out threw a RangeError that killed the thread. The node-runner knob
// LEAN4_WASM64_PTHREAD_STACK_MB=0.68 gives the pthreads Chrome's budget (Node keeps ~192 KiB of it).
const CHROME = { LEAN4_WASM64_PTHREAD_STACK_MB: "0.68" };
const overflowed = (out) => /Maximum call stack size exceeded|too much recursion/.test(out);
const deepMeta = stripDebug((await runLean(readProbe("deep-recursion.lean"), "deep", CHROME)).stdout);
gate(/maximum recursion depth has been reached/.test(deepMeta) && /DEEP SURVIVED/.test(deepMeta) && !overflowed(deepMeta),
  "deep recursion at Chrome's stack (Meta): Lean's max-recursion error, the thread survives",
  overflowed(deepMeta) ? "the engine's stack overflowed (RangeError)" : /DEEP SURVIVED/.test(deepMeta) ? "" : "no result");
const deepKernel = stripDebug((await runLean(readProbe("deep-recursion-kernel.lean"), "deep-kernel", CHROME)).stdout);
gate(/engine's stack is exhausted/.test(deepKernel) && /DEEP SURVIVED/.test(deepKernel) && !overflowed(deepKernel),
  "deep recursion at Chrome's stack (kernel): the kernel's error, the thread survives",
  overflowed(deepKernel) ? "the engine's stack overflowed (RangeError)" : /DEEP SURVIVED/.test(deepKernel) ? "" : "no result");
const deepRoomy = stripDebug((await runLean(readProbe("deep-recursion.lean"), "deep-roomy")).stdout);
gate(/DEEP SURVIVED/.test(deepRoomy) && !/error/i.test(deepRoomy),
  "the same Meta proof at the default stack still checks (the probe does not cost valid proofs)",
  /error/i.test(deepRoomy) ? deepRoomy.split("\n").find((l) => /error/i.test(l))?.slice(0, 160) : "");
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
    "--cases", files.join(","), "--passes", "2"], 900_000);
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

console.log(failures === 0 ? "\nGATE PASSED" : `\nGATE FAILED (${failures})`);
// exitCode, not process.exit(): see fetch-release.mjs (shutdown deadlock after heavy JIT work)
process.exitCode = failures === 0 ? 0 : 1;
