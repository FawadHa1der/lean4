#!/usr/bin/env node
// How much engine stack the deep-recursion proofs need on a given runtime (review B2 of patch
// 0039): r3 vs 0039 vs 0039b, whose link changes what native code is inlined and what the
// interpreter runs, which can move every margin 0036's guard was calibrated against. Not a gate:
// a measurement to record in PATCHES.md.
//
// For each probe it bisects LEAN4_WASM64_PTHREAD_STACK_MB (node-runner gives the runtime's pthread
// Workers that much V8 stack; 0.68 is a Chrome Worker's 500 KiB) for two thresholds:
//   survives — the smallest stack at which the run ends with Lean's own error or a proof (no
//              RangeError, no dead thread): the guard's floor;
//   passes   — the smallest stack at which the proof checks, error-free.
// Probes (Init only): fin   `decide` over Fin 40 × Fin 40 (Meta; the gate's deep-recursion.lean)
//                     have  N nested `have … := by` blocks (QED64 HARDENING #72; --have-depth, 25)
//                     chain a `<;>` chain of N `trivial`s (HARDENING #72; --chain-length, 25)
//                     kernel `decide +kernel` over Fin 120 × Fin 120 (the kernel's depth guard)
// One run at a time, each a one-shot CLI (never exits by itself: stopped by its recorded pid once it
// printed its last line, or at --timeout-ms). Heavy: run it through the host lock, e.g.
//   LOCK_WAIT_S=7200 ".../qed64-showcase/scripts/with-browser-lock.sh" stack-margin \
//     node wasm64-build/stack-margin.mjs --artifact <build>/build/stage1 --json margins-0039.json
// It refuses to start outside the lock (HOST_BROWSER_LOCK_FILE unset) unless --no-lock-check.
//
// Usage: node stack-margin.mjs --artifact <dir> [--probes fin,have,chain,kernel] [--lo 0.25] [--hi 4]
//          [--step 0.02] [--timeout-ms 180000] [--have-depth 25] [--chain-length 25] [--json <file>]
//          [--no-lock-check]
// Exit 0 when every probe was measured, 1 when one could not be (it does not pass at --hi), 2 usage.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = "usage: stack-margin.mjs --artifact <dir> [--probes fin,have,chain,kernel] [--lo 0.25] [--hi 4] [--step 0.02] [--timeout-ms 180000] [--have-depth 25] [--chain-length 25] [--json <file>] [--no-lock-check]";
const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt; };
if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); process.exit(0); }
const artifact = flag("artifact", null);
const num = (name, dflt) => { const v = Number(flag(name, dflt)); if (!Number.isFinite(v) || v <= 0) { console.error(`stack-margin: --${name} must be a positive number\n${USAGE}`); process.exit(2); } return v; };
const lo = num("lo", 0.25), hi = num("hi", 4), step = num("step", 0.02), timeoutMs = num("timeout-ms", 180000);
const haveDepth = Math.round(num("have-depth", 25)), chainLength = Math.round(num("chain-length", 25));
if (!artifact || !fs.existsSync(path.join(artifact, "bin", "lean.js")) || lo >= hi) { console.error(USAGE); process.exit(2); }
if (!process.env.HOST_BROWSER_LOCK_FILE && !argv.includes("--no-lock-check")) {
  console.error("stack-margin: run it through the host lock (with-browser-lock.sh <lane> node …), or pass --no-lock-check");
  process.exit(2);
}

const nested = (depth) => {
  const lines = ["example : True := by"];
  for (let d = 1; d <= depth; d++) lines.push(`${"  ".repeat(d)}have h${d} : True := by`);
  for (let d = depth; d >= 0; d--) lines.push(`${"  ".repeat(d + 1)}trivial`);
  return lines.join("\n");
};
const PROBES = {
  fin: "theorem marginFin : ∀ n : Fin 40, ∀ m : Fin 40, n * m = m * n := by decide",
  have: nested(haveDepth),
  chain: `example : True := by ${Array(chainLength).fill("trivial").join(" <;> ")}`,
  kernel: "theorem marginKernel : ∀ n : Fin 120, ∀ m : Fin 120, n * m = m * n := by decide +kernel",
};
const chosen = flag("probes", Object.keys(PROBES).join(",")).split(",").filter(Boolean);
const unknown = chosen.filter((p) => !(p in PROBES));
if (unknown.length) { console.error(`stack-margin: unknown probe ${unknown.join(", ")} (${Object.keys(PROBES).join(", ")})`); process.exit(2); }

const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "js", "node-runner.mjs");
const DONE = "MARGIN DONE";
// every runtime knob at its default (the runs judge the runtime, not the caller's shell)
const PINNED = { LEAN4_WASM64_CWD: "", LEAN4_WASM64_PTHREAD_POOL: "", LEAN4_WASM64_RTSTATS: "", LEAN_WASM_STACK_PROBE_SLOTS: "",
  LEAN_WASM_PARKED_DEDICATED: "", LEAN_WASM_PARKED_IDLE_MS: "", LEAN_WASM_STD_SURPLUS_EXIT: "", LEAN_WASM_SYMTAB_TRACE: "", QED64_COUNT_PTHREADS: "" };
let current = null;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { if (current) process.kill(current, "SIGKILL"); process.exit(128 + os.constants.signals[sig]); });

/** One run at `mb` MiB: "ok" (the proof checks), "guard" (Lean's own error, the thread alive) or "overflow" (a RangeError, a dead thread, an abort, no end). */
function trial(source, mb) {
  return new Promise((resolve) => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "stack-margin-"));
    fs.writeFileSync(path.join(work, "input.lean"), `${source}\n#eval IO.println "${DONE}"\n`);
    const t0 = Date.now();
    const child = spawn(process.execPath, ["--stack-size=8192", runner, "--artifact", artifact, "--work", work, "--", "/work/input.lean"],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...PINNED, LEAN4_WASM64_PTHREAD_STACK_MB: String(mb) } });
    current = child.pid;
    let out = "", settled = false;
    const finish = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ }
      current = null;
      fs.rmSync(work, { recursive: true, force: true });
      const overflow = /Maximum call stack size exceeded|too much recursion|RangeError|ABORT:/.test(out);
      const done = out.includes(DONE);
      const error = /input\.lean:\d+:\d+: error|"severity":\s*"error"/.test(out);
      const outcome = overflow || !done ? "overflow" : error ? "guard" : "ok";
      const detail = overflow ? (/Maximum call stack size exceeded|too much recursion|RangeError|ABORT:[^\n]*/.exec(out)?.[0] ?? "")
        : !done ? why : error ? (/(?:maximum recursion depth|stack is exhausted)[^\n]*/.exec(out)?.[0] ?? "an error") : "";
      resolve({ mb, outcome, ms: Date.now() - t0, detail: detail.slice(0, 100) });
    };
    const timer = setTimeout(() => finish(`no ${DONE} in ${timeoutMs} ms`), timeoutMs);
    // the last line, or a dead thread (nothing follows a RangeError but the timeout): stop soon after
    const onData = (d) => {
      out += d;
      if (out.includes(DONE)) setTimeout(() => finish("done"), 500);
      else if (/Maximum call stack size exceeded|too much recursion|RangeError/.test(out)) setTimeout(() => finish("overflow"), 3000);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", () => finish("the runtime exited"));
  });
}

const RANK = { overflow: 0, guard: 1, ok: 2 };
const round = (x) => Math.round(x * 1000) / 1000;
const results = {};
let unmeasured = 0;
for (const name of chosen) {
  const seen = new Map();
  const at = async (mb) => {
    mb = round(mb);
    if (!seen.has(mb)) {
      const r = await trial(PROBES[name], mb);
      seen.set(mb, r);
      console.log(`  ${name.padEnd(6)} ${String(mb).padStart(6)} MiB  ${r.outcome.padEnd(8)} ${String(r.ms).padStart(7)} ms  ${r.detail}`);
    }
    return seen.get(mb);
  };
  /** The smallest stack in [lo, hi] whose outcome ranks at least `want` (outcomes only improve with the stack), within `step`. */
  const threshold = async (want) => {
    if (RANK[(await at(lo)).outcome] >= want) return { mb: lo, bound: "at most" };
    if (RANK[(await at(hi)).outcome] < want) return { mb: hi, bound: "more than" };
    let a = lo, b = hi;              // a fails, b holds
    while (b - a > step) {
      const mid = round((a + b) / 2);
      if (RANK[(await at(mid)).outcome] >= want) b = mid; else a = mid;
    }
    return { mb: b, bound: "" };
  };
  console.log(`== ${name}`);
  const survives = await threshold(RANK.guard);
  const passes = await threshold(RANK.ok);
  if (passes.bound === "more than") unmeasured++;
  results[name] = { survives, passes, trials: [...seen.values()].sort((x, y) => x.mb - y.mb) };
  const show = (t) => `${t.bound ? `${t.bound} ` : ""}${t.mb} MiB`;
  console.log(`   ${name}: survives from ${show(survives)}, passes from ${show(passes)} (±${step} MiB)`);
}

console.log("\nsummary (smallest LEAN4_WASM64_PTHREAD_STACK_MB; a Chrome Worker is 0.68):");
for (const [name, r] of Object.entries(results)) {
  console.log(`  ${name.padEnd(6)} survives ${`${r.survives.bound ? `${r.survives.bound} ` : ""}${r.survives.mb}`.padStart(16)}   passes ${`${r.passes.bound ? `${r.passes.bound} ` : ""}${r.passes.mb}`.padStart(16)}`);
}
const json = flag("json", null);
if (json) {
  fs.writeFileSync(json, JSON.stringify({ artifact: path.resolve(artifact), lo, hi, step, haveDepth, chainLength, results }, null, 1) + "\n");
  console.log(`wrote ${json}`);
}
process.exitCode = unmeasured ? 1 : 0;
