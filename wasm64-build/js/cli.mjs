#!/usr/bin/env node
// lean4-wasm64 <command> [args…] — one entry point for the toolchain's tools.
// Every command is a script in this package and can also be run directly
// (`node node_modules/lean4-wasm64/<script>.mjs …`); this file only dispatches.
// No command has a path default inside any repository: inputs and outputs are
// flags.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));

// name → [script, needs a deep JS stack (runs the wasm runtime), one-line help,
//         runs in the caller's PID (the dispatcher execs it instead of spawning it)]
const COMMANDS = {
  fetch:   ["fetch-release.mjs",    false, "fetch a release (or parts of it) from a URL or directory and verify every byte"],
  verify:  ["verify-release.mjs",   false, "verify a release directory: digests, manifests, the build-id rule, pairing"],
  release: ["release.mjs",          false, "write release.json + SHA256SUMS for a staged release directory"],
  run:     ["node-runner.mjs",      true,  "run the wasm64 Lean CLI under Node: run --artifact <dir> [--lib <dir>] -- <lean args>"],
  gate:    ["gate.mjs",             true,  "the release gate on a runtime artifact: gate --artifact <dir>"],
  probe:   ["persistent-probe.mjs", true,  "the persistent-path probe (lean_wasm_compile): probe --artifact <dir>"],
  bake:    ["bake-snapshot.mjs",    false, "bake an environment snapshot, gzip it content-addressed and upsert its index: bake --artifact <dir> --lib <tree> --work <dir> --out <dir>", true],
  "snapshot-probe": ["snapshot-probe.mjs", true, "load a baked snapshot and compile a probe on it: snapshot-probe (--snap <file> | --fresh-import) --lib <tree> (--probe-file <file> | --probe <source>)", true],
  chunk:   ["chunk-runtime.mjs",    false, "chunk lean.js + lean.wasm and write the runtime manifest"],
  pack:    ["pack.mjs",             false, "pack an olean tree into a browser64 artifact pack + manifest"],
  "pack-set": ["pack-set.mjs",      false, "cut a release's library packs from a kernel build dir, as packs.json says"],
  unpack:  ["unpack.mjs",           false, "unpack a pack (verifying every part) into an olean tree"],
  inspect: ["inspect.mjs",          false, "inspect / deep-verify a pack manifest and its parts"],
  "olean-imports": ["olean-imports.mjs", false, "the `import all` audit of an olean tree, or one .olean's entry counts: olean-imports (--audit <tree> | --entries <file>)"],
  id:      [null,                   false, "print the runtime build id of an artifact dir: id <dir>"],
};

function usage(code) {
  const w = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  console.log(`lean4-wasm64 ${pkg.version} — Lean 4 on wasm64 (Memory64) toolchain tools\n\nusage: lean4-wasm64 <command> [args…]\n`);
  for (const [k, [, , help]] of Object.entries(COMMANDS)) console.log(`  ${k.padEnd(w)}  ${help}`);
  console.log("\n`lean4-wasm64 <command> --help` for a command's flags. Specification: formats/README.md.");
  console.log("`bake` and `snapshot-probe` replace this process (the same PID); every other command runs as its child, which is passed SIGINT, SIGTERM and SIGHUP.");
  process.exit(code);
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "--help" || cmd === "-h") usage(cmd ? 0 : 2);
if (cmd === "--version" || cmd === "-v") { console.log(pkg.version); process.exit(0); }
const entry = COMMANDS[cmd];
if (!entry) { console.error(`lean4-wasm64: unknown command ${JSON.stringify(cmd)}`); usage(2); }

if (cmd === "id") {
  // `id` takes one positional dir, so the shared flag contract (flags only)
  // does not fit; its rules are kept by hand: help first, exit 2 on usage.
  const ID_USAGE = "usage: lean4-wasm64 id <artifact dir>";
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(`${ID_USAGE}\nPrint the runtime build id (wasm64-<16 hex of sha256(bin/lean.wasm)>) of an artifact dir.\n\nexit codes: 0 printed, 1 no bin/lean.wasm under the dir, 2 usage`);
    process.exit(0);
  }
  const [dir, ...extra] = rest.filter((a) => !a.startsWith("-"));
  for (const a of rest) if (a.startsWith("-")) console.error(`id: WARNING — unknown flag ${a} ignored`);
  for (const a of extra) console.error(`id: WARNING — unexpected argument ${a} ignored`);
  if (!dir) { console.error(ID_USAGE); process.exit(2); }
  const { buildIdOfArtifact } = await import("./artifact-id.mjs");
  try {
    console.log(await buildIdOfArtifact(path.resolve(dir)));
  } catch (e) {
    console.error(`id: ${e.message}`);
    process.exit(1);
  }
  process.exit(0);
}

const [script, deepStack, , inCallersPid] = entry;
const nodeArgs = deepStack ? ["--stack-size=8192"] : [];
const target = path.join(here, script);

/** Why process.execve cannot replace this process here, or null when it can:
 * the guards of ensureStackSize (cli-args.mjs), each named for the WARNING. */
function execBlocker(proc = process) {
  if (proc.platform === "win32" || proc.platform === "os400") return `no execve on ${proc.platform}`;
  if (typeof proc.execve !== "function") return "this Node has no process.execve";
  if (!isMainThread) return "a Worker thread";
  if (proc.channel) return "an IPC channel, which an exec would drop";
  if (proc.permission?.has?.("child") === false) return "--permission without --allow-child-process";
  return null;
}

// `bake` and `snapshot-probe` run in the PID their caller started. A caller that
// SIGKILLs that PID (the compiler battery, a supervisor's timeout) must kill the
// tool itself; the probe's watchdog SIGKILLs its own PID and per-PID measures
// (`/usr/bin/time -l`) must be the probe's; and a bake orphaned by a killed
// dispatcher would finish and write the index after its caller had gone. So the
// dispatcher REPLACES itself with the tool: process.execve, the same PID and
// stdio, the tool's own exit code or death by signal, nothing printed first.
// The tool gets exactly what the spawn below would give it: this Node, the
// stack flag when the tool runs the runtime (the bake does not: it gives its
// runner the flag itself), the script, the arguments verbatim, this environment.
// Where execve cannot work, or fails, one WARNING, then the spawn below, which
// keeps the tool working with a parent in between. (`npx lean4-wasm64 …` adds
// a process of its own above this one either way: a caller that needs the PID
// runs `node <package>/<script>.mjs`.)
if (inCallersPid) {
  let why = execBlocker();
  if (!why) {
    try {
      process.execve(process.execPath, [process.execPath, ...nodeArgs, target, ...rest], { ...process.env });
    } catch (e) {
      why = `the exec failed: ${e?.code ?? e?.message}`;
    }
  }
  console.error(`lean4-wasm64: WARNING — cannot run ${cmd} in this process (${why}); it runs as a child, so a SIGKILL of this PID would orphan it; for one PID run node ${[...nodeArgs, target].join(" ")}`);
}

// Spawn, not spawnSync: the runtime never exits by itself (HOSTING.md), so a
// consumer reaps it by signalling this process. A blocked spawnSync would die
// alone and leave the runtime (multi-GB memory, its pthreads) orphaned; here
// the signal is passed on and this process exits only when the child does.
let child;
try {
  child = spawn(process.execPath, [...nodeArgs, target, ...rest], { stdio: "inherit" });
} catch (e) {
  console.error(`lean4-wasm64: ${e.message}`); // --permission without --allow-child-process throws here
  process.exit(1);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
child.on("error", (e) => { console.error(`lean4-wasm64: ${e.message}`); process.exit(1); });
child.on("exit", (code, signal) => process.exit(code ?? 128 + (os.constants.signals[signal] ?? 0)));
