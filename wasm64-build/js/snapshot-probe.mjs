#!/usr/bin/env node
// Ported from QED64 (MIT, same author) pipeline/snapshot/snapshot-probe.mjs at 76d5447 (fix/pinned-indexes; unchanged since 30d5d76); relicensed Apache-2.0 by the author.
//
// Validate a baked snapshot end to end with the exact shipped runtime: load
// it via lean_wasm_load_snapshot (the same export the worker calls), then
// compile a probe whose header imports match the snapshot's — which must be
// FAST (env-cache hit) and error-free. Guards against a snapshot that bakes
// fine but loads into the wrong cache key, which would silently degrade the
// app to the minutes-long import path.
//
// Usage: node snapshot-probe.mjs --snap <file>.snap --lib <olean tree> \
//          --probe-file <lean file with the matching imports> \
//          [--artifact <dir>] [--budget-ms 90000]       (or: lean4-wasm64 snapshot-probe …)
// --lib is required: the tree the snapshot was baked from. --artifact, else
// $LEAN4_WASM64_ARTIFACT, else $QED64_LEAN_ARTIFACT, else exit 2: this file
// ships in the lean4-wasm64 package and knows no repo, so nothing has a
// repo-relative default. Started without --stack-size, it re-execs itself
// with --stack-size=8192 (same PID). Unless --watchdog-ms 0, a worker thread
// ends the probe past a wall-clock deadline (the watchdog below): kernel
// patch 0037 makes a task that never finishes hang lean_wasm_compile, which
// blocks the main thread.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { applyCliContract, ensureStackSize } from "./cli-args.mjs";
import { forwardWasmEnv, poolModuleKeys } from "./runtime-knobs.mjs";

// First, before the contract prints anything: replaces this process (same PID) when
// started without --stack-size, so every line below is printed once.
ensureStackSize("snapshot-probe");

// The shared flag contract (cli-args.mjs) as QED64's snapshot-probe applied it (its
// SPECS["snapshot-probe"], passthrough null), with the same 13 flags: --help/-h anywhere, a
// value position included, prints the help and exits 0 before any side effect; a missing
// required flag prints the usage line and exits 2; --flag=value works; an unknown flag or a
// stray argument is a `snapshot-probe: WARNING — …` line; a repeated flag keeps its first value
// and an empty one is ignored (a WARNING each). One change: --lib is required (QED64 fell back
// to $QED64_LIB_TREE, then its checkout's work/lib-tree). Values come from the contract's
// result, not an indexOf over argv, so a value spelled like a flag (`--probe --via-mem`) is a
// value and never that flag (persistent-probe.mjs does the same).
const USAGE = "snapshot-probe.mjs (--snap <file> | --fresh-import) --lib <tree> (--probe-file <file> | --probe <source>)";
const cli = applyCliContract({
  tool: "snapshot-probe",
  usage: USAGE,
  flags: {
    snap: 1, "fresh-import": 0, "probe-file": 1, probe: 1, lib: 1, artifact: 1, "budget-ms": 1,
    "via-mem": 0, "via-memfs": 0, "init-flags": 1, workspace: 1, "dump-messages": 0, "watchdog-ms": 1,
  },
  required: [["snap", "fresh-import"], ["probe-file", "probe"], ["lib"]],
  passthrough: null,
  passthroughRequired: false,
  help: [
    `usage: ${USAGE}`,
    "Load a baked snapshot through the worker's exact export (lean_wasm_load_snapshot, or _mem with --via-mem), then compile a probe whose header matches it: it must be error-free and within the budget (an env-cache hit).",
    "run as: lean4-wasm64 snapshot-probe   (or: node snapshot-probe.mjs — started without --stack-size it re-execs itself with --stack-size=8192, same PID)",
    "",
    "flags:",
    "  --snap <file>        raw .snap to load (hard-linked into a scratch dir under the OS tmpdir) [one of --snap, --fresh-import is required]",
    "  --fresh-import       no snapshot: import the probe's header from --lib (the slim-bake differential audit) [one of --snap, --fresh-import is required]",
    "  --probe-file <file>  the Lean file to compile after the load [one of --probe-file, --probe is required]",
    "  --probe <source>     the probe text inline (read only when --probe-file is absent) [one of --probe-file, --probe is required]",
    "  --lib <tree>         olean tree mounted at /lib/lean: the tree the probed snapshot was baked from [required; no default]",
    "  --artifact <dir>     dir holding bin/lean.js + bin/lean.wasm (default: $LEAN4_WASM64_ARTIFACT, else $QED64_LEAN_ARTIFACT; nothing else: exit 2)",
    "  --budget-ms <ms>     compile budget; slower means the load seeded the wrong env-cache key (default: 90000)",
    "  --via-mem            stream the snapshot into a wasm-malloc'd buffer (lean_wasm_load_snapshot_mem, the browser's path)",
    "  --via-memfs          copy the snapshot into MEMFS in 64 MiB chunks before loading",
    "  --init-flags <n>     replay-control flags passed with --via-mem (patch 0016) (default: 1)",
    "  --workspace <dir>    host dir mounted at /workspace, the compile's cwd (game probes need .lake/gamedata)",
    "  --dump-messages      echo every line Lean prints on stdout as `[lean:stdout] <line>`",
    "  --watchdog-ms <ms>   wall-clock limit of the run, kept by a worker thread: past it one watchdog FAIL line and the probe SIGKILLs itself (a hung lean_wasm_compile, kernel 0037 on); 0 for no watchdog (default: --budget-ms + 120000)",
    "  -h, --help           print this help and exit 0, before any side effect",
    "",
    "environment:",
    "  LEAN4_WASM64_ARTIFACT  the artifact dir used when --artifact is absent (empty = unset)",
    "  QED64_LEAN_ARTIFACT    the older name of the same, read when LEAN4_WASM64_ARTIFACT is unset (empty = unset)",
    "  QED64_PROFILE_INIT     when set, forwarded into the wasm environment to profile the [init] replay",
    "  LEAN4_WASM64_PTHREAD_STACK_MB=<n>  test knob: the runtime's pthread Workers get an n-MiB stack (0.68 ~ a Chrome Worker's",
    "                         500 KiB: elaboration tasks then run on a browser's stack budget), as under node-runner",
    "  LEAN_WASM_STACK_PROBE_SLOTS=<n>    calibration knob, forwarded: patch 0036's engine-stack probe headroom in 8-byte slots (0: off)",
    "  LEAN4_WASM64_PTHREAD_POOL=<n>      Module.pthreadPoolSize: the pthread Workers created at load (0..64, default 24; kernel 0038)",
    "  LEAN_WASM_PARKED_DEDICATED, LEAN_WASM_PARKED_IDLE_MS, LEAN_WASM_STD_SURPLUS_EXIT  forwarded too (EMBED-RUNTIME.md §3.1)",
    "",
    "exit codes:",
    "  0  SNAPSHOT PROBE PASS",
    "  1  SNAPSHOT PROBE FAIL (load failed, the probe has errors or blew the budget), or a crash before the runtime started (an unreadable --probe-file, a --snap that cannot be hard-linked, a missing lean.js)",
    "  2  usage, before any side effect: no snapshot source, no probe or no --lib; a --watchdog-ms that is not a whole number; no --artifact with both variables unset; a --lib tree that does not exist",
    "  3  the wasm runtime aborted (legacy overload of class 3)",
    "  killed by SIGKILL: the watchdog fired, after its one line (or the caller killed the probe)",
    "",
    "Ported from QED64's snapshot-probe (contract version 3): the flags, the exit codes and the PASS, FAIL, load:, compile:, [lean:stdout], abort and watchdog lines are unchanged.",
  ].join("\n"),
});
const opt = cli.values;

const snapHost = opt.snap ? path.resolve(opt.snap) : "";
const probeFile = opt["probe-file"] ?? "";
const probeSource = probeFile ? fs.readFileSync(path.resolve(probeFile), "utf8") : opt.probe ?? "";
const budgetMs = Number(opt["budget-ms"] ?? "90000");
// Optional host dir NODEFS-mounted at /workspace (the worker cwd) — game
// probes need `.lake/gamedata/*.json` visible to GameServer's Runner.
const workspaceDir = opt.workspace ? path.resolve(opt.workspace) : "";
// --via-memfs copies the snapshot into MEMFS in bounded chunks before loading —
// the worker's exact path — instead of reading it through a NODEFS mount (a
// single read() of a >2 GiB file trips Node's per-call I/O limits).
const viaMemfs = opt["via-memfs"] === true;
// --via-mem streams the snapshot into a wasm-malloc'd buffer and loads through
// lean_wasm_load_snapshot_mem — the browser worker's direct path.
const viaMem = opt["via-mem"] === true;
// --fresh-import: no snapshot at all — the probe's header is imported from
// the mounted --lib tree by lean_wasm_compile (getOrCreateWasmEnvFor), which
// is what a native import with every facet present would produce. Its only
// use is the differential half of the slim-bake audit: the SAME probe file
// through a slim snapshot and through a fresh import of the fat tree must
// print byte-identical messages. The compile budget is the import's, so pass
// a large --budget-ms.
const freshImport = opt["fresh-import"] === true;
// An empty --probe-file is no probe (it does not fall back to --probe), as in QED64.
if ((!snapHost && !freshImport) || !probeSource) {
  console.error(`usage: ${USAGE}`);
  process.exit(2);
}

// The watchdog. From kernel patch 0037 on, lean_wasm_compile returns only after every task a
// command recorded has finished, so a task that never finishes (a timed sleep inside an async
// proof) hangs the call, and the call blocks the main thread: no timer on it can fire. A worker
// thread has its own event loop, so it keeps the deadline: past --watchdog-ms it removes the
// scratch dir, prints one FAIL line and SIGKILLs this process. Same process, so the PID, the
// stdio, the exit status of a run that reaches a verdict and every per-PID measure (rusage,
// /usr/bin/time -l's peak memory footprint) are the probe's own, and a caller's signal reaches
// the probe directly. The verdict and the watchdog claim one shared cell (0 running, 1 verdict,
// 2 watchdog), so a run prints one or the other. --watchdog-ms 0 starts no worker, as before
// the watchdog. (QED64's first design supervised the probe from a parent process; that hid the
// probe's own footprint from /usr/bin/time -l, so there is none.)
const watchdogArg = opt["watchdog-ms"] ?? null;
const watchdogMs = watchdogArg === null ? Math.ceil(Number.isFinite(budgetMs) ? budgetMs : 90000) + 120000 : Number(watchdogArg);
if (!Number.isSafeInteger(watchdogMs) || watchdogMs < 0) {
  console.error(`snapshot-probe: --watchdog-ms takes a whole number of ms, 0 for no watchdog (got ${watchdogArg})`);
  console.error(`usage: ${USAGE}`);
  process.exit(2);
}
const watchdogDeadline = Date.now() + watchdogMs;
const verdictCell = watchdogMs > 0 ? new Int32Array(new SharedArrayBuffer(4)) : null;
/** Call before printing a verdict: returns when the verdict is this thread's, else waits for the watchdog's SIGKILL. */
function claimVerdict() {
  if (verdictCell && Atomics.compareExchange(verdictCell, 0, 0, 1) === 2) for (;;) Atomics.wait(verdictCell, 0, 2);
}
/** Start the watchdog thread once the scratch dir exists (it removes it: a SIGKILL skips the exit hook). */
function startWatchdog(scratchDir) {
  if (!verdictCell) return;
  const line = `SNAPSHOT PROBE FAIL: watchdog: no verdict within ${watchdogMs} ms (lean_wasm_compile did not return; a task that never finishes hangs it from kernel 0037 on)`;
  // fs.writeSync(2), not console: a worker's console goes through the (blocked) main thread.
  // setTimeout clamps a delay over 2^31-1 ms to 1 ms, so the deadline is re-armed in steps.
  const guard = new Worker(
    `const fs = require("node:fs");
    const { cell, deadline, scratchDir, line } = require("node:worker_threads").workerData;
    const tick = () => {
      const left = deadline - Date.now();
      if (left > 0) { setTimeout(tick, Math.min(left, 2 ** 31 - 1)); return; }
      if (Atomics.compareExchange(cell, 0, 0, 2) !== 0) return;
      try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch {}
      try { fs.writeSync(2, line + "\\n"); } catch {}
      process.kill(process.pid, "SIGKILL");
    };
    tick();`,
    { eval: true, workerData: { cell: verdictCell, deadline: watchdogDeadline, scratchDir, line } },
  );
  guard.on("error", () => {});
  guard.unref();
}

// The artifact as every tool of this package resolves it (node-runner, persistent-probe, the
// bake): the flag, else $LEAN4_WASM64_ARTIFACT, else $QED64_LEAN_ARTIFACT (an empty value is
// unset). A relative one resolves against the cwd. Its bin/lean.js is read only when the
// runtime boots, so a missing one is the documented crash (exit 1), as in QED64.
const artifactArg = opt.artifact || process.env.LEAN4_WASM64_ARTIFACT || process.env.QED64_LEAN_ARTIFACT;
if (!artifactArg) {
  console.error("snapshot-probe: no --artifact given and LEAN4_WASM64_ARTIFACT is unset — pass --artifact <dir> or set LEAN4_WASM64_ARTIFACT");
  console.error(`usage: ${USAGE}`);
  process.exit(2);
}
const artifactDir = path.resolve(artifactArg);
// --lib is required (the contract above refused its absence) and checked here, before the
// scratch dir: the runtime would otherwise meet a missing tree only at its NODEFS mount.
const libDir = path.resolve(opt.lib);
if (!fs.existsSync(libDir)) {
  console.error(`snapshot-probe: no olean tree at ${libDir} — pass --lib <tree>, the tree the snapshot was baked from`);
  console.error(`usage: ${USAGE}`);
  process.exit(2);
}
const leanJs = path.join(artifactDir, "bin/lean.js");

// The runtime expects a .deps sidecar next to the snapshot (the worker writes
// "[]"); stage both into a scratch dir so the real snapshot dir stays clean.
// Removed on every exit, a failed link included (an unreadable or cross-device --snap).
// The prefix stays QED64's: callers that clean up after their own SIGKILL glob it.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "qed64-snap-probe-"));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));
startWatchdog(scratch);
if (!freshImport) {
  fs.linkSync(snapHost, path.join(scratch, "probe.snap"));
  fs.writeFileSync(path.join(scratch, "probe.snap.deps"), "[]");
}

const asPtr = (v) => (typeof v === "bigint" ? v : BigInt(Math.trunc(v)));
const asNum = (v) => (typeof v === "bigint" ? Number(v) : v);

let M;
const captured = [];
const DUMP = opt["dump-messages"] === true;
const capture = (stream) => (v) => {
  if (DUMP && stream === "stdout") console.log(`[lean:stdout] ${v}`);
  captured.push({ stream, text: String(v), at: performance.now() });
};
const ioTag = (res) => Number(M.getValue(asNum(res) + 7, "i8")) & 0xff;
const ioValue = (res) => BigInt(M.getValue(asNum(res) + 8, "i64"));
function mkString(text) {
  const c = M.stringToNewUTF8(text);
  const obj = M._lean_mk_string(asPtr(c));
  M._free(asPtr(c));
  return asPtr(obj);
}

process.chdir("/");
process.argv[1] = "/bin/lean";

// Provide the Memory64 ourselves (as the browser worker does) so --via-mem
// can write snapshot bytes straight into the heap; the glue does not export
// its own memory object.
const sharedMem = new WebAssembly.Memory({ address: "i64", initial: 4096n, maximum: 131072n, shared: true });

globalThis.Module = {
  noInitialRun: true,
  ...poolModuleKeys(),
  wasmMemory: sharedMem,
  INITIAL_MEMORY: 268435456,
  locateFile: (f) => path.join(path.dirname(leanJs), f),
  mainScriptUrlOrBlob: leanJs,
  print: capture("stdout"),
  printErr: capture("stderr"),
  preRun: [
    function mount() {
      // The wasm environment: the glue replaces any Module.ENV given above with its own object
      // (`Module["ENV"]=ENV`), so only an assignment here reaches getenv (as in node-runner).
      const ENV = globalThis.Module.ENV;
      ENV.LEAN_PATH = "/lib/lean";
      if (process.env.QED64_PROFILE_INIT) ENV.QED64_PROFILE_INIT = process.env.QED64_PROFILE_INIT;
      forwardWasmEnv(ENV); // the runtime's LEAN_WASM_* knobs (runtime-knobs.mjs)
      const FS = globalThis.Module.FS;
      const NODEFS = FS.filesystems.NODEFS;
      for (const d of ["/lib/lean", "/workspace", "/bin", "/snapshots"]) {
        let cur = "";
        for (const part of d.split("/").filter(Boolean)) {
          cur += `/${part}`;
          try { FS.mkdir(cur); } catch {}
        }
      }
      FS.mount(NODEFS, { root: libDir }, "/lib/lean");
      FS.mount(NODEFS, { root: scratch }, "/snapshots");
      if (workspaceDir) FS.mount(NODEFS, { root: workspaceDir }, "/workspace");
      FS.chdir("/workspace");
    },
  ],
  onRuntimeInitialized() {
    M = globalThis.Module;
    try {
      M._lean_initialize_runtime_module();
      M._lean_initialize();
      M._lean_io_mark_end_initialization();
      if (M._lean_init_task_manager) M._lean_init_task_manager();
      if (M._lean_enable_initializer_execution) M._lean_enable_initializer_execution();
      const sp = M._lean_init_search_path();
      if (ioTag(sp) !== 0) throw new Error("lean_init_search_path failed");

      let lr, t0;
      if (freshImport) {
        console.log(`== fresh import: no snapshot; the header imports from ${libDir} ==`);
      } else {
        console.log(`== load snapshot: ${path.basename(snapHost)} (${fs.statSync(snapHost).size} bytes) ==`);
        let snapPath = "/snapshots/probe.snap";
        if (viaMemfs) {
          const FS = M.FS;
          const total = fs.statSync(snapHost).size;
          const fd = fs.openSync(snapHost, "r");
          const stream = FS.open("/memsnap.snap", "w");
          try { FS.ftruncate(stream.fd, total); } catch {}
          const CHUNK = 64 * 1024 * 1024;
          const buf = new Uint8Array(CHUNK);
          let at = 0;
          while (at < total) {
            const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, total - at), at);
            FS.write(stream, buf, 0, n, at);
            at += n;
          }
          FS.close(stream);
          fs.closeSync(fd);
          FS.writeFile("/memsnap.snap.deps", new Uint8Array([0x5b, 0x5d]));
          snapPath = "/memsnap.snap";
          console.log(`staged ${total} bytes into MEMFS`);
        }
        t0 = performance.now();
        if (viaMem) {
          const total = fs.statSync(snapHost).size;
          const heapPtr = M._malloc(asPtr(total));
          if (!heapPtr) throw new Error("malloc failed");
          const fd2 = fs.openSync(snapHost, "r");
          const CH = 64 * 1024 * 1024;
          const b = new Uint8Array(CH);
          let at2 = 0;
          while (at2 < total) {
            const n = fs.readSync(fd2, b, 0, Math.min(CH, total - at2), at2);
            new Uint8Array(sharedMem.buffer, asNum(heapPtr) + at2, n).set(b.subarray(0, n));
            at2 += n;
          }
          fs.closeSync(fd2);
          console.log(`staged ${total} bytes into the wasm heap`);
          t0 = performance.now();
          const initFlags = BigInt(opt["init-flags"] ?? "1");
          lr = M._lean_wasm_load_snapshot_mem(asPtr(heapPtr), asPtr(total), initFlags);
        } else {
          lr = M._lean_wasm_load_snapshot(mkString(snapPath));
        }
        const loadMs = performance.now() - t0;
        const ltag = ioTag(lr);
        const lval = ioValue(lr);
        const lscalar = (lval & 1n) === 1n ? lval >> 1n : null;
        console.log(`load: tag=${ltag} scalar=${lscalar} elapsed=${loadMs.toFixed(0)}ms`);
        for (const l of captured) {
          if (l.text.includes("WASM PROFILE") || l.text.includes("WASM DEBUG")) {
            console.log(`  [+${((l.at - t0) / 1000).toFixed(1)}s] ${l.text.slice(0, 170)}`);
          }
        }
        if (ltag !== 0 || (lscalar !== null && lscalar !== 0n)) {
          for (const l of captured.slice(-6)) console.error(`  [lean:${l.stream}] ${l.text.slice(0, 300)}`);
          throw new Error("snapshot load reported failure");
        }
      }
      console.log(freshImport ? "== compile the probe with a fresh import ==" : "== compile the probe against the seeded environment ==");
      captured.length = 0;
      t0 = performance.now();
      const cr = M._lean_wasm_compile(mkString(probeSource), mkString("/workspace/input.lean"));
      const compileMs = performance.now() - t0;
      const errors = [];
      for (const l of captured) {
        if (!l.text.startsWith("{")) continue;
        try {
          const v = JSON.parse(l.text);
          if (v && v.severity === "error") errors.push(v.data);
        } catch {}
      }
      console.log(`compile: tag=${ioTag(cr)} elapsed=${compileMs.toFixed(0)}ms errors=${errors.length}`);
      for (const e of errors.slice(0, 3)) console.error(`  error: ${String(e).slice(0, 120)}`);
      if (ioTag(cr) !== 0 || errors.length > 0) throw new Error("probe compile failed");
      if (compileMs > budgetMs) {
        throw new Error(
          `probe compiled in ${compileMs.toFixed(0)}ms > ${budgetMs}ms budget — ` +
            "the snapshot likely seeded the WRONG import-set cache key and the compile re-imported the closure",
        );
      }
      claimVerdict();
      console.log("SNAPSHOT PROBE PASS");
      process.exit(0);
    } catch (error) {
      claimVerdict();
      console.error("SNAPSHOT PROBE FAIL:", error.message || error);
      for (const l of captured.slice(-12)) console.error(`  [lean:${l.stream}] ${l.text.slice(0, 160)}`);
      process.exit(1);
    }
  },
  onAbort(what) {
    claimVerdict();
    console.error("ABORT:", what);
    process.exit(3);
  },
};

// LEAN4_WASM64_PTHREAD_STACK_MB=<n> (test knob, node-runner's): size the runtime's pthread Workers' stack,
// which is where elaboration tasks run (Elab.async), as a browser's Worker would.
{
  const nodeRequire = createRequire(leanJs);
  const pthreadStackMb = Number(process.env.LEAN4_WASM64_PTHREAD_STACK_MB || 0);
  globalThis.require = !pthreadStackMb ? nodeRequire : (id) => {
    const m = nodeRequire(id);
    if (id !== "node:worker_threads" && id !== "worker_threads") return m;
    class SizedWorker extends m.Worker {
      constructor(file, options = {}) {
        super(file, { ...options, resourceLimits: { ...(options.resourceLimits ?? {}), stackSizeMb: pthreadStackMb } });
      }
    }
    return { ...m, Worker: SizedWorker };
  };
}
globalThis.__filename = "/bin/lean.js";
globalThis.__dirname = "/bin";
vm.runInThisContext(fs.readFileSync(leanJs, "utf8"), { filename: leanJs });
