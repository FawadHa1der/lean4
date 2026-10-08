#!/usr/bin/env node
// Bake an environment snapshot with the exact wasm64 runtime under Node, gzip
// it content-addressed into --out and upsert its entry into the snapshot index
// (formats/snapshot-index.md): index.json and its per-build copy
// index.<buildId>.json, the same bytes.
//
// Snapshots embed closure relocations keyed to the producing binary's function
// table ("wasm-main" pseudo-library), so they MUST be baked by the same
// lean.js/lean.wasm the browser runs. Every entry records that `runtime`: the
// build id of the artifact's lean.wasm (artifact-id.mjs), never a manifest's.
// The raw <work>/<name>.snap is the snapshot's identity; the .snapz is only its
// transport (gzip level 6, not reproducible across zlib builds, so the bake
// prints the Node and zlib build on a line of its own).
//
// Usage: node bake-snapshot.mjs --lib <olean tree> --work <dir> --out <dir> [--artifact <dir>] [--name <name>] [--probe <lean source>] …
//        (lean4-wasm64 bake …; --help lists every flag)
// It needs no --stack-size itself: it spawns its runner with --stack-size=8192.
// Stop it with SIGTERM (or SIGINT, SIGHUP): it forwards the signal and releases its locks. A
// SIGKILL leaves <work>/.bake.lock behind, and <out>/index.json.lock too when it lands during the
// index write (never taken over: remove each once no bake uses its directory).
//
// Ported from QED64 (MIT, same author) pipeline/snapshot/bake-snapshot.mjs at 76d5447 (fix/pinned-indexes); relicensed Apache-2.0 by the author.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { fileURLToPath } from "node:url";
import { buildIdOfArtifactSync } from "./artifact-id.mjs";
import { applyCliContract } from "./cli-args.mjs";
import {
  INDEX_LOCK_WAIT_MS, IndexLockHeldError, SnapshotIndexError, createWorkLock, nameProblem, pairingProblem,
  parseEntryFields, parseInitialBytes, parseRoots, probeHeader, readIndex, snapshotEntry, upsertIndex,
} from "./snapshot-index.mjs";

const TOOL = "bake-snapshot";
const here = path.dirname(fileURLToPath(import.meta.url));

// The shared flag contract (cli-args.mjs), passthrough null: --help/-h anywhere prints the help
// and exits 0 before any side effect; a missing --lib, --work or --out prints the usage line and
// exits 2; --flag=value works; an unknown flag or a positional is a WARNING and ignored; a
// repeated flag keeps its first value (so --entry-fields is ONE JSON object, not a repeatable flag).
const USAGE = "bake-snapshot.mjs --lib <olean tree> --work <dir> --out <dir> [--artifact <dir>] [--name <name>] [--probe <lean source>] [--reserve <bytes>] [--roots <A,B,…>] [--label <text>] [--initial-bytes <bytes>] [--entry-fields <json object>] [--allow-legacy-imports] [--runner <script>] [--reap-quiet-ms <ms>] [--reap-stable-ms <ms>]";
const cli = applyCliContract({
  tool: TOOL,
  usage: USAGE,
  flags: {
    name: 1, probe: 1, artifact: 1, lib: 1, reserve: 1, work: 1, out: 1, roots: 1, label: 1, "initial-bytes": 1,
    "entry-fields": 1, "allow-legacy-imports": 0, runner: 1, "reap-quiet-ms": 1, "reap-stable-ms": 1,
  },
  required: [["lib"], ["work"], ["out"]],
  passthrough: null,
  passthroughRequired: false,
  help: [
    `usage: ${USAGE}`,
    "Bake an environment snapshot with the exact wasm64 runtime under Node (the runner is supervised and reaped), gzip it content-addressed into --out and upsert its entry into index.json and its per-build copy index.<buildId>.json (the same bytes; formats/snapshot-index.md).",
    "run as: lean4-wasm64 bake   (or: node bake-snapshot.mjs — it needs no --stack-size itself; the runner gets --stack-size=8192)",
    "",
    "flags:",
    "  --lib <olean tree>            required: the olean tree mounted at /lib/lean (the runner's --lib)",
    "  --work <dir>                  required: probe.lean and the raw <name>.snap, which is deleted when the bake starts and kept after it",
    "                                (the probes load it); one bake per --work at a time: <work>/.bake.lock records the bake's and its",
    "                                runner's pids; a held lock refuses the bake (exit 2) and is never taken over: once no bake uses",
    "                                --work (a SIGKILLed bake leaves it, and so does a crashed one whose runner was still running), remove it",
    "  --out <dir>                   required: <name>.<digest16>.snapz, index.json and index.<buildId>.json (copy first, under",
    "                                <out>/index.json.lock, which QED64's bake takes too: waited for at most 120 s, never taken over;",
    "                                another runtime's copy is never touched; older .snapz files are never deleted)",
    "  --artifact <dir>              bin/lean.wasm bakes and is stamped as `runtime`; always passed to the runner",
    "                                (default: $LEAN4_WASM64_ARTIFACT, else $QED64_LEAN_ARTIFACT; nothing else: exit 2)",
    "  --name <name>                 [A-Za-z0-9][A-Za-z0-9._-]*: <work>/<name>.snap, the .snapz and the entry's name (default: init)",
    "  --probe <lean source>         the baked file, <work>/probe.lean; the modules of its header's imports become the entry's imports",
    "                                (read as Lean reads a header; one Lean rejects, so saving no snapshot, is refused) (default: #check (2 + 2 : Nat))",
    "  --reserve <bytes>             compactor buffer reserved up front: LEAN_COMPACTOR_RESERVE for the runner (default: 3758096384, 3.5 GiB)",
    "  --roots <A,B,…>               the entry's roots: the module roots it serves (default: none)",
    "  --label <text>                the entry's label (default: none)",
    "  --initial-bytes <bytes>       the entry's initialBytes, a positive whole number (default: none)",
    "  --entry-fields <json object>  more entry fields, after the core keys and the three above, in object order; a core key,",
    "                                roots/label/initialBytes (use their flags) and the reserved raw, lib and bakedBy are refused",
    "  --allow-legacy-imports        QED64_ALLOW_LEGACY_IMPORTS=1 for the runner (patch 0030); an inherited non-empty one does the same",
    "  --runner <script>             spawned as <this node> --stack-size=8192 <script> --work <dir> --artifact <dir> --lib <tree>",
    "                                -- --incr-header-save=/work/<name>.snap /work/probe.lean; relative to the cwd",
    "                                (default: this package's node-runner.mjs, which also gets --exit-with-parent --parent-pid <this pid>,",
    "                                first: it exits once the bake is gone, so even a SIGKILLed bake leaves no runtime behind)",
    "  --reap-quiet-ms <ms>          the runtime never exits by itself: once the runner has printed nothing for this long",
    "  --reap-stable-ms <ms>         and <name>.snap has kept its size for this long, the bake SIGKILLs it (defaults: 300000, 120000)",
    "  -h, --help                    print this help and exit 0, before any side effect",
    "",
    "environment: the runner gets exactly PATH, HOME and TMPDIR from this process, LEAN_COMPACTOR_RESERVE (--reserve),",
    "  QED64_ALLOW_LEGACY_IMPORTS=1 when asked for and QED64_PROFILE_INIT when non-empty: nothing else (LEAN_PATH,",
    "  LEAN4_WASM64_CWD and the rest never reach it).",
    "  LEAN4_WASM64_ARTIFACT, QED64_LEAN_ARTIFACT  the artifact when --artifact is absent (empty = unset)",
    "  LEAN4_WASM64_BAKE_LOCK_WAIT_MS, QED64_BAKE_LOCK_WAIT_MS  tests only: the bound on the index lock's wait in ms, the first",
    "                                             non-empty one; anything but a positive number means the default, 120000 (as QED64's bake)",
    "",
    "exit codes:",
    "  0      baked; index.json and its copy written (also when the wedged runner was reaped). NOT a verdict on the probe's",
    "         Lean messages: the header snapshot is saved before Lean reports them",
    "  1      after the bake started: the runner exited non-zero or was killed by a signal this bake did not send, no .snap",
    "         was produced, or the index could not be written (unreadable, corrupt, foreign or unpaired under the lock, or",
    "         its lock still held past the wait); a written .snapz is kept and its entry printed (`unindexed entry <json>`)",
    "  2      refused before any side effect: a missing --lib/--work/--out, no artifact or lean.wasm, a bad --name, --reserve,",
    "         --roots, --initial-bytes, --entry-fields or --reap-*, a --probe whose header Lean rejects, no",
    "         --lib tree or runner script, a --work or --out that is not a directory, a --work that cannot be created, an",
    "         unreadable, corrupt, foreign or unpaired index, or a <work>/.bake.lock that is held (named: `bake pid N (running",
    "         on this host)`, … `and runner pid M (not running on this host)`, or `a holder it cannot read (…)`) or cannot be created",
    "  128+n  this bake received signal n (SIGINT, SIGTERM, SIGHUP): forwarded to the runner; no index write (a .snapz",
    "         already written is kept and its entry printed: `unindexed entry <json>`)",
  ].join("\n"),
});
const flags = cli.values;

// ---------- process state: signals, locks, temp files ----------

const state = {
  signal: null, // the first SIGINT/SIGTERM/SIGHUP this bake received
  indexed: false, // index.json and its copy written: a later signal changes nothing
  finished: null, // the exit code once main() has settled
  abort: new AbortController(),
  child: null, // the runner while it has not exited
  workLock: null, // <work>/.bake.lock once taken
  snapzTmp: null,
  unindexed: null, // the entry of a .snapz in place but not (yet) in the index
};
/**
 * A line on stderr from the 'exit' handler, where a stream write may never be flushed: fd 2 is
 * made blocking (libuv makes a pipe non-blocking), every byte written, EAGAIN retried for up to
 * about 2 s. Only a stderr that is gone loses it.
 */
function lastWords(line) {
  try { process.stderr._handle?.setBlocking?.(true); } catch { /* not a pipe or TTY */ }
  const bytes = Buffer.from(`${TOOL}: ${line}\n`);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let at = 0, tries = 0; at < bytes.length;) {
    try {
      at += fs.writeSync(2, bytes, at);
    } catch (e) {
      if (e?.code !== "EAGAIN" || (tries += 1) > 200) return;
      Atomics.wait(pause, 0, 0, 10);
    }
  }
}
const signalCode = (sig) => 128 + (os.constants.signals[sig] ?? 0);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    // Once the index is written, or the bake has settled, a signal changes nothing about the
    // outcome: exit with the bake's own code now rather than linger (a slow stdout reader).
    if (state.finished !== null) process.exit(state.finished);
    if (state.indexed) return;
    const child = state.child;
    if (state.signal) {
      // a second signal: no more waiting for the runner to die by the first one
      if (child) child.kill("SIGKILL");
      else process.exit(signalCode(state.signal));
      return;
    }
    state.signal = sig;
    process.exitCode = signalCode(sig);
    state.abort.abort(new Error(`received ${sig}`));
    if (child) {
      child.kill(sig);
      // a runner that ignores it is SIGKILLed: no runner outlives its bake
      setTimeout(() => { if (state.child === child) child.kill("SIGKILL"); }, 10_000).unref();
    }
  });
}
// Every exit ends here. A runner still running (a crash: an uncaught error mid-bake) is killed,
// and the --work lock that names it is KEPT: the lock lists every process that may write into
// --work, and SIGKILL is not instant. Otherwise the lock is released (only while it is ours).
// A .snapz in place but not indexed (a signal after compression) gets its entry printed.
process.on("exit", () => {
  if (state.child) {
    try { state.child.kill("SIGKILL"); } catch { /* gone */ }
    lastWords(`the bake ended with its runner (pid ${state.child.pid}) still running: killed; ${state.workLock?.path ?? "the --work lock"} is kept — remove it once no bake uses --work`);
  } else {
    state.workLock?.release();
  }
  if (state.snapzTmp) fs.rmSync(state.snapzTmp, { force: true });
  if (state.unindexed) lastWords(`unindexed entry ${JSON.stringify(state.unindexed)}`);
});
// The bake's own output is best effort once its reader is gone (`bake | head`, a dead log
// consumer): a closed stdout or stderr never ends a bake, whose runner would be left behind.
for (const out of [process.stdout, process.stderr]) out.on("error", () => {});
const say = (line) => console.error(`${TOOL}: ${line}`);

// ---------- the bake ----------

async function main() {
  // 1. Every input is checked before any side effect (exit 2 leaves the filesystem as it found it).
  const name = flags.name ?? "init";
  const probe = flags.probe ?? "#check (2 + 2 : Nat)";
  const reserve = flags.reserve ?? String(3.5 * 1024 ** 3);
  const problem = nameProblem(name);
  if (problem) return refuse(problem);
  // The entry's imports are the probe header's modules; a header Lean rejects (it then saves no snapshot)
  // (a tab, an unterminated comment, `public import` without `module`, …) is refused up front.
  const header = probeHeader(`${probe}\n`); // the bytes Lean reads: probe.lean is the probe plus a newline
  if (header.problem) return refuse(`refusing --probe: ${header.problem} in its header: Lean rejects that header and saves no snapshot (formats/snapshot-index.md, imports)`);
  if (!/^\d+$/.test(reserve) || !Number.isSafeInteger(Number(reserve))) return refuse(`refusing --reserve ${JSON.stringify(reserve)}: expected a whole number of bytes`);
  const ms = {};
  for (const [flag, fallback] of [["reap-quiet-ms", 300_000], ["reap-stable-ms", 120_000]]) {
    const text = flags[flag] ?? String(fallback);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) return refuse(`refusing --${flag} ${JSON.stringify(text)}: expected a whole number of milliseconds`);
    ms[flag] = Number(text);
  }
  // Tests only, read as QED64's bake reads its own: a positive number, else the default.
  const lockWaitRaw = Number(process.env.LEAN4_WASM64_BAKE_LOCK_WAIT_MS || process.env.QED64_BAKE_LOCK_WAIT_MS);
  const lockWaitMs = lockWaitRaw > 0 ? lockWaitRaw : INDEX_LOCK_WAIT_MS;
  // Page fields (QED64 docs/EMBEDDING.md §8), written into the entry only when given.
  let roots = null, initialBytes = null, fields = null;
  if (flags.roots !== undefined) {
    const r = parseRoots(flags.roots);
    if (r.problem) return refuse(r.problem);
    roots = r.value;
  }
  const label = flags.label ?? null;
  if (flags["initial-bytes"] !== undefined) {
    const r = parseInitialBytes(flags["initial-bytes"]);
    if (r.problem) return refuse(r.problem);
    initialBytes = r.value;
  }
  if (flags["entry-fields"] !== undefined) {
    const r = parseEntryFields(flags["entry-fields"]);
    if (r.problem) return refuse(r.problem);
    fields = r.value;
  }

  // The runtime identity comes from the artifact that bakes, never from a manifest beside a
  // served tree: a bake must not inherit whatever that tree happens to say.
  const artifactArg = flags.artifact || process.env.LEAN4_WASM64_ARTIFACT || process.env.QED64_LEAN_ARTIFACT;
  if (!artifactArg) return refuse("no runtime artifact — pass --artifact <dir> (bin/lean.js, bin/lean.wasm) or set LEAN4_WASM64_ARTIFACT");
  const artifactDir = path.resolve(artifactArg);
  let buildId;
  try {
    buildId = buildIdOfArtifactSync(artifactDir);
  } catch (e) {
    return refuse(`cannot read the lean.wasm under ${artifactDir} (${e?.code ?? e?.message})`);
  }
  if (!buildId) return refuse(`no lean.wasm under ${artifactDir} — pass --artifact <stage1 dir>`);

  const lib = path.resolve(flags.lib);
  if (!isDir(lib)) return refuse(`no olean tree ${lib} — pass --lib <olean tree> (the tree mounted at /lib/lean)`);
  // The default runner is this package's: QED64_RUNNER is QED64's variable, not read here.
  const packageRunner = path.join(here, "node-runner.mjs");
  const runner = flags.runner ? path.resolve(flags.runner) : packageRunner;
  if (!isFile(runner)) return refuse(`runner script ${runner} not found — pass --runner <script>`);
  // Only this package's runner knows --exit-with-parent (another, QED64's among them, would pass it to Lean).
  // --parent-pid is this bake's: a bake killed while the runner's Node is still starting is seen too.
  const exitWithParent = sameFile(runner, packageRunner);
  const work = path.resolve(flags.work);
  const out = path.resolve(flags.out);
  for (const [flag, dir] of [["work", work], ["out", out]]) {
    if (fs.existsSync(dir) && !isDir(dir)) return refuse(`--${flag} ${dir} is not a directory`);
  }

  // The index this bake will upsert into is ONE pairing, checked before the runner starts (a
  // refusal after a 20-minute bake is the expensive kind): an entry of another runtime would be
  // served under this one's manifest and trap in the browser; one with no runtime pairs with none.
  const indexPath = path.join(out, "index.json");
  let index;
  try {
    ({ index } = readIndex(indexPath));
  } catch (e) {
    if (e instanceof SnapshotIndexError) return refuse(e.message);
    throw e;
  }
  const pairing = pairingProblem(index, name, buildId, indexPath);
  if (pairing) return refuse(pairing);

  // 2. One bake per --work: two sharing it bake each other's probe.lean (its name is fixed: the
  //    main module `work.probe` is in the bytes) and the runtime's <name>.snap.tmp.<getpid()>
  //    (a constant under Emscripten), and can still exit 0 with a wrong snapshot. <work>/.bake.lock
  //    holds this bake's pid, then its runner's too once spawned (every process that may write
  //    into --work). It is the last exit-2 check (a failed create changes nothing) and never taken
  //    over (snapshot-index.mjs, locks): a lock a SIGKILLed bake left stays until removed.
  // A signal received during the checks above (hashing lean.wasm takes a moment) is handled only
  // once the event loop turns: let it, and stop before the first side effect.
  await new Promise((resolve) => setImmediate(resolve));
  if (state.signal) return signalCode(state.signal);
  let created;
  try {
    created = mkdirTracked(work);
  } catch (e) {
    return refuse(`cannot create --work ${work} (${e?.code ?? e?.message})`);
  }
  const workLockPath = path.join(work, ".bake.lock");
  let workLock;
  try {
    workLock = createWorkLock(workLockPath);
  } catch (e) {
    rollbackMkdir(created);
    return refuse(`cannot create ${workLockPath} (${e?.code ?? e?.message})`);
  }
  if (!workLock.taken) {
    rollbackMkdir(created);
    return refuse(`--work ${work} is in use (lock ${workLockPath} held by ${workLock.who}); a lock is never taken over: once no bake uses ${work}, remove it and rerun`);
  }
  state.workLock = { path: workLockPath, release: workLock.release };
  // Stale runtime temp files of this name (a save killed mid-write): never mistaken for output.
  for (const f of fs.readdirSync(work)) {
    if (f.startsWith(`${name}.snap.tmp.`)) {
      fs.rmSync(path.join(work, f), { force: true });
      console.log(`removed the stale ${path.join(work, f)} (an interrupted save's temp file)`);
    }
  }
  fs.writeFileSync(path.join(work, "probe.lean"), `${probe}\n`);

  // Always the RESOLVED artifact: the `runtime` stamped below (from artifactDir's lean.wasm)
  // must name the binary that baked, whatever the runner's own resolution would have picked.
  const runnerArgs = [
    "--stack-size=8192", runner,
    ...(exitWithParent ? ["--exit-with-parent", "--parent-pid", String(process.pid)] : []),
    "--work", work,
    "--artifact", artifactDir,
    "--lib", lib,
    "--", `--incr-header-save=/work/${name}.snap`, "/work/probe.lean",
  ];
  // Reserve the compactor's output buffer in one allocation: a whole-Mathlib environment
  // compacts to >2 GiB, and growth-by-doubling would need the old and new buffers to coexist —
  // more than the 16 GiB wasm64 space holds next to the environment itself (toolchain patch 0011).
  // Legacy non-module packages (the lean4game games) need patch 0030's gate in the runner; the
  // flag is the documented form, an inherited non-empty variable its equivalent. QED64_PROFILE_INIT
  // (init-phase timings on stderr; nothing in the runtime that shapes the bytes reads it) passes
  // when non-empty. Nothing else reaches the runner: a host LEAN_PATH would replace --lib inside
  // the runtime (lean_main's prologue copies it in after preRun), and LEAN4_WASM64_CWD would
  // change the main-module name.
  const allowLegacyImports = flags["allow-legacy-imports"] === true || !!process.env.QED64_ALLOW_LEGACY_IMPORTS;
  const runnerEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR"]) if (process.env[key] !== undefined) runnerEnv[key] = process.env[key];
  runnerEnv.LEAN_COMPACTOR_RESERVE = reserve;
  if (allowLegacyImports) runnerEnv.QED64_ALLOW_LEGACY_IMPORTS = "1";
  if (process.env.QED64_PROFILE_INIT) runnerEnv.QED64_PROFILE_INIT = process.env.QED64_PROFILE_INIT;

  console.log(`baking ${name}.snap for runtime ${buildId} (probe: ${JSON.stringify(probe)}; compactor reserve ${(Number(reserve) / 1024 ** 3).toFixed(1)} GiB) → ${out}`);
  // The gzip transport depends on the zlib build: every recorded digest goes with this line.
  console.log(`build environment: node ${process.version}, zlib ${process.versions.zlib}, shared zlib ${process.config?.variables?.node_shared_zlib ?? "unknown"}`);

  // 3. The runner. The bake must start CLEAN: a stale target satisfies the stability check
  //    before the new save even begins (it cost QED64 two silently-skipped bakes).
  const snap = path.join(work, `${name}.snap`);
  await new Promise((resolve) => setImmediate(resolve));
  if (state.signal) return signalCode(state.signal); // no runner spawned only to be killed; the previous .snap kept
  try { fs.rmSync(snap); } catch { /* absent */ }
  const run = await supervise(runnerArgs, runnerEnv, snap, ms["reap-quiet-ms"], ms["reap-stable-ms"], (pid) => {
    try {
      workLock.addPid(pid);
    } catch (e) {
      say(`WARNING — could not record the runner's pid ${pid} in ${workLockPath} (${e?.code ?? e?.message})`);
    }
  });
  if (state.signal) return signalCode(state.signal);
  if (run.error) {
    say(`cannot start the runner (${run.error.code ?? run.error.message})`);
    return 1;
  }
  if (run.reaped === null) {
    if (run.code === null) {
      say(`the runner was killed by ${run.signal}, a signal this bake did not send — nothing compressed, the index is not written`);
      return 1;
    }
    if (run.code !== 0) {
      say(`runner exited ${run.code}`);
      return 1;
    }
  }
  if (!fs.existsSync(snap)) {
    console.error("FAIL: snapshot file was not produced");
    return 1;
  }
  fs.mkdirSync(out, { recursive: true });
  try { fs.rmSync(`${snap}.deps`); } catch { /* absent */ }
  const snapBytes = fs.statSync(snap).size;

  // 4. Serve gzip: region dumps compress ~2×, and a browser worker inflates through
  //    DecompressionStream. `.snapz`, not `.gz`: a recognised gzip extension makes servers add
  //    Content-Encoding and the browser pre-inflates, defeating a compressed cache. The name is
  //    CONTENT-ADDRESSED (`<name>.<digest16>.snapz`): a rebuilt runtime produces a region of the
  //    identical raw size (same environment, different relocations), so a fixed name behind
  //    immutable HTTP caching let a stale snapshot pass every size check and trap against the
  //    new binary. The stream (read chunks, gzip level 6, the hash on the gzip bytes) is QED64's.
  console.log(`compressing ${name}.snapz …`);
  const tmpPath = path.join(out, `${name}.snapz.${process.pid}.tmp`);
  state.snapzTmp = tmpPath;
  const hasher = createHash("sha256");
  try {
    await pipeline(
      fs.createReadStream(snap),
      createGzip({ level: 6 }),
      async function* (chunks) { for await (const c of chunks) { hasher.update(c); yield c; } },
      fs.createWriteStream(tmpPath),
      { signal: state.abort.signal },
    );
  } catch (e) {
    fs.rmSync(tmpPath, { force: true });
    state.snapzTmp = null;
    if (state.signal) return signalCode(state.signal);
    say(`compressing ${snap} failed (${e?.code ?? e?.message})`);
    return 1;
  }
  const digest = hasher.digest("hex");
  const gzName = `${name}.${digest.slice(0, 16)}.snapz`;
  const gzPath = path.join(out, gzName);
  fs.renameSync(tmpPath, gzPath);
  state.snapzTmp = null;
  // Older bakes of the same name are LEFT IN PLACE: content-addressed files never collide, and a
  // producer that unlinks is how a served tree gets lost (additive only; collect garbage deliberately).
  const transferBytes = fs.statSync(gzPath).size;
  const entry = snapshotEntry({
    name, file: gzName, sha256: digest, bytes: snapBytes, transfer: transferBytes,
    imports: header.imports, runtime: buildId, roots, label, initialBytes, fields,
  });
  state.unindexed = entry; // printed on any exit before the index has it
  if (state.signal) return signalCode(state.signal);

  // 5. The index entry and the upsert (snapshot-index.mjs): under <out>/index.json.lock (waited
  //    for at most the bound, never taken over), re-read, re-check, then the copy
  //    index.<buildId>.json and index.json last, the same bytes. Any failure keeps the .snapz and
  //    prints the entry it could not index (`unindexed entry <json>`), as QED64's bake does.
  let written;
  try {
    written = await upsertIndex({ out, buildId, entry, waitMs: lockWaitMs, signal: state.abort.signal });
  } catch (e) {
    if (state.signal) return signalCode(state.signal); // the 'exit' handler prints the entry
    if (e instanceof IndexLockHeldError) say(`${e.message} (the .snapz is in place, the index is not updated)`);
    else if (e instanceof SnapshotIndexError) say(e.message); // the refusal's own line (a kept marker); nothing written
    else say(`writing the index failed (${e?.code ?? e?.message}): the .snapz is in place, index.json is not updated (its copy may be)`);
    say(`unindexed entry ${JSON.stringify(entry)}`);
    state.unindexed = null;
    return 1;
  }
  state.indexed = true;
  state.unindexed = null;
  console.log(
    `baked ${gzPath} (${transferBytes} bytes transfer, ${snapBytes} raw); ` +
      `index updated (imports: [${entry.imports.join(", ")}], runtime ${buildId})`,
  );
  console.log(`index copy ${written.copyPath} written (runtime ${buildId})`);
  return 0;
}

/**
 * Run the runner and judge it. Since patches 0020/0031 the CLI does its work and then never
 * exits (the proxied exit is swallowed by the mailbox keepalive), so once the target .snap has
 * been stable for `stableMs` while the runner printed nothing for `quietMs`, the child is
 * SIGKILLed: the compactor is CPU-silent for minutes between the last import line and the
 * finished save, so quiet alone means nothing, and stability only counts because the target was
 * unlinked at bake start. spawn, not execFile: no output buffer whose limit kills the child.
 * Resolves { code, signal, reaped } (reaped: the size at the reap, else null) or { error };
 * `onSpawn(pid)` runs as soon as the runner has a pid.
 */
function supervise(args, env, target, quietMs, stableMs, onSpawn) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearInterval(watch); state.child = null; resolve(r); } };
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    state.child = child;
    if (child.pid) onSpawn?.(child.pid);
    // the runner's output goes to the bake's; if that reader is gone the runner is drained instead
    for (const [from, to] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      from.pipe(to);
      to.once("error", () => { from.unpipe(to); from.resume(); });
    }
    let lastActivity = Date.now();
    child.stdout.on("data", () => { lastActivity = Date.now(); });
    child.stderr.on("data", () => { lastActivity = Date.now(); });
    let lastSize = -1;
    let stableSince = 0;
    let reaped = null;
    // every 5 s as QED64's bake polled; quicker only when a reap flag is shorter than 20 s
    const pollMs = Math.max(20, Math.min(5000, Math.floor(Math.min(quietMs, stableMs) / 4)));
    const watch = setInterval(() => {
      if (reaped !== null || state.signal) return;
      let size = -1;
      try { size = fs.statSync(target).size; } catch { /* not yet */ }
      if (size !== lastSize) { lastSize = size; stableSince = Date.now(); }
      const quiet = Date.now() - lastActivity > quietMs;
      const stable = size > 0 && Date.now() - stableSince > stableMs;
      if (quiet && stable) {
        reaped = size;
        console.log(`bake output stable (${size} bytes) with runner quiet — reaping the wedged exit`);
        child.kill("SIGKILL");
      }
    }, pollMs);
    child.on("error", (error) => finish({ error }));
    child.on("exit", (code, signal) => finish({ code, signal, reaped }));
  });
}

function refuse(line) {
  say(line);
  return 2;
}
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}
function sameFile(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}
/**
 * `mkdir -p dir`, one directory at a time: the directories it created, outermost first. A failure
 * removes the ones it made before rethrowing, so a refusal leaves the filesystem as it found it.
 */
function mkdirTracked(dir) {
  const missing = [];
  for (let d = dir; !fs.existsSync(d) && path.dirname(d) !== d; d = path.dirname(d)) missing.unshift(d);
  const made = [];
  try {
    for (const d of missing) {
      try {
        fs.mkdirSync(d);
      } catch (e) {
        if (e?.code === "EEXIST" && isDir(d)) continue; // made meanwhile by another process: not ours to remove
        throw e;
      }
      made.push(d);
    }
  } catch (e) {
    rollbackMkdir(made);
    throw e;
  }
  return made;
}
/** Undo mkdirTracked for a refused bake: each directory it created, innermost first, if still empty. */
function rollbackMkdir(made) {
  for (const d of [...made].reverse()) {
    try { fs.rmdirSync(d); } catch { return; }
  }
}

let code;
try {
  code = await main();
} catch (e) {
  if (!state.signal) say(`the bake crashed: ${e?.stack ?? e}`);
  code = 1;
}
state.finished = state.signal && !state.indexed ? signalCode(state.signal) : code;
process.exitCode = state.finished; // the 'exit' handler releases the --work lock
