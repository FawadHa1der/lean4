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

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));

// name → [script, needs a deep JS stack (runs the wasm runtime), one-line help]
const COMMANDS = {
  fetch:   ["fetch-release.mjs",    false, "fetch a release (or parts of it) from a URL or directory and verify every byte"],
  verify:  ["verify-release.mjs",   false, "verify a release directory: digests, manifests, the build-id rule, pairing"],
  release: ["release.mjs",          false, "write release.json + SHA256SUMS for a staged release directory"],
  run:     ["node-runner.mjs",      true,  "run the wasm64 Lean CLI under Node: run --artifact <dir> [--lib <dir>] -- <lean args>"],
  gate:    ["gate.mjs",             true,  "the release gate on a runtime artifact: gate --artifact <dir>"],
  probe:   ["persistent-probe.mjs", true,  "the persistent-path probe (lean_wasm_compile): probe --artifact <dir>"],
  chunk:   ["chunk-runtime.mjs",    false, "chunk lean.js + lean.wasm and write the runtime manifest"],
  pack:    ["pack.mjs",             false, "pack an olean tree into a browser64 artifact pack + manifest"],
  "pack-set": ["pack-set.mjs",      false, "cut a release's library packs from a kernel build dir, as packs.json says"],
  unpack:  ["unpack.mjs",           false, "unpack a pack (verifying every part) into an olean tree"],
  inspect: ["inspect.mjs",          false, "inspect / deep-verify a pack manifest and its parts"],
  "olean-imports": ["olean-imports.mjs", false, "the `import all` audit of an olean tree: olean-imports --audit <tree>"],
  id:      [null,                   false, "print the runtime build id of an artifact dir: id <dir>"],
};

function usage(code) {
  const w = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  console.log(`lean4-wasm64 ${pkg.version} — Lean 4 on wasm64 (Memory64) toolchain tools\n\nusage: lean4-wasm64 <command> [args…]\n`);
  for (const [k, [, , help]] of Object.entries(COMMANDS)) console.log(`  ${k.padEnd(w)}  ${help}`);
  console.log("\n`lean4-wasm64 <command> --help` for a command's flags. Specification: formats/README.md.");
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

// Spawn, not spawnSync: the runtime never exits by itself (HOSTING.md), so a
// consumer reaps it by signalling this process. A blocked spawnSync would die
// alone and leave the runtime (multi-GB memory, its pthreads) orphaned; here
// the signal is passed on and this process exits only when the child does.
const [script, deepStack] = entry;
const nodeArgs = deepStack ? ["--stack-size=8192"] : [];
const child = spawn(process.execPath, [...nodeArgs, path.join(here, script), ...rest], { stdio: "inherit" });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
child.on("error", (e) => { console.error(`lean4-wasm64: ${e.message}`); process.exit(1); });
child.on("exit", (code, signal) => process.exit(code ?? 128 + (os.constants.signals[signal] ?? 0)));
