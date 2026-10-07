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
//   node node-runner.mjs --artifact <dir> [--lib <dir>] [--work <dir>] [--] <lean args...>
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

// First, before the contract prints anything: replaces this process (same PID) when
// started without --stack-size, so every line below is printed once.
ensureStackSize("node-runner");

// The shared flag contract (cli-args.mjs) with QED64's runner grammar, passthrough "implicit"
// (QED64 SPECS["node-runner"]): the runner's own flags are --artifact, --work and --lib, each
// taking a value (--flag=value too). Lean's argv starts after `--` (which is not passed on) or,
// with no warning, at the FIRST other token: an unknown --x, an --x=y of another name, a
// positional, a single-dash flag. Everything from there is Lean's, verbatim: --help and the
// runner's own flag names included. Before that point --help/-h (even in a value position:
// `--artifact --help`) prints the help and exits 0 before any side effect; a repeated flag keeps
// its first value and a flag without a value is ignored, one `node-runner: WARNING — …` line on
// stderr each. A value-taking flag always takes the next token, even `--`.
const USAGE = "node-runner.mjs --artifact <dir> [--lib <dir>] [--work <dir>] [--] <lean args…>";
const cli = applyCliContract({
  tool: "node-runner",
  usage: USAGE,
  flags: { artifact: 1, work: 1, lib: 1 },
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
    "  -h, --help        print this help and exit 0, before any side effect (after Lean's arguments start, --help goes to Lean)",
    "",
    "arguments: Lean's own, verbatim: everything after --, or from the first token that is not one of the flags above",
    "  (an unknown --x or --x=y, a positional); `-- --help` asks Lean. A repeated flag keeps its first value and a flag",
    "  without a value is ignored, with one `node-runner: WARNING — …` line each.",
    "",
    "env: LEAN4_WASM64_PTHREAD_STACK_MB=<n> gives the runtime's pthread Workers an n-MiB stack (default 4);",
    "     0.68 reproduces a Chrome Worker's 500 KiB (deep recursion tests)",
    "     LEAN4_WASM64_CWD=work makes the work dir Lean's cwd (the pre-r2 layout: relative paths land in --work;",
    "     bakes then differ from QED64's runner in the main module name)",
    "",
    "exit codes: 2 no artifact, or lean.js or the library tree not found (nothing created); 3 the runtime aborted;",
    "otherwise Lean's own. The one-shot CLI does not exit by itself: judge a job by its output (EMBED-RUNTIME.md).",
  ].join("\n"),
});
const args = { artifact: cli.values.artifact ?? null, work: cli.values.work ?? null, lib: cli.values.lib ?? null, leanArgs: cli.passthrough };

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

globalThis.Module = {
  ...(countPthreads ? {
    print: (line) => {
      console.log(line);
      if (line.includes("[pthreads?]")) console.log(`[pthreads] created=${pthreadsCreated}`);
    },
  } : {}),
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
      FS.mount(NODEFS, { root: libLean }, "/lib/lean");
      FS.mount(NODEFS, { root: workDir }, "/work");
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
        try { FS.mount(NODEFS, { root: d }, d); } catch { /* mounted */ }
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
          try { if (FS.analyzePath(lib).exists) FS.mount(NODEFS, { root: libLean }, lib); } catch { /* already shadowed */ }
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
      // Patch 0035: dedicated-thread parking is off by default (qed64 L9);
      // the gate opts in to exercise the parking path.
      if (process.env.LEAN_WASM_PARKED_DEDICATED) {
        globalThis.Module.ENV.LEAN_WASM_PARKED_DEDICATED = process.env.LEAN_WASM_PARKED_DEDICATED;
      }
      if (process.env.QED64_PROFILE_INIT) {
        globalThis.Module.ENV.QED64_PROFILE_INIT = process.env.QED64_PROFILE_INIT;
      }
      // Patch 0036: the engine-stack probe's headroom, for calibration (0 disables it).
      if (process.env.LEAN_WASM_STACK_PROBE_SLOTS) {
        globalThis.Module.ENV.LEAN_WASM_STACK_PROBE_SLOTS = process.env.LEAN_WASM_STACK_PROBE_SLOTS;
      }
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
