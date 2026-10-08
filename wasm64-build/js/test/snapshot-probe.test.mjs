// snapshot-probe.mjs, ported from QED64 76d5447 (tests/unit/probe-watchdog.test.ts there, plus the
// probe rows of its tool-paths and cli-contract tests): the flag contract with --lib required,
// the artifact order (flag, LEAN4_WASM64_ARTIFACT, QED64_LEAN_ARTIFACT, else exit 2), the kept
// lines (QED64's marker regexes, frozen below), the in-PID watchdog, and one process throughout.
//
// No runtime boots. The artifact is a FAKE: its bin/lean.js is a stub glue (run by the probe
// through vm.runInThisContext, as the real one is) that runs preRun against a recording FS,
// implements the exports the probe calls and then calls onRuntimeInitialized. FAKE_LEAN_MODE
// picks what it does (pass, an error message, a failed load, a slow compile, an abort, a busy
// loop that never returns — which blocks the thread exactly as a hung wasm call does — or an
// exit that stalls); FAKE_TRACE=1 makes it print what the runtime would see as `FAKE {json}`
// lines. Every node process a test starts logs its PID through a --require preload
// (NODE_OPTIONS), so "one process" is a fact, not an inference. Every child has a SIGKILL
// timeout; the async ones a finally that kills what they started.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probe = path.join(pkg, "snapshot-probe.mjs");
const USAGE = "usage: snapshot-probe.mjs (--snap <file> | --fresh-import) --lib <tree> (--probe-file <file> | --probe <source>)";
const WATCHDOG_LINE = (ms) => `SNAPSHOT PROBE FAIL: watchdog: no verdict within ${ms} ms (lean_wasm_compile did not return; a task that never finishes hangs it from kernel 0037 on)`;
const W = (s) => `snapshot-probe: WARNING — ${s}`;

// QED64 pipeline/snapshot/cli.mjs SPECS["snapshot-probe"].markers at 76d5447, verbatim: the lines
// downstream parses (the compiler battery, the showcase's exact-header, lean4game's lane).
const MARKERS = {
  "load-header": /^== load snapshot: (\S+) \((\d+) bytes\) ==$/,
  load: /^load: tag=(\d+) scalar=(\S+) elapsed=(\d+)ms$/,
  compile: /^compile: tag=(\d+) elapsed=(\d+)ms errors=(\d+)$/,
  pass: /^SNAPSHOT PROBE PASS$/,
  fail: /^SNAPSHOT PROBE FAIL: (.*)$/,
  watchdog: /^SNAPSHOT PROBE FAIL: watchdog: no verdict within (\d+) ms \(lean_wasm_compile did not return; a task that never finishes hangs it from kernel 0037 on\)$/,
  "lean-stdout": /^\[lean:stdout\] (.*)$/,
  abort: /^ABORT: (.*)$/,
  "no-path": /^(\S+): no --(\S+) given and (\w+) is unset(; the deprecated default (.+) (has no \S+|is absent))? — pass --\S+ \S+ or set \w+$/,
};
// QED64 cli.mjs RESERVED_OUTPUT: substrings downstream log judges match; new lines must avoid them.
const RESERVED = [[": error", "anywhere"], ["error:", "line-initial"], [": warning:", "anywhere"], ["warning:", "line-initial"], ["PANIC", "anywhere"],
  ["ABORT:", "anywhere"], ["uncaught", "anywhere"], ["RuntimeError", "anywhere"], ["object compactor:", "anywhere"]];
const reservedHit = (text) => {
  for (const line of String(text).split("\n")) {
    for (const [r, where] of RESERVED) if (where === "line-initial" ? line.startsWith(r) : line.includes(r)) return { line, reserved: r };
  }
  return null;
};

const FAKE_GLUE = (mark) => `// fake lean.js (${mark}): the exports snapshot-probe calls, no wasm
const MARK = ${JSON.stringify(mark)};
const fs = require("node:fs");
const M = globalThis.Module;
const mode = process.env.FAKE_LEAN_MODE || "pass";
const trace = (o) => { if (process.env.FAKE_TRACE) console.log("FAKE " + JSON.stringify(o)); };
// slow-exit: the verdict is printed, then process.exit stalls past the deadline (the verdict won)
if (mode === "slow-exit") {
  const realExit = process.exit;
  process.exit = (c) => { const t = Date.now() + Number(process.env.FAKE_EXIT_DELAY_MS); while (Date.now() < t) {} realExit.call(process, c); };
}
// a recording FS: preRun mounts host dirs, --via-memfs writes a MEMFS file
const NODEFS = { name: "NODEFS" };
const mounts = [];
const memfs = new Map();
M.FS = {
  filesystems: { NODEFS },
  mkdir() {}, chdir() {}, ftruncate() {}, close() {},
  mount(type, opts, mp) { mounts.push([opts.root, mp]); return {}; },
  open(p) { const s = { fd: 3, chunks: [] }; memfs.set(p, s); return s; },
  write(s, buf, off, n) { s.chunks.push(Buffer.from(buf.subarray(off, off + n))); return n; },
  writeFile(p, bytes) { memfs.set(p, { chunks: [Buffer.from(bytes)] }); },
};
for (const f of M.preRun) f();
const host = (p) => { const m = mounts.filter(([, mp]) => p === mp || p.startsWith(mp + "/")).at(-1); return m ? m[0] + p.slice(m[1].length) : null; };
const fileOf = (p) => (memfs.has(p) ? Buffer.concat(memfs.get(p).chunks).toString() : fs.readFileSync(host(p), "utf8"));
trace({ mark: MARK, pid: process.pid, cwd: process.cwd(), argv1: process.argv[1], env: M.ENV, mounts, noInitialRun: M.noInitialRun });
// strings and Lean objects by "pointer"; results: 32 search path, 48 load, 80 compile
const strings = new Map();
let next = 1000;
const RESULT = { 32: [0, 1n], 48: [mode === "load-fail" ? 1 : 0, 1n], 80: [0, 1n] }; // [tag, i64 value]: box(0)
Object.assign(M, {
  getValue: (p, t) => { const r = RESULT[t === "i8" ? p - 7 : p - 8]; return t === "i8" ? r[0] : r[1]; },
  stringToNewUTF8: (s) => { strings.set(next, s); return next++; },
  _lean_mk_string: (c) => { const o = next++; strings.set(o, strings.get(Number(c))); return o; },
  _free() {}, _malloc: () => 64,
  _lean_initialize_runtime_module() {}, _lean_initialize() {}, _lean_io_mark_end_initialization() {},
  _lean_init_search_path: () => 32,
  _lean_wasm_load_snapshot: (o) => {
    const p = strings.get(Number(o));
    const h = host(p);
    trace({ load: p, bytes: fileOf(p), deps: fileOf(p + ".deps"), ino: h ? fs.statSync(h).ino : null, nlink: h ? fs.statSync(h).nlink : null });
    if (mode === "load-fail") M.print("cannot load the snapshot");
    return 48;
  },
  _lean_wasm_load_snapshot_mem: (ptr, len, flags) => {
    trace({ loadMem: Buffer.from(new Uint8Array(M.wasmMemory.buffer, Number(ptr), Number(len))).toString(), ptr: Number(ptr), flags: String(flags) });
    return 48;
  },
  _lean_wasm_compile: (src, file) => {
    trace({ compile: strings.get(Number(src)), file: strings.get(Number(file)) });
    if (mode === "hang") for (;;) {}
    if (mode === "abort") M.onAbort("fake abort");
    if (mode === "slow") { const t = Date.now() + 60; while (Date.now() < t) {} }
    M.print('{"severity":"information","pos":{"line":1,"column":0},"data":"1 : Nat"}');
    if (mode === "error") M.print('{"severity":"error","pos":{"line":1,"column":0},"data":"unknown identifier foo"}');
    return 80;
  },
});
M.onRuntimeInitialized();
`;

const made = [];
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "l4w-snap-probe-"))); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };

const root = tmp();
const artifact = (mark) => {
  const a = path.join(root, `artifact-${mark}`);
  write(path.join(a, "bin", "lean.js"), FAKE_GLUE(mark));
  write(path.join(a, "bin", "lean.wasm"), Buffer.from(`not wasm ${mark}`));
  return a;
};
const art = artifact("A");
const lib = path.join(root, "lib");
fs.mkdirSync(lib);
const snap = path.join(root, "probe-input.snap");
fs.writeFileSync(snap, "not a real snapshot"); // 19 bytes
const preload = path.join(root, "pid-log.cjs");
fs.writeFileSync(preload, 'if (process.env.PROBE_PID_LOG) require("node:fs").appendFileSync(process.env.PROBE_PID_LOG, JSON.stringify({ pid: process.pid, ppid: process.ppid, execArgv: process.execArgv }) + "\\n");\n');

const CLEARED = ["LEAN4_WASM64_ARTIFACT", "QED64_LEAN_ARTIFACT", "QED64_LIB_TREE", "QED64_PROFILE_INIT", "NODE_OPTIONS", "FAKE_LEAN_MODE", "FAKE_TRACE", "FAKE_EXIT_DELAY_MS"];
/** A fresh case dir: its own TMPDIR (the probe's scratch lands there) and PID log. */
function caseDir() {
  const d = fs.mkdtempSync(path.join(root, "case-"));
  fs.mkdirSync(path.join(d, "tmp"));
  return { d, tmpdir: path.join(d, "tmp"), log: path.join(d, "pids.jsonl") };
}
/** Every node process the case started, one entry per PID (the --stack-size re-exec keeps the PID: last entry wins). */
function processes(log) {
  if (!fs.existsSync(log)) return [];
  const byPid = new Map();
  for (const line of fs.readFileSync(log, "utf8").split("\n").filter(Boolean)) {
    const p = JSON.parse(line);
    byPid.set(p.pid, p);
  }
  return [...byPid.values()];
}
function envFor(c, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !CLEARED.includes(k)) env[k] = v;
  return { ...env, TMPDIR: c.tmpdir, PROBE_PID_LOG: c.log, NODE_OPTIONS: `--require ${preload}`, ...extra };
}
const baseArgs = () => ["--snap", snap, "--probe", "#check 1", "--artifact", art, "--lib", lib];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

function run(args, c = caseDir(), extra = {}, { node = ["--stack-size=8192"], script = probe, cwd = c.d, timeout = 30_000 } = {}) {
  const r = spawnSync(process.execPath, [...node, script, ...args], { cwd, encoding: "utf8", timeout, killSignal: "SIGKILL", env: envFor(c, extra) });
  return { status: r.status, signal: r.signal, pid: r.pid, stdout: r.stdout ?? "", stderr: r.stderr ?? "", procs: processes(c.log), c };
}
/** The run was one process: the PID the caller spawned (the --stack-size re-exec keeps it). */
const oneProcess = (r) => assert.deepEqual(r.procs.map((p) => p.pid), [r.pid], JSON.stringify(r.procs));
const nothingLeft = (r) => assert.deepEqual(fs.readdirSync(r.c.tmpdir), [], "the scratch dir was left behind");
const lines = (s) => s.split("\n").filter(Boolean);
const traces = (stdout) => lines(stdout).filter((l) => l.startsWith("FAKE ")).map((l) => JSON.parse(l.slice(5)));
const verdictLines = (stdout) => lines(stdout).filter((l) => !l.startsWith("FAKE "));
/** Milliseconds in the timing lines vary run to run; everything else must be byte-identical. */
const timing = (s) => s.replace(/elapsed=\d+ms/g, "elapsed=<n>ms");

// ---------- the kept lines ----------

test("PASS: the kept stdout lines, nothing on stderr, exit 0, one process, no scratch dir left", () => {
  const r = run(baseArgs());
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  const out = lines(r.stdout);
  assert.equal(out.length, 5, r.stdout);
  assert.equal(out[0], "== load snapshot: probe-input.snap (19 bytes) ==");
  assert.match(out[0], MARKERS["load-header"]);
  assert.match(out[1], /^load: tag=0 scalar=0 elapsed=\d+ms$/);
  assert.match(out[1], MARKERS.load);
  assert.equal(out[2], "== compile the probe against the seeded environment ==");
  assert.match(out[3], /^compile: tag=0 elapsed=\d+ms errors=0$/);
  assert.match(out[3], MARKERS.compile);
  assert.equal(out[4], "SNAPSHOT PROBE PASS");
  assert.match(out[4], MARKERS.pass);
  oneProcess(r);
  nothingLeft(r);
});

test("FAIL: probe errors, a failed load and a blown budget are one FAIL line each and exit 1; an abort is ABORT: and exit 3", () => {
  let r = run(baseArgs(), undefined, { FAKE_LEAN_MODE: "error" });
  assert.equal(r.status, 1);
  assert.match(lines(r.stdout).at(-1), /^compile: tag=0 elapsed=\d+ms errors=1$/);
  assert.deepEqual(lines(r.stderr), [
    "  error: unknown identifier foo",
    "SNAPSHOT PROBE FAIL: probe compile failed",
    '  [lean:stdout] {"severity":"information","pos":{"line":1,"column":0},"data":"1 : Nat"}',
    '  [lean:stdout] {"severity":"error","pos":{"line":1,"column":0},"data":"unknown identifier foo"}',
  ]);
  assert.match(lines(r.stderr)[1], MARKERS.fail);
  oneProcess(r);
  nothingLeft(r);

  r = run(baseArgs(), undefined, { FAKE_LEAN_MODE: "load-fail" });
  assert.equal(r.status, 1);
  assert.match(lines(r.stdout).at(-1), /^load: tag=1 scalar=0 elapsed=\d+ms$/);
  assert.deepEqual(lines(r.stderr), [
    "  [lean:stdout] cannot load the snapshot",
    "SNAPSHOT PROBE FAIL: snapshot load reported failure",
    "  [lean:stdout] cannot load the snapshot",
  ]);
  nothingLeft(r);

  r = run([...baseArgs(), "--budget-ms", "5"], undefined, { FAKE_LEAN_MODE: "slow" });
  assert.equal(r.status, 1);
  const fail = lines(r.stderr)[0];
  assert.match(fail, /^SNAPSHOT PROBE FAIL: probe compiled in \d+ms > 5ms budget — the snapshot likely seeded the WRONG import-set cache key and the compile re-imported the closure$/);
  assert.match(fail, MARKERS.fail);
  nothingLeft(r);

  r = run(baseArgs(), undefined, { FAKE_LEAN_MODE: "abort" });
  assert.equal(r.status, 3);
  assert.equal(r.stderr, "ABORT: fake abort\n");
  assert.match(r.stderr.trim(), MARKERS.abort);
  oneProcess(r);
  nothingLeft(r);
});

test("--dump-messages echoes Lean's stdout as [lean:stdout] lines; --fresh-import loads nothing and compiles against --lib", () => {
  let r = run([...baseArgs(), "--dump-messages"]);
  assert.equal(r.status, 0, r.stderr);
  const dumped = lines(r.stdout).filter((l) => MARKERS["lean-stdout"].test(l));
  assert.deepEqual(dumped, ['[lean:stdout] {"severity":"information","pos":{"line":1,"column":0},"data":"1 : Nat"}']);

  const missing = path.join(root, "never-baked.snap"); // --fresh-import wins: --snap is never linked
  for (const args of [["--fresh-import", "--probe", "#check 1", "--artifact", art, "--lib", lib], ["--fresh-import", "--snap", missing, "--probe", "#check 1", "--artifact", art, "--lib", lib]]) {
    r = run(args, undefined, { FAKE_TRACE: "1" });
    assert.equal(r.status, 0, r.stderr);
    const out = verdictLines(r.stdout);
    assert.equal(out[0], `== fresh import: no snapshot; the header imports from ${lib} ==`);
    assert.equal(out[1], "== compile the probe with a fresh import ==");
    assert.match(out[2], MARKERS.compile);
    assert.equal(out[3], "SNAPSHOT PROBE PASS");
    assert.equal(traces(r.stdout).some((t) => "load" in t || "loadMem" in t), false);
    nothingLeft(r);
  }
});

test("what the runtime sees: cwd /, argv[1] /bin/lean, LEAN_PATH, the mounts, the hard-linked .snap with a [] sidecar, the probe source", () => {
  const ws = path.join(root, "workspace");
  fs.mkdirSync(ws, { recursive: true });
  const probeFile = path.join(root, "probe.lean");
  fs.writeFileSync(probeFile, "import Init\n#check 1\n");
  const r = run(["--snap", snap, "--probe-file", probeFile, "--probe", "ignored", "--artifact", art, "--lib", lib, "--workspace", ws], undefined,
    { FAKE_TRACE: "1", QED64_PROFILE_INIT: "1" });
  assert.equal(r.status, 0, r.stderr);
  const [boot, load, compile] = traces(r.stdout);
  assert.equal(boot.mark, "A");
  assert.equal(boot.pid, r.pid);
  assert.equal(boot.cwd, "/");
  assert.equal(boot.argv1, "/bin/lean");
  assert.equal(boot.noInitialRun, true);
  assert.deepEqual(boot.env, { LEAN_PATH: "/lib/lean", QED64_PROFILE_INIT: "1" });
  assert.equal(boot.mounts.length, 3);
  assert.deepEqual(boot.mounts[0], [lib, "/lib/lean"]);
  assert.equal(path.dirname(boot.mounts[1][0]), r.c.tmpdir);
  assert.match(path.basename(boot.mounts[1][0]), /^qed64-snap-probe-/);
  assert.equal(boot.mounts[1][1], "/snapshots");
  assert.deepEqual(boot.mounts[2], [ws, "/workspace"]);
  assert.equal(load.load, "/snapshots/probe.snap");
  assert.equal(load.bytes, "not a real snapshot");
  assert.equal(load.deps, "[]");
  assert.equal(load.ino, fs.statSync(snap).ino); // a hard link, not a copy
  assert.equal(load.nlink, 2);
  assert.deepEqual(compile, { compile: "import Init\n#check 1\n", file: "/workspace/input.lean" }); // --probe-file wins over --probe
  assert.equal(fs.statSync(snap).nlink, 1, "the link is gone with the scratch dir");
  nothingLeft(r);

  const bare = traces(run(baseArgs(), undefined, { FAKE_TRACE: "1" }).stdout)[0];
  assert.deepEqual(bare.env, { LEAN_PATH: "/lib/lean" });
  assert.equal(bare.mounts.length, 2); // no --workspace: nothing at /workspace
});

test("--via-mem streams the .snap into the wasm heap (init flags default 1); --via-memfs stages it in MEMFS", () => {
  let r = run([...baseArgs(), "--via-mem"], undefined, { FAKE_TRACE: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(verdictLines(r.stdout).includes("staged 19 bytes into the wasm heap"), r.stdout);
  assert.deepEqual(traces(r.stdout)[1], { loadMem: "not a real snapshot", ptr: 64, flags: "1" });
  r = run([...baseArgs(), "--via-mem", "--init-flags", "3"], undefined, { FAKE_TRACE: "1" });
  assert.equal(traces(r.stdout)[1].flags, "3");
  r = run([...baseArgs(), "--via-memfs"], undefined, { FAKE_TRACE: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(verdictLines(r.stdout).includes("staged 19 bytes into MEMFS"), r.stdout);
  const load = traces(r.stdout)[1];
  assert.equal(load.load, "/memsnap.snap");
  assert.equal(load.bytes, "not a real snapshot");
  assert.equal(load.deps, "[]");
  nothingLeft(r);
});

// ---------- the flag contract ----------

test("--help/-h anywhere, a value position included, prints the help and exits 0 before any side effect; it lists the 13 flags", () => {
  const missingProbe = path.join(root, "missing.lean");
  let help = null;
  for (const args of [["--help"], ["-h"], [...baseArgs(), "--help"], ["--artifact", "--help"], ["--snap=-h"], ["--probe-file", missingProbe, "--help"], ["stray", "-h"]]) {
    const r = run(args);
    assert.equal(r.status, 0, args.join(" "));
    assert.equal(r.stderr, "", args.join(" "));
    assert.ok(r.stdout.startsWith(`${USAGE}\n`), args.join(" "));
    help ??= r.stdout;
    assert.equal(r.stdout, help, args.join(" "));
    oneProcess(r);
    nothingLeft(r);
  }
  const flags = lines(help).map((l) => /^ {2}(--[a-z-]+)/.exec(l)?.[1]).filter(Boolean);
  assert.deepEqual(flags, ["--snap", "--fresh-import", "--probe-file", "--probe", "--lib", "--artifact", "--budget-ms", "--via-mem", "--via-memfs",
    "--init-flags", "--workspace", "--dump-messages", "--watchdog-ms"]);
  assert.equal(reservedHit(help), null, JSON.stringify(reservedHit(help)));
});

test("a missing snapshot source, probe or --lib prints the usage line and exits 2, before any side effect", () => {
  for (const args of [
    ["--probe", "#check 1", "--artifact", art, "--lib", lib],
    ["--snap", snap, "--artifact", art, "--lib", lib],
    ["--snap", snap, "--probe", "#check 1", "--artifact", art],
    ["--fresh-import", "--probe", "#check 1", "--artifact", art],
    ["--snap", snap, "--probe", "#check 1", "--artifact", art, "--lib="],
  ]) {
    const r = run(args, undefined, { QED64_LIB_TREE: lib }); // QED64_LIB_TREE is not read
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "", args.join(" "));
    const expected = args.includes("--lib=") ? [W("flag --lib has no value; ignored"), USAGE] : [USAGE];
    assert.deepEqual(lines(r.stderr), expected, args.join(" "));
    oneProcess(r);
    nothingLeft(r);
  }
  // an empty --probe-file is no probe (no fallback to --probe), as in QED64
  const empty = path.join(root, "empty.lean");
  fs.writeFileSync(empty, "");
  const r = run(["--snap", snap, "--probe-file", empty, "--probe", "#check 1", "--artifact", art, "--lib", lib]);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, `${USAGE}\n`);
  nothingLeft(r);
});

test("--lib names a tree that does not exist: exit 2 naming it, before any side effect; a relative --lib resolves against the cwd", () => {
  const gone = path.join(root, "no-such-tree");
  let r = run(["--snap", snap, "--probe", "#check 1", "--artifact", art, "--lib", gone]);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.deepEqual(lines(r.stderr), [`snapshot-probe: no olean tree at ${gone} — pass --lib <tree>, the tree the snapshot was baked from`, USAGE]);
  assert.equal(reservedHit(r.stderr), null);
  oneProcess(r);
  nothingLeft(r);
  r = run(["--snap", snap, "--probe", "#check 1", "--artifact", art, "--lib", "lib"], undefined, { FAKE_TRACE: "1" }, { cwd: root });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(traces(r.stdout)[0].mounts[0], [lib, "/lib/lean"]);
});

test("the artifact: --artifact, else LEAN4_WASM64_ARTIFACT, else QED64_LEAN_ARTIFACT (empty = unset), else exit 2 before any side effect", () => {
  const [b, c] = [artifact("B"), artifact("C")];
  const args = ["--snap", snap, "--probe", "#check 1", "--lib", lib];
  const markOf = (r) => { assert.equal(r.status, 0, r.stderr); return traces(r.stdout)[0].mark; };
  assert.equal(markOf(run([...args, "--artifact", art], undefined, { FAKE_TRACE: "1", LEAN4_WASM64_ARTIFACT: b, QED64_LEAN_ARTIFACT: c })), "A");
  assert.equal(markOf(run([...args, `--artifact=${art}`], undefined, { FAKE_TRACE: "1", LEAN4_WASM64_ARTIFACT: b })), "A");
  assert.equal(markOf(run(args, undefined, { FAKE_TRACE: "1", LEAN4_WASM64_ARTIFACT: b, QED64_LEAN_ARTIFACT: c })), "B");
  assert.equal(markOf(run(args, undefined, { FAKE_TRACE: "1", LEAN4_WASM64_ARTIFACT: "", QED64_LEAN_ARTIFACT: c })), "C");
  assert.equal(markOf(run([...args, "--artifact", "artifact-B"], undefined, { FAKE_TRACE: "1", QED64_LEAN_ARTIFACT: c }, { cwd: root })), "B"); // relative: the cwd
  let r = run([...args, "--artifact="], undefined, { FAKE_TRACE: "1", LEAN4_WASM64_ARTIFACT: b });
  assert.equal(markOf(r), "B");
  assert.equal(r.stderr, `${W("flag --artifact has no value; ignored")}\n`);

  r = run(args, undefined, { LEAN4_WASM64_ARTIFACT: "", QED64_LEAN_ARTIFACT: "" });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  const err = lines(r.stderr);
  assert.deepEqual(err, ["snapshot-probe: no --artifact given and LEAN4_WASM64_ARTIFACT is unset — pass --artifact <dir> or set LEAN4_WASM64_ARTIFACT", USAGE]);
  assert.match(err[0], MARKERS["no-path"]);
  assert.equal(reservedHit(r.stderr), null);
  oneProcess(r);
  nothingLeft(r);
});

test("crashes before the runtime starts are exit 1 and leave no scratch dir: a missing --snap (the link), a missing lean.js, an unreadable --probe-file", () => {
  const empty = path.join(root, "artifact-empty");
  fs.mkdirSync(path.join(empty, "bin"), { recursive: true });
  for (const [args, needle] of [
    [["--snap", path.join(root, "missing.snap"), "--probe", "#check 1", "--artifact", art, "--lib", lib], "missing.snap"],
    [["--snap", snap, "--probe", "#check 1", "--artifact", empty, "--lib", lib], path.join(empty, "bin/lean.js")],
    [["--snap", snap, "--probe-file", path.join(root, "missing.lean"), "--artifact", art, "--lib", lib], "missing.lean"],
  ]) {
    const r = run(args);
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stderr}`);
    assert.ok(r.stderr.includes(needle), r.stderr);
    assert.doesNotMatch(r.stderr, /WARNING|watchdog/);
    oneProcess(r);
    nothingLeft(r);
  }
});

test("unknown flags and stray arguments are WARNINGs, a repeated flag keeps its first value, a value spelled like a flag is a value", () => {
  let r = run([...baseArgs(), "stray", "--bogus", "--x=y", "--", "--budget-ms", "5000", "--budget-ms=1"], undefined, { FAKE_LEAN_MODE: "slow" });
  assert.equal(r.status, 0, r.stderr); // the first --budget-ms (5000) is the budget, not 1
  assert.deepEqual(lines(r.stderr), [W("unexpected argument stray ignored"), W("unknown flag --bogus ignored"), W("unknown flag --x=y ignored"),
    W("unknown flag -- ignored"), W("flag --budget-ms repeated; the first value wins")]);
  const b = artifact("B");
  r = run([...baseArgs(), "--artifact", b], undefined, { FAKE_TRACE: "1" });
  assert.equal(traces(r.stdout)[0].mark, "A");
  assert.equal(r.stderr, `${W("flag --artifact repeated; the first value wins")}\n`);
  // QED64 read flags with indexOf/includes, so `--probe --via-mem` also turned on --via-mem; here it is the probe text
  r = run(["--snap", snap, "--lib", lib, "--artifact", art, "--probe", "--via-mem"], undefined, { FAKE_TRACE: "1" });
  assert.equal(r.status, 0, r.stderr);
  const [, load, compile] = traces(r.stdout);
  assert.equal(load.load, "/snapshots/probe.snap");
  assert.equal(compile.compile, "--via-mem");
});

// ---------- the watchdog (QED64 tests/unit/probe-watchdog.test.ts) ----------

test("watchdog: a compile that never returns gives one FAIL line, then the probe's own PID dies of SIGKILL, and no scratch dir is left", () => {
  const t0 = Date.now();
  const r = run([...baseArgs(), "--watchdog-ms", "1500"], undefined, { FAKE_LEAN_MODE: "hang" });
  assert.deepEqual([r.status, r.signal], [null, "SIGKILL"]);
  assert.ok(Date.now() - t0 >= 1500);
  const err = lines(r.stderr);
  assert.deepEqual(err, [WATCHDOG_LINE(1500)]);
  assert.match(err[0], MARKERS.watchdog);
  assert.match(err[0], MARKERS.fail);
  assert.equal(reservedHit(err[0]), null);
  const out = lines(r.stdout); // the probe printed its lines up to the hung call
  assert.equal(out.length, 3, r.stdout);
  assert.equal(out[0], "== load snapshot: probe-input.snap (19 bytes) ==");
  assert.match(out[1], /^load: tag=0 scalar=0 elapsed=\d+ms$/);
  assert.equal(out[2], "== compile the probe against the seeded environment ==");
  oneProcess(r);
  assert.equal(alive(r.pid), false);
  nothingLeft(r);
});

test("watchdog: the default is --budget-ms + 120000, the budget rounded up (QED64's arithmetic, seen through a negative budget)", () => {
  for (const [budget, ms] of [["-118500", 1500], ["-118499.5", 1501]]) {
    const r = run([...baseArgs(), "--budget-ms", budget], undefined, { FAKE_LEAN_MODE: "hang" });
    assert.deepEqual([r.status, r.signal], [null, "SIGKILL"], budget);
    assert.deepEqual(lines(r.stderr), [WATCHDOG_LINE(ms)], budget);
    oneProcess(r);
    nothingLeft(r);
  }
  // a budget that is not a number never blows (NaN), and the default deadline is then 90000 + 120000
  const r = run([...baseArgs(), "--budget-ms", "soon"], undefined, { FAKE_LEAN_MODE: "slow" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lines(r.stdout).at(-1), "SNAPSHOT PROBE PASS");
});

test("watchdog: a verdict printed before the deadline wins, even when the exit after it stalls past the deadline", () => {
  const r = run([...baseArgs(), "--watchdog-ms", "1000"], undefined, { FAKE_LEAN_MODE: "slow-exit", FAKE_EXIT_DELAY_MS: "2000" });
  assert.deepEqual([r.status, r.signal], [0, null], r.stderr);
  assert.match(r.stdout, /\nSNAPSHOT PROBE PASS\n$/);
  assert.equal(r.stderr, "");
  oneProcess(r);
  nothingLeft(r);
});

test("watchdog: a malformed --watchdog-ms exits 2 before any side effect", () => {
  for (const bad of ["-1", "1.5", "soon", "1e400"]) {
    const r = run([...baseArgs(), "--watchdog-ms", bad]);
    assert.equal(r.status, 2, bad);
    assert.deepEqual(lines(r.stderr), [`snapshot-probe: --watchdog-ms takes a whole number of ms, 0 for no watchdog (got ${bad})`, USAGE]);
    assert.equal(reservedHit(r.stderr), null);
    oneProcess(r);
    nothingLeft(r);
  }
});

test("watchdog: --watchdog-ms 0 starts none, so a hung compile stays hung until the caller kills it", () => {
  const r = run([...baseArgs(), "--watchdog-ms", "0"], undefined, { FAKE_LEAN_MODE: "hang" }, { timeout: 2500 });
  assert.deepEqual([r.status, r.signal], [null, "SIGKILL"]);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /== compile the probe against the seeded environment ==\n$/);
});

test("watchdog: stdout and stderr of a normal run are byte-identical with and without it (timings aside)", () => {
  for (const mode of ["pass", "error"]) {
    const args = [...baseArgs(), "--dump-messages", "--bogus-flag", "--budget-ms", "5000", "--budget-ms=1"];
    const watched = run(args, undefined, { FAKE_LEAN_MODE: mode });
    const unwatched = run([...args, "--watchdog-ms", "0"], undefined, { FAKE_LEAN_MODE: mode });
    assert.equal(watched.status, mode === "pass" ? 0 : 1, mode);
    assert.equal(unwatched.status, watched.status, mode);
    assert.equal(timing(unwatched.stdout), timing(watched.stdout), mode);
    assert.equal(timing(unwatched.stderr), timing(watched.stderr), mode);
    assert.deepEqual(lines(watched.stderr).filter((l) => l.includes("WARNING")), [W("unknown flag --bogus-flag ignored"), W("flag --budget-ms repeated; the first value wins")]);
    assert.ok(watched.stdout.includes('[lean:stdout] {"severity":"information"'), mode);
  }
});

// ---------- one process ----------

test("started without --stack-size it re-execs itself in place with --stack-size=8192: still one process, the caller's PID", () => {
  const r = run(baseArgs(), undefined, { FAKE_TRACE: "1" }, { node: [] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  oneProcess(r);
  assert.deepEqual(r.procs[0].execArgv, ["--stack-size=8192"]);
  assert.equal(traces(r.stdout)[0].pid, r.pid);
  // the contract's WARNING is printed once, by the re-executed image
  const w = run([...baseArgs(), "--bogus"], undefined, {}, { node: [] });
  assert.equal(w.stderr, `${W("unknown flag --bogus ignored")}\n`);
  oneProcess(w);
});

for (const signal of ["SIGTERM", "SIGKILL"]) {
  test(`a caller's ${signal} to the spawned PID ends the hung probe itself, with nothing left behind`, async () => {
    const c = caseDir();
    const proc = spawn(process.execPath, ["--stack-size=8192", probe, ...baseArgs(), "--watchdog-ms", "60000"], {
      cwd: c.d, env: envFor(c, { FAKE_LEAN_MODE: "hang" }), stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    const closed = new Promise((resolve) => proc.on("close", (code, sig) => resolve({ code, signal: sig })));
    try {
      const deadline = Date.now() + 20_000;
      while (!stdout.includes("== compile the probe") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      assert.ok(stdout.includes("== compile the probe"), stdout + stderr);
      proc.kill(signal);
      // 'close': every stdio pipe closed, so no other process holds them
      assert.deepEqual(await closed, { code: null, signal });
      assert.equal(stderr, "");
      assert.deepEqual(processes(c.log).map((p) => p.pid), [proc.pid]);
    } finally {
      try { process.kill(proc.pid, "SIGKILL"); } catch {}
    }
  });
}

// The dispatcher's exec mode (A3) lives in cli.mjs; this checks only its effect on the probe,
// and is skipped while cli.mjs has no snapshot-probe command.
const dispatches = /["']snapshot-probe["']\s*:/.test(fs.readFileSync(path.join(pkg, "cli.mjs"), "utf8"));
test("`lean4-wasm64 snapshot-probe` runs the probe in the PID its caller started (exec dispatch, deep stack)", { skip: !dispatches && "cli.mjs has no snapshot-probe command" }, () => {
  const r = run(["snapshot-probe", ...baseArgs()], undefined, { FAKE_TRACE: "1" }, { node: [], script: path.join(pkg, "cli.mjs") });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lines(r.stdout).at(-1), "SNAPSHOT PROBE PASS");
  oneProcess(r);
  assert.equal(traces(r.stdout)[0].pid, r.pid);
  assert.ok(r.procs[0].execArgv.some((a) => /^--stack[-_]size=8192$/.test(a)), JSON.stringify(r.procs));
});
