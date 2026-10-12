#!/usr/bin/env node
// Run the wasm64 Lean CLI under Node with real-filesystem access.
//
// The browser workers mount WORKERFS packs; this driver mounts the host
// filesystem through NODEFS instead, so pipeline jobs (snapshot baking,
// integration tests, artifact probes) can run the exact runtime bytes that
// ship to browsers. Node 24+ has Memory64 on by default.
//
// The vm.runInThisContext + global-Module pattern (instead of require) and
// the argv[0]/cwd adjustments follow the proven cauli-project Node runner:
// the Emscripten glue expects `var Module` at global scope and derives the
// Lean sysroot from the virtual executable path.
//
// Usage:
//   node node-runner.mjs --artifact <dir> [--lib <dir>] [--work <dir>] [--exit-with-parent [--parent-pid <pid>]] [--] <lean args...>
//
//   <dir> must contain bin/lean.js + bin/lean.wasm, and lib/lean (the olean
//   tree) unless --lib names another tree. The artifact may also come from
//   $LEAN4_WASM64_ARTIFACT (or the older $QED64_LEAN_ARTIFACT); there is no
//   default — this file ships in the lean4-wasm64 package and knows no repo.
//   The work dir (default: a fresh temporary directory, printed to stderr) is
//   mounted at /work read-write; the library tree at /lib/lean. Lean's cwd is the
//   VFS root "/" (QED64's runner layout): name files /work/<file>. Started without
//   --stack-size, it re-execs itself with --stack-size=8192 (same PID).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { applyCliContract, ensureStackSize } from "./cli-args.mjs";
import { forwardWasmEnv, poolModuleKeys, runtimeStats } from "./runtime-knobs.mjs";

// First, before the contract prints anything: replaces this process (same PID) when
// started without --stack-size, so every line below is printed once.
ensureStackSize("node-runner");

// The shared flag contract (cli-args.mjs) with QED64's runner grammar, passthrough "implicit"
// (QED64 SPECS["node-runner"]): the runner's own flags are --artifact, --work and --lib, each
// taking a value (--flag=value too), and this package's --exit-with-parent (no value) and --parent-pid. Lean's argv starts after `--` (which is not passed on) or,
// with no warning, at the FIRST other token: an unknown --x, an --x=y of another name, a
// positional, a single-dash flag. Everything from there is Lean's, verbatim: --help and the
// runner's own flag names included. Before that point --help/-h (even in a value position:
// `--artifact --help`) prints the help and exits 0 before any side effect; a repeated flag keeps
// its first value and a flag without a value is ignored, one `node-runner: WARNING — …` line on
// stderr each. A value-taking flag always takes the next token, even `--`.
const USAGE = "node-runner.mjs --artifact <dir> [--lib <dir>] [--work <dir>] [--exit-with-parent [--parent-pid <pid>]] [--] <lean args…>";
const cli = applyCliContract({
  tool: "node-runner",
  usage: USAGE,
  flags: { artifact: 1, work: 1, lib: 1, "exit-with-parent": 0, "parent-pid": 1 },
  required: [],
  passthrough: "implicit",
  passthroughRequired: false,
  help: [
    `usage: ${USAGE}`,
    "Run the wasm64 Lean CLI under Node (NODEFS): the artifact's bin/lean.js + bin/lean.wasm, the library at /lib/lean, the work dir at /work.",
    "run as: lean4-wasm64 run   (or: node node-runner.mjs — started without --stack-size it re-execs itself with --stack-size=8192, same PID)",
    "",
    "flags:",
    "  --artifact <dir>  bin/lean.js + bin/lean.wasm (and lib/lean unless --lib); or $LEAN4_WASM64_ARTIFACT",
    "  --lib <dir>       the olean tree mounted at /lib/lean (default: <artifact>/lib/lean)",
    "  --work <dir>      mounted read-write at /work, created when absent once the artifact checks pass (default: a fresh temporary directory);",
    "                    Lean's cwd is /, so name files /work/<file> (/work/x.lean is module work.x, as under QED64's runner)",
    "  --exit-with-parent  exit (1) once the process that started this one is gone: the one-shot CLI never exits by itself,",
    "                    so a runner whose supervisor was SIGKILLed would otherwise run on (lean4-wasm64 bake passes it)",
    "  --parent-pid <pid>  the pid of the process that spawned node-runner.mjs itself, which --exit-with-parent watches",
    "                    (default: the parent pid when the runner starts, which misses a parent that died while Node",
    "                    started); a live process that is not this runner's parent is exit 2. Not through `lean4-wasm64",
    "                    run` or npx, which add a process: start node <package>/node-runner.mjs. lean4-wasm64 bake passes it",
    "  -h, --help        print this help and exit 0, before any side effect (after Lean's arguments start, --help goes to Lean)",
    "",
    "arguments: Lean's own, verbatim: everything after --, or from the first token that is not one of the flags above",
    "  (an unknown --x or --x=y, a positional); `-- --help` asks Lean. A repeated flag keeps its first value and a flag",
    "  without a value is ignored, with one `node-runner: WARNING — …` line each.",
    "",
    "env: LEAN4_WASM64_PTHREAD_STACK_MB=<n> gives the runtime's pthread Workers an n-MiB stack (default 4);",
    "     0.68 reproduces a Chrome Worker's 500 KiB (deep recursion tests)",
    "     LEAN4_WASM64_PTHREAD_POOL=<n> is Module.pthreadPoolSize: the pthread Workers created at load (0..64, default 24;",
    "     kernel patch 0038 on, earlier runtimes ignore it)",
    "     LEAN_WASM_PARKED_DEDICATED, LEAN_WASM_PARKED_IDLE_MS, LEAN_WASM_STD_SURPLUS_EXIT, LEAN_WASM_STACK_PROBE_SLOTS and",
    "     LEAN_WASM_SYMTAB_TRACE are copied into the runtime's environment (EMBED-RUNTIME.md §3.1); LEAN_WASM_SYMTAB_TRACE",
    "     (kernel patch 0039) prints native-symbol lookups on stderr: miss|hit|all[:prefix,…], clauses joined by ';'",
    "     LEAN4_WASM64_RTSTATS=1 answers every printed line containing [rtstats?] with a line [rtstats] <json>: the pool,",
    "     task-manager and engine-guard counters (runtime-knobs.mjs runtimeStats); QED64_COUNT_PTHREADS=1 answers",
    "     [pthreads?] with [pthreads] created=<n>",
    "     LEAN4_WASM64_CWD=work makes the work dir Lean's cwd (the pre-r2 layout: relative paths land in --work;",
    "     bakes then differ from QED64's runner in the main module name)",
    "",
    "exit codes: 2 no artifact, lean.js or the library tree not found, or a --parent-pid that is not a pid or not this runner's",
    "parent (nothing created); 3 the runtime aborted;",
    "1 with --exit-with-parent once the parent is gone; otherwise Lean's own. The one-shot CLI does not exit by itself:",
    "judge a job by its output (EMBED-RUNTIME.md).",
  ].join("\n"),
});
const args = { artifact: cli.values.artifact ?? null, work: cli.values.work ?? null, lib: cli.values.lib ?? null, leanArgs: cli.passthrough };

// --exit-with-parent: the one-shot CLI never exits by itself (patches 0020/0031), so a runner
// whose supervisor died without passing a signal on (a SIGKILLed bake) would run on, writing into
// --work. Installed first, before any check: the parent is --parent-pid when given (the bake passes
// its own pid, so a bake that died while this Node was still starting is seen at once: the ppid
// is then another process's), else the ppid now. Every 500 ms, and at once: when this process's
// ppid is no longer the parent, or the parent no longer runs, exit 1. The runtime runs on
// pthreads (Workers); this thread only serves their proxied calls, so the check keeps running.
if (cli.values["exit-with-parent"]) {
  const given = cli.values["parent-pid"];
  if (given !== undefined && !(/^[1-9]\d*$/.test(given) && Number(given) <= 0x7fffffff)) {
    console.error(`error: --parent-pid ${JSON.stringify(given)} is not a pid`);
    process.exit(2);
  }
  const parent = given !== undefined ? Number(given) : process.ppid;
  // A live --parent-pid that is not this process's parent is a caller's mistake, not a parent gone.
  if (process.ppid !== parent && process.ppid !== 1 && (() => { try { process.kill(parent, 0); return true; } catch (e) { return e?.code === "EPERM"; } })()) {
    console.error(`error: --parent-pid ${parent} is not this runner's parent (its parent is ${process.ppid})`);
    process.exit(2);
  }
  const gone = () => {
    if (process.ppid !== parent) return true;
    try { process.kill(parent, 0); return false; } catch (e) { return e?.code !== "EPERM"; }
  };
  const check = () => {
    if (!gone()) return;
    console.error(`node-runner: the parent process ${parent} is gone (--exit-with-parent); exiting`);
    process.exit(1);
  };
  check();
  setInterval(check, 500).unref();
} else if (cli.values["parent-pid"] !== undefined) {
  console.error("node-runner: WARNING — --parent-pid without --exit-with-parent is ignored");
}

const artifactArg = args.artifact || process.env.LEAN4_WASM64_ARTIFACT || process.env.QED64_LEAN_ARTIFACT;
if (!artifactArg) {
  console.error("error: no runtime artifact — pass --artifact <dir> (bin/lean.js, bin/lean.wasm) or set LEAN4_WASM64_ARTIFACT");
  process.exit(2);
}
const artifactDir = path.resolve(artifactArg);

const leanJs = path.join(artifactDir, "bin/lean.js");
// --lib replaces the library tree (e.g. an unpacked profile pack) so bakes run
// against exactly the artifact set the browser mounts: it is the only library
// Lean can reach (only bin/ of the artifact is mirrored, and the artifact's own
// lib/lean is shadowed wherever the VFS could still reach it — below).
const libLean = args.lib ? path.resolve(args.lib) : path.join(artifactDir, "lib/lean");
if (!fs.existsSync(leanJs)) {
  console.error(`error: ${leanJs} not found — pass --artifact or set QED64_LEAN_ARTIFACT`);
  process.exit(2);
}
if (!fs.existsSync(libLean)) {
  console.error(`error: ${libLean} not found`);
  process.exit(2);
}
// Created only once the inputs are known to exist: a refused run (exit 2) leaves the
// filesystem as it found it, --work and the default temporary directory alike (QED64's
// node-runner, docs/CLI-CONTRACT.md exit class 2 there).
let workDir;
if (args.work) {
  workDir = path.resolve(args.work);
  fs.mkdirSync(workDir, { recursive: true });
} else {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "lean4-wasm64-work-"));
  console.error(`node-runner: work dir ${workDir}`);
}

// lean_main's Node prologue (src/util/shell.cpp) runs after preRun: it copies the
// HOST LEAN_PATH into the VFS environment and chdirs the VFS to the host cwd. Pin
// both. LEAN_PATH: the mounted library (a host value — `lake env`, a project shell —
// would replace --lib). The cwd: "/", as QED64's runner has always had it
// (pipeline/snapshot/node-runner.mjs there): Lean names the main module after the
// input's path relative to the cwd (Shell.lean moduleNameOfFileName), so
// /work/probe.lean is `work.probe` at "/" and `_stdin` (with -o: an error) anywhere
// else, and a snapshot baked here is byte-identical to one baked by QED64's runner
// only at "/". Relative Lean paths therefore resolve in the in-memory root, not the
// work dir: pass /work/… paths (--root=/work names /work/X.lean `X`).
// LEAN4_WASM64_CWD=work keeps the 4.34.0-41ec565 / -e1a79c1 layout instead (the cwd is
// the work dir, mirrored at its host path) for scripts that pass relative paths; its
// bakes differ from QED64's in the main module name.
/** A host path by its real spelling (symbolic links resolved); as given when it cannot be resolved. */
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
let vfsCwd = "/";
let mirrorWork = false;
const cwdMode = process.env.LEAN4_WASM64_CWD ?? "";
if (cwdMode && cwdMode !== "work") console.error(`node-runner: WARNING — LEAN4_WASM64_CWD=${cwdMode} ignored (only \`work\` is known); the cwd is /`);
if (cwdMode === "work") {
  // realpath.native: the on-disk spelling, which process.cwd() reports (case-insensitive APFS)
  const workReal = fs.realpathSync.native(workDir);
  // The prologue mounts host /tmp and /home 1:1 (and reads /private/tmp as /tmp), so a work
  // dir there needs no mirror; one whose host path overlaps the VFS layout cannot have one.
  const inVfs = workReal.replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
  if (inVfs === "/" || /^\/(work|lib|bin|dev|proc|workspace)(\/|$)/.test(inVfs)) {
    console.error(`node-runner: work dir ${workReal} overlaps the runtime's own paths; relative Lean paths resolve in memory — pass /work/… paths`);
  } else {
    vfsCwd = workReal;
    mirrorWork = !/^\/(tmp|home)(\/|$)/.test(inVfs);
  }
}
process.env.LEAN_PATH = "/lib/lean";
process.chdir(vfsCwd);
// Emscripten forwards process.argv[1] as argv[0]; present the virtual install
// layout so Lean derives /lib/lean as its sysroot.
process.argv[1] = "/bin/lean";

// Opt-in (QED64_COUNT_PTHREADS=1): count the pthreads the runtime creates. Every
// pthread_create of this build reaches the glue's `spawnThread` on the main
// runtime thread (pthreads proxy creation there). A printed line containing the
// marker `[pthreads?]` is answered with `[pthreads] created=<n>`, so a probe can
// report the count at a point of its choosing (the CLI never exits).
const countPthreads = !!process.env.QED64_COUNT_PTHREADS;
let pthreadsCreated = 0;
// Opt-in (LEAN4_WASM64_RTSTATS=1), the same way: a printed line containing `[rtstats?]` is
// answered with `[rtstats] <json>`, the runtime's thread and engine-guard counters
// (runtime-knobs.mjs). A Lean thread's print is a synchronous proxied call to this thread,
// so the answer follows the line at once; the exports it reads are lock-free.
const rtStats = !!process.env.LEAN4_WASM64_RTSTATS;

globalThis.Module = {
  ...(countPthreads || rtStats ? {
    print: (line) => {
      console.log(line);
      if (countPthreads && line.includes("[pthreads?]")) console.log(`[pthreads] created=${pthreadsCreated}`);
      if (rtStats && line.includes("[rtstats?]")) console.log(`[rtstats] ${JSON.stringify(runtimeStats(globalThis.Module))}`);
    },
  } : {}),
  // LEAN4_WASM64_PTHREAD_POOL (patch 0038): the pool of pthread Workers created at load
  ...poolModuleKeys(),
  arguments: args.leanArgs,
  locateFile: (file) => path.join(path.dirname(leanJs), file),
  mainScriptUrlOrBlob: leanJs,
  preRun: [
    function mountHost() {
      const FS = globalThis.Module.FS;
      const NODEFS = FS.filesystems.NODEFS;
      const mkdirTree = (p) => {
        let cur = "";
        for (const part of p.split("/").filter(Boolean)) {
          cur += `/${part}`;
          try {
            FS.mkdir(cur);
          } catch {
            /* exists */
          }
        }
      };
      for (const dir of ["/lib/lean", "/work", "/bin", "/workspace"]) mkdirTree(dir);
      // A NODEFS root that is a symbolic link cannot be walked (its root node is the link): mount
      // every host directory by its real path. The VFS paths, and so the bytes, do not change.
      FS.mount(NODEFS, { root: real(libLean) }, "/lib/lean");
      FS.mount(NODEFS, { root: real(workDir) }, "/work");
      // Patch 0031 runs main on a pthread whose Node context derives the app
      // path from the HOST path of lean.js; Lean then stats that directory inside
      // the VFS. Mirror bin/ — only bin/: mirroring the whole artifact would put
      // <artifact>/lib/lean on the built-in search path behind --lib.
      // Node runs a pthread's script under its REAL path (/var → /private/var on macOS, any
      // symlinked project dir): mirror bin/ under both spellings, and shadow both below.
      const binDir = path.dirname(leanJs);
      const binDirs = [...new Set([binDir, fs.realpathSync(binDir)])];
      for (const d of binDirs) {
        mkdirTree(d);
        try { FS.mount(NODEFS, { root: real(d) }, d); } catch { /* mounted */ }
      }
      if (mirrorWork) { // LEAN4_WASM64_CWD=work only
        mkdirTree(vfsCwd);
        try { FS.mount(NODEFS, { root: vfsCwd }, vfsCwd); } catch { /* mounted */ }
      }
      // With --lib, the built-in search entry (<artifact>/lib/lean, from lean.js's host path)
      // must answer nothing else: shadow it with --lib wherever it is reachable — through the
      // work-dir mirror (LEAN4_WASM64_CWD=work), or through the prologue's own /home and /tmp
      // mounts, which come after preRun (so the shadow is re-laid behind them).
      const builtinLibs = binDirs.map((d) => path.join(path.dirname(d), "lib", "lean"));
      const shadow = () => {
        if (!args.lib) return;
        for (const lib of builtinLibs) {
          try { if (FS.analyzePath(lib).exists) FS.mount(NODEFS, { root: real(libLean) }, lib); } catch { /* already shadowed */ }
        }
      };
      shadow();
      const mount = FS.mount;
      FS.mount = function (type, opts, mountpoint) {
        // On macOS /tmp and /home are symlinks, and a NODEFS root that is a symlink cannot be
        // walked: the prologue's mounts would expose nothing. Mount their targets instead.
        if (type === NODEFS && (mountpoint === "/home" || mountpoint === "/tmp") && opts?.root) {
          try { opts = { ...opts, root: fs.realpathSync(opts.root) }; } catch { /* absent: as given */ }
        }
        const node = mount.call(this, type, opts, mountpoint);
        if (mountpoint === "/home" || mountpoint === "/tmp") shadow();
        return node;
      };
      globalThis.Module.ENV.LEAN_PATH = "/lib/lean";
      // Game packages (lean4game ecosystem) are legacy non-`module` Lean
      // packages; patch 0030's gate lets the exported-level wasm env cache
      // load their self-contained oleans. Opt-in via host env, mirrored here.
      if (process.env.QED64_ALLOW_LEGACY_IMPORTS) {
        globalThis.Module.ENV.QED64_ALLOW_LEGACY_IMPORTS = "1";
      }
      // Whole-environment saves need the region buffer reserved up front (see
      // toolchain patch 0011); the bake passes the size through this env var.
      if (process.env.LEAN_COMPACTOR_RESERVE) {
        globalThis.Module.ENV.LEAN_COMPACTOR_RESERVE = process.env.LEAN_COMPACTOR_RESERVE;
      }
      if (process.env.QED64_PROFILE_INIT) {
        globalThis.Module.ENV.QED64_PROFILE_INIT = process.env.QED64_PROFILE_INIT;
      }
      // The runtime's own knobs (runtime-knobs.mjs): dedicated-thread parking (0035, off by
      // default, qed64 L9; the gate opts in to exercise it), a parked thread's idle exit and the
      // exit of surplus standard workers (0038, off by default), the engine-stack probe's
      // headroom (0036, for calibration; 0 disables it) and the native-symbol trace (0039).
      forwardWasmEnv(globalThis.Module.ENV);
    },
  ],
  onExit: (code) => {
    process.exitCode = code;
  },
  onAbort: (what) => {
    console.error("ABORT:", what);
    process.exit(3);
  },
};

// CommonJS facilities the glue expects at script scope.
// Test knob (LEAN4_WASM64_PTHREAD_STACK_MB=<n>): give the runtime's pthread Workers an n-MiB
// stack (V8 limit and thread stack, Node's resourceLimits.stackSizeMb; default 4). Browsers run
// pthreads in Workers with a much smaller V8 stack than Node does, and wasm frames live on that
// stack: this reproduces a browser's stack budget headlessly (qed64 HARDENING #60).
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
globalThis.__filename = "/bin/lean.js";
globalThis.__dirname = "/bin";

vm.runInThisContext(fs.readFileSync(leanJs, "utf8"), { filename: leanJs });

if (countPthreads) {
  if (typeof globalThis.spawnThread !== "function") {
    console.error("QED64_COUNT_PTHREADS: the glue exposes no global spawnThread; counting disabled");
  } else {
    const spawnThread = globalThis.spawnThread;
    globalThis.spawnThread = (params) => { pthreadsCreated++; return spawnThread(params); };
  }
}
