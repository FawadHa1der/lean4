// bake-snapshot.mjs end to end on a FAKE runner (a script that records how it was started and
// writes the raw .snap; the plan in probe.lean's `-- FAKE {json}` line makes it wedge, flood,
// die by a signal or write into --out mid-bake) and a fake artifact: no runtime boots. Every
// bake runs as a separate process, exactly as a user runs it. Expected names and digests are
// computed from the bytes the bake wrote, never hard-coded (the gzip stream is zlib-build dependent).
// Cases ported from QED64 (MIT, same author) tests/unit/{tool-paths,artifact-discipline,cli-contract}.test.ts
// at 76d5447 (fix/pinned-indexes); relicensed Apache-2.0 by the author.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runtimeBuildId } from "../artifact-id.mjs";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BAKE = path.join(pkg, "bake-snapshot.mjs");
// hermetic: no artifact, legacy-imports gate, init profile or lock wait from the environment ("" counts as unset)
const ENV = { ...process.env, LEAN4_WASM64_ARTIFACT: "", QED64_LEAN_ARTIFACT: "", QED64_ALLOW_LEGACY_IMPORTS: "", QED64_PROFILE_INIT: "", LEAN4_WASM64_BAKE_LOCK_WAIT_MS: "", QED64_BAKE_LOCK_WAIT_MS: "" };
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "l4w-bake-")); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
const lines = (s) => String(s ?? "").split("\n").filter(Boolean);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const SCHEMA = "qed64.snapshot-index/v1";
const OTHER = "wasm64-0000000000000000";

// The kept markers, regexes copied verbatim from QED64 pipeline/snapshot/cli.mjs at 76d5447
// (SPECS["bake-snapshot"].markers): consumers (adopt-release.sh `^baked`, the showcase's
// judge-bake.mjs J3) parse these lines, so the package prints them byte for byte.
const MARKERS = {
  baking: /^baking (\S+)\.snap for runtime (\S+) \(probe: (.*); compactor reserve (\d+\.\d) GiB\) → (.+)$/,
  reaped: /^bake output stable \((\d+) bytes\) with runner quiet — reaping the wedged exit$/,
  compressing: /^compressing (\S+)\.snapz …$/,
  baked: /^baked (\S+\/([^/\s]+)\.([0-9a-f]{16})\.snapz) \((\d+) bytes transfer, (\d+) raw\); index updated \(imports: \[([^\]]*)\], runtime (\S+)\)$/,
  "index-copy": /^index copy (.+[\/\\]index\.(wasm64-[0-9a-f]{16})\.json) written \(runtime (wasm64-[0-9a-f]{16})\)$/,
  "no-snap": /^FAIL: snapshot file was not produced$/,
  "no-artifact": /^bake-snapshot: no lean\.wasm under (.+) — pass --artifact <stage1 dir>$/,
  "refuse-foreign": /^bake-snapshot: (.+) already holds entries for runtime (\S+) \((.*)\) — refusing to mix pairings$/,
  "refuse-unpaired": /^bake-snapshot: (.+) holds entries with no runtime pairing \((.*)\) — rebake /,
};
// QED64's RESERVED_OUTPUT (pipeline/snapshot/cli.mjs): log judges match these anywhere in a bake log.
const RESERVED = [[": error", false], ["error:", true], [": warning:", false], ["warning:", true], ["PANIC", false], ["ABORT:", false], ["uncaught", false], ["RuntimeError", false], ["object compactor:", false]];
/** The markers a line matches. */
const markersOf = (line) => Object.keys(MARKERS).filter((id) => MARKERS[id].test(line));
/** Every line the bake printed (the fake runner prints nothing but its `wedged` line): no reserved substring. */
function assertNoReserved(text) {
  for (const line of lines(text)) {
    for (const [r, initial] of RESERVED) assert.ok(initial ? !line.startsWith(r) : !line.includes(r), `reserved ${JSON.stringify(r)} in ${JSON.stringify(line)}`);
  }
}

// ---------- fixtures ----------

const FAKE_RUNNER = `// A stand-in for node-runner.mjs: records how it was started, then follows the plan in
// probe.lean's "-- FAKE {json}" line (default: write the .snap and exit 0).
import fs from "node:fs";
import path from "node:path";
const a = process.argv.slice(2);
const work = a[a.indexOf("--work") + 1];
const save = a.find((x) => x.startsWith("--incr-header-save=")).slice("--incr-header-save=".length);
const target = path.join(work, save.replace(/^\\/work\\//, ""));
const probe = fs.readFileSync(path.join(work, "probe.lean"), "utf8");
const m = /^-- FAKE (.*)$/m.exec(probe);
const plan = m ? JSON.parse(m[1]) : {};
fs.writeFileSync(path.join(work, "runner.json"), JSON.stringify({ argv: a, execArgv: process.execArgv, execPath: process.execPath, env: process.env, pid: process.pid }));
for (const [file, text] of plan.writes ?? []) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
// a region: poorly compressible bytes interleaved with text, so the gzip spans many read chunks
const region = (n, seed) => { const b = Buffer.alloc(n); let x = seed >>> 0 || 1; for (let i = 0; i < n; i += 1) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = i % 4 === 0 ? x & 0xff : 97 + (i % 13); } return b; };
if (plan.snap !== null) fs.writeFileSync(target, plan.snap !== undefined ? plan.snap : region(plan.bytes ?? 300_000, plan.seed ?? save.length));
if (plan.ignoreTerm) process.on("SIGTERM", () => {});
fs.writeFileSync(path.join(work, "runner.pid"), String(process.pid)); // last: everything above is on disk
if (plan.kill) process.kill(process.pid, plan.kill);
if (plan.flood) {
  const chunk = Buffer.alloc(64 * 1024, "flood line, nothing to judge here ................................\\n");
  const t0 = Date.now();
  const rate = plan.flood / Math.max(1, plan.floodMs ?? 1); // bytes per ms: plan.flood bytes over plan.floodMs, never quiet
  let sent = 0;
  while (sent < plan.flood) {
    if (!process.stdout.write(chunk)) await new Promise((r) => process.stdout.once("drain", r));
    sent += chunk.length;
    const ahead = sent / rate - (Date.now() - t0);
    if (ahead > 1) await new Promise((r) => setTimeout(r, Math.min(ahead, 20)));
  }
  fs.writeFileSync(path.join(work, "flood.done"), String(sent));
}
if (plan.wedge) {
  console.log("wedged: the save is done and the exit never comes");
  setInterval(() => {}, 1000);
  setTimeout(() => process.exit(9), 60_000); // never outlives a failed test by long
} else process.exit(plan.exit ?? 0);
`;
const RUNNER = path.join(tmp(), "fake-runner.mjs");
fs.writeFileSync(RUNNER, FAKE_RUNNER);
const probeWith = (plan, header = "") => `${header}-- FAKE ${JSON.stringify(plan)}\n#check (2 + 2 : Nat)`;

/** An artifact (its own lean.wasm, so its own build id), a lib tree, and the --work/--out paths (not created). */
function fixture() {
  const root = tmp();
  const art = path.join(root, "art");
  write(path.join(art, "bin", "lean.wasm"), Buffer.from(`\0asm a fake runtime ${root}`));
  write(path.join(art, "bin", "lean.js"), "// never loaded by these tests\n");
  const lib = path.join(root, "lib");
  fs.mkdirSync(lib);
  const id = runtimeBuildId(fs.readFileSync(path.join(art, "bin", "lean.wasm")));
  return { root, art, lib, id, work: path.join(root, "work"), out: path.join(root, "out") };
}
/** The bake's argv: the fixture's paths and the fake runner, then `over` (null omits a flag, true is a boolean flag). */
const argsOf = (f, over = {}) => Object.entries({ artifact: f.art, lib: f.lib, work: f.work, out: f.out, runner: RUNNER, ...over })
  .flatMap(([k, v]) => (v === null || v === undefined ? [] : v === true ? [`--${k}`] : [`--${k}`, String(v)]));
function bake(f, over = {}, { env = {}, cwd, stdout } = {}) {
  const r = spawnSync(process.execPath, [BAKE, ...argsOf(f, over)], {
    encoding: "utf8", env: { ...ENV, ...env }, cwd, timeout: 60_000, killSignal: "SIGKILL",
    ...(stdout !== undefined ? { stdio: ["ignore", stdout, "pipe"] } : {}),
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? "", stderr: r.stderr ?? "", out: lines(r.stdout), err: lines(r.stderr) };
}
/** A bake in the background: { p, closed (resolves {code, signal}), stdout(), stderr() }. */
function bakeAsync(f, over = {}, env = {}) {
  const p = spawn(process.execPath, [BAKE, ...argsOf(f, over)], { stdio: ["ignore", "pipe", "pipe"], env: { ...ENV, ...env } });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d) => { stdout += d; });
  p.stderr.on("data", (d) => { stderr += d; });
  const killer = setTimeout(() => p.kill("SIGKILL"), 30_000);
  const closed = new Promise((resolve) => p.on("close", (code, signal) => { clearTimeout(killer); resolve({ code, signal }); }));
  return { p, closed, stdout: () => stdout, stderr: () => stderr };
}
async function waitFor(pred, what, ms = 15_000) {
  for (const t0 = Date.now(); !pred();) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}
const recorded = (f) => JSON.parse(fs.readFileSync(path.join(f.work, "runner.json"), "utf8"));
const runnerPid = (f) => Number(fs.readFileSync(path.join(f.work, "runner.pid"), "utf8"));
/** Every path under `dir` with its size (directories too), so a refusal that touched the filesystem shows. */
function tree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(`${path.relative(dir, p)} ${e.isDirectory() ? "dir" : fs.lstatSync(p).size}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}
const readIndexFile = (f) => JSON.parse(fs.readFileSync(path.join(f.out, "index.json"), "utf8"));
const snapzOf = (f) => fs.readdirSync(f.out).filter((x) => x.endsWith(".snapz"));
const writeIndex = (f, snapshots, raw) => write(path.join(f.out, "index.json"), raw ?? JSON.stringify({ schema: SCHEMA, snapshots }));
/** The gzip of `file` through QED64's stream (read stream → createGzip({ level: 6 })), independently of the bake. */
async function gzipAsQed64(file) {
  const to = path.join(tmp(), "expected.gz");
  await pipeline(fs.createReadStream(file), createGzip({ level: 6 }), fs.createWriteStream(to));
  return fs.readFileSync(to);
}
const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ago = (file, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(file, t, t); };
const workLockOf = (f) => path.join(f.work, ".bake.lock");
/** The --work refusal line, QED64-style: the lock never taken over. */
const workRefusal = (f, who) => `bake-snapshot: --work ${f.work} is in use (lock ${workLockOf(f)} held by ${who}); a lock is never taken over: once no bake uses ${f.work}, remove it and rerun`;
/** The two lines of an index lock still held past the wait (QED64 76d5447's, plus the package's entry line). */
const indexLockLine = (f, who, ms) => `bake-snapshot: index lock ${path.join(f.out, "index.json.lock")} is held by ${who} for over ${ms} ms; a lock is never taken over: once no bake writes ${f.out}, remove it and rerun (the .snapz is in place, the index is not updated)`;
const UNINDEXED = /^bake-snapshot: unindexed entry (\{.*\})$/;
const deadPid = () => { const r = spawnSync(process.execPath, ["-e", "0"]); assert.equal(r.status, 0); return r.pid; };

// ---------- the contract ----------

test("--help prints the help (exit 0) before any side effect; a missing --lib, --work or --out is the usage line (exit 2)", () => {
  const f = fixture();
  const before = tree(f.root);
  for (const h of ["--help", "-h"]) {
    const r = spawnSync(process.execPath, [BAKE, ...argsOf(f), h], { encoding: "utf8", env: ENV });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^usage: bake-snapshot\.mjs --lib <olean tree> --work <dir> --out <dir> /);
    for (const flag of ["--entry-fields <json object>", "--reap-quiet-ms <ms>", "--reap-stable-ms <ms>", "--allow-legacy-imports", "PATH, HOME and TMPDIR", "LEAN4_WASM64_BAKE_LOCK_WAIT_MS", "QED64_BAKE_LOCK_WAIT_MS", "128+n"]) assert.ok(r.stdout.includes(flag), flag);
    assert.doesNotMatch(r.stdout, /QED64_RUNNER/);
    assertNoReserved(r.stdout);
  }
  for (const missing of ["lib", "work", "out"]) {
    const r = bake(f, { [missing]: null });
    assert.equal(r.status, 2);
    assert.deepEqual(r.err.length, 1);
    assert.match(r.err[0], /^usage: bake-snapshot\.mjs --lib <olean tree> --work <dir> --out <dir> /);
    assert.equal(r.stdout, "");
  }
  // an unknown flag is a WARNING and ignored (the shared contract), then the refusal of what is missing
  const r = bake(f, { wrok: path.join(f.root, "elsewhere"), lib: null });
  assert.equal(r.status, 2);
  assert.deepEqual(r.err.slice(0, 1), ["bake-snapshot: WARNING — unknown flag --wrok ignored"]);
  assert.deepEqual(tree(f.root), before);
});

test("every refusal before the runner exits 2 with one line and leaves the filesystem as it found it", () => {
  const cases = [
    ["no artifact anywhere", (f) => ({ over: { artifact: null }, line: "bake-snapshot: no runtime artifact — pass --artifact <dir> (bin/lean.js, bin/lean.wasm) or set LEAN4_WASM64_ARTIFACT" })],
    ["no lean.wasm under --artifact", (f) => { const a = path.join(f.root, "no-wasm"); fs.mkdirSync(path.join(a, "bin"), { recursive: true }); return { over: { artifact: a }, line: `bake-snapshot: no lean.wasm under ${a} — pass --artifact <stage1 dir>`, marker: "no-artifact" }; }],
    ["$LEAN4_WASM64_ARTIFACT is the artifact without --artifact", (f) => ({ over: { artifact: null }, env: { LEAN4_WASM64_ARTIFACT: path.join(f.root, "env-a"), QED64_LEAN_ARTIFACT: path.join(f.root, "env-q") }, line: `bake-snapshot: no lean.wasm under ${path.join(f.root, "env-a")} — pass --artifact <stage1 dir>`, marker: "no-artifact" })],
    ["then $QED64_LEAN_ARTIFACT", (f) => ({ over: { artifact: null }, env: { QED64_LEAN_ARTIFACT: path.join(f.root, "env-q") }, line: `bake-snapshot: no lean.wasm under ${path.join(f.root, "env-q")} — pass --artifact <stage1 dir>`, marker: "no-artifact" })],
    ["--name ../x", () => ({ over: { name: "../x" }, line: 'bake-snapshot: refusing --name "../x": expected ^[A-Za-z0-9][A-Za-z0-9._-]*$ (it names <work>/<name>.snap, the .snapz and the index entry)' })],
    ["--name .x", () => ({ over: { name: ".x" }, re: /^bake-snapshot: refusing --name "\.x": / })],
    ["no --lib tree", (f) => ({ over: { lib: path.join(f.root, "no-lib") }, line: `bake-snapshot: no olean tree ${path.join(f.root, "no-lib")} — pass --lib <olean tree> (the tree mounted at /lib/lean)` })],
    ["no runner script", (f) => ({ over: { runner: path.join(f.root, "no-runner.mjs") }, line: `bake-snapshot: runner script ${path.join(f.root, "no-runner.mjs")} not found — pass --runner <script>` })],
    ["--roots", () => ({ over: { roots: "1A,B" }, line: 'bake-snapshot: refusing --roots "1A,B": expected comma-separated module roots (e.g. Mathlib,ProofWidgets)' })],
    ["--initial-bytes", () => ({ over: { "initial-bytes": "0" }, line: 'bake-snapshot: refusing --initial-bytes "0": expected a positive whole number of bytes' })],
    ["--entry-fields not an object", () => ({ over: { "entry-fields": "[1]" }, re: /^bake-snapshot: refusing --entry-fields "\[1\]": expected a JSON object$/ })],
    ["--entry-fields not JSON", () => ({ over: { "entry-fields": "{x:1}" }, re: /^bake-snapshot: refusing --entry-fields "\{x:1\}": expected a JSON object \(it is not JSON\)$/ })],
    ["--entry-fields a core key", () => ({ over: { "entry-fields": '{"runtime":"x"}' }, re: /"runtime" is a core entry key/ })],
    ["--entry-fields an alias key", () => ({ over: { "entry-fields": '{"label":"x"}' }, re: /"label" goes through --label/ })],
    ["--entry-fields a reserved key", () => ({ over: { "entry-fields": '{"bakedBy":"x"}' }, re: /"bakedBy" is reserved for lean4-wasm64/ })],
    ["--reserve", () => ({ over: { reserve: "3.5GiB" }, line: 'bake-snapshot: refusing --reserve "3.5GiB": expected a whole number of bytes' })],
    ["--reap-quiet-ms", () => ({ over: { "reap-quiet-ms": "-1" }, line: 'bake-snapshot: refusing --reap-quiet-ms "-1": expected a whole number of milliseconds' })],
    ["--reap-stable-ms", () => ({ over: { "reap-stable-ms": "2m" }, line: 'bake-snapshot: refusing --reap-stable-ms "2m": expected a whole number of milliseconds' })],
    ["a probe header with a tab", () => ({ over: { probe: "import Mathlib\n\t#check 1" }, line: "bake-snapshot: refusing --probe: a tab at 2:1 in its header: Lean rejects that header and saves no snapshot (formats/snapshot-index.md, imports)" })],
    ["a probe header with an unterminated comment", () => ({ over: { probe: "import A\n/- open" }, re: /^bake-snapshot: refusing --probe: an unterminated comment at 2:1 in its header: / })],
    ["a probe import without a module", () => ({ over: { probe: "import\n#check 1" }, re: /^bake-snapshot: refusing --probe: an import without a module name at 2:1 in its header: / })],
    ["a probe `public import` without `module`", () => ({ over: { probe: "public import A" }, re: /^bake-snapshot: refusing --probe: `public import` without `module` at 1:1 in its header: / })],
    ["a --work that cannot be created (a file in its path)", (f) => { write(path.join(f.root, "afile"), "x"); const w = path.join(f.root, "afile", "w"); return { over: { work: w }, line: `bake-snapshot: cannot create --work ${w} (ENOTDIR)` }; }],
    ["a --work that fails part-way: the directories made are removed", (f) => {
      const pre = path.join(f.root, "deny-mkdir.mjs");
      write(pre, `import fs from "node:fs";\nimport path from "node:path";\nconst mk = fs.mkdirSync;\nfs.mkdirSync = (d, o) => { if (path.basename(String(d)) === "deny") { const e = new Error("EACCES: permission denied, mkdir"); e.code = "EACCES"; throw e; } return mk(d, o); };\n`);
      const w = path.join(f.root, "a", "b", "deny", "w");
      return { over: { work: w }, env: { NODE_OPTIONS: `--import ${pathToFileURL(pre).href}` }, line: `bake-snapshot: cannot create --work ${w} (EACCES)` };
    }],
    ["--work is a file", (f) => { write(f.work, "x"); return { line: `bake-snapshot: --work ${f.work} is not a directory` }; }],
    ["--out is a file", (f) => { write(f.out, "x"); return { line: `bake-snapshot: --out ${f.out} is not a directory` }; }],
    ["a corrupt index (refused, not replaced)", (f) => { writeIndex(f, null, '{"schema": "qed64.snapshot-index/v1", "snapshots": ['); return { line: `bake-snapshot: ${path.join(f.out, "index.json")} is not a snapshot index: it is not JSON — refusing to replace it` }; }],
    ["another schema", (f) => { writeIndex(f, null, JSON.stringify({ schema: "qed64.snapshot-index/v2", snapshots: [] })); return { re: /is not a snapshot index: its schema is "qed64\.snapshot-index\/v2", not qed64\.snapshot-index\/v1 — refusing to replace it$/ }; }],
    ["no snapshots array", (f) => { writeIndex(f, null, JSON.stringify({ schema: SCHEMA })); return { re: /is not a snapshot index: it has no snapshots array — refusing to replace it$/ }; }],
    ["an unreadable index (a directory)", (f) => { fs.mkdirSync(path.join(f.out, "index.json", "blocker"), { recursive: true }); return { line: `bake-snapshot: cannot read ${path.join(f.out, "index.json")} (EISDIR) — refusing to replace it` }; }],
    ["a foreign sibling", (f) => { writeIndex(f, [{ name: "mathlib", url: "/snapshots/m.snapz", runtime: OTHER }]); return { line: `bake-snapshot: ${path.join(f.out, "index.json")} already holds entries for runtime ${OTHER} (mathlib) — refusing to mix pairings`, marker: "refuse-foreign" }; }],
    ["an unpaired sibling", (f) => { writeIndex(f, [{ name: "mathlib", url: "/snapshots/m.snapz" }, { name: "init", url: "/snapshots/i.snapz" }]); return { re: /no runtime pairing \(mathlib\) — rebake --name mathlib against this runtime first, or bake into an empty --out /, marker: "refuse-unpaired" }; }],
  ];
  for (const [label, setup] of cases) {
    const f = fixture();
    const c = setup(f);
    const before = tree(f.root);
    const r = bake({ ...f, ...(c.over?.work ? { work: c.over.work } : {}) }, c.over, { env: c.env });
    assert.equal(r.status, 2, `${label}: ${r.stderr}${r.stdout}`);
    assert.equal(r.stdout, "", label);
    assert.equal(r.err.length, 1, `${label}: ${r.stderr}`);
    if (c.line) assert.equal(r.err[0], c.line, label);
    if (c.re) assert.match(r.err[0], c.re, label);
    assert.deepEqual(markersOf(r.err[0]), c.marker ? [c.marker] : [], label);
    assertNoReserved(r.stderr);
    assert.deepEqual(tree(f.root), before, `${label} touched the filesystem`);
  }
});

// ---------- byte identity ----------

test("a bake: the runner's argv, stack and Node; probe.lean; the .snapz named from its bytes (QED64's gzip stream); index.json and its copy; the kept lines", async () => {
  const f = fixture();
  const r = bake(f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
  // the runner: <this node> --stack-size=8192 <runner> --work <abs> --artifact <abs> --lib <tree> -- …
  const rec = recorded(f);
  assert.deepEqual(rec.argv, ["--work", f.work, "--artifact", f.art, "--lib", f.lib, "--", "--incr-header-save=/work/init.snap", "/work/probe.lean"]);
  assert.deepEqual(rec.execArgv, ["--stack-size=8192"]);
  assert.equal(rec.execPath, process.execPath);
  assert.equal(fs.readFileSync(path.join(f.work, "probe.lean"), "utf8"), "#check (2 + 2 : Nat)\n");
  // the .snapz: QED64's stream over the raw bytes the runner wrote, named by its sha256
  const snap = fs.readFileSync(path.join(f.work, "init.snap"));
  const gz = await gzipAsQed64(path.join(f.work, "init.snap"));
  const digest = sha256(gz);
  const gzName = `init.${digest.slice(0, 16)}.snapz`;
  assert.deepEqual(snapzOf(f), [gzName]);
  assert.deepEqual(fs.readFileSync(path.join(f.out, gzName)), gz);
  assert.deepEqual(gunzipSync(gz), snap);
  // index.json: JSON.stringify(index, null, 2), no trailing newline; the copy has its bytes
  const entry = { name: "init", url: `/snapshots/${gzName}`, digest: `sha256:${digest}`, bytes: snap.length, transfer: gz.length, imports: [], runtime: f.id };
  const text = fs.readFileSync(path.join(f.out, "index.json"), "utf8");
  assert.equal(text, JSON.stringify({ schema: SCHEMA, snapshots: [entry] }, null, 2));
  assert.deepEqual(fs.readFileSync(path.join(f.out, `index.${f.id}.json`)), fs.readFileSync(path.join(f.out, "index.json")));
  assert.deepEqual(fs.readdirSync(f.out).sort(), [gzName, `index.${f.id}.json`, "index.json"].sort());
  // --work keeps the raw .snap and probe.lean; its lock is gone
  assert.deepEqual(fs.readdirSync(f.work).sort(), ["init.snap", "probe.lean", "runner.json", "runner.pid"]);
  // the kept lines, in QED64's order, plus the build-environment line outside every marker
  const gzPath = path.join(f.out, gzName);
  assert.deepEqual(r.out, [
    `baking init.snap for runtime ${f.id} (probe: "#check (2 + 2 : Nat)"; compactor reserve 3.5 GiB) → ${f.out}`,
    `build environment: node ${process.version}, zlib ${process.versions.zlib}, shared zlib ${process.config.variables.node_shared_zlib}`,
    "compressing init.snapz …",
    `baked ${gzPath} (${gz.length} bytes transfer, ${snap.length} raw); index updated (imports: [], runtime ${f.id})`,
    `index copy ${path.join(f.out, `index.${f.id}.json`)} written (runtime ${f.id})`,
  ]);
  assert.deepEqual(r.out.map(markersOf), [["baking"], [], ["compressing"], ["baked"], ["index-copy"]]);
  assert.deepEqual(MARKERS.baking.exec(r.out[0]).slice(1), ["init", f.id, '"#check (2 + 2 : Nat)"', "3.5", f.out]);
  assert.deepEqual(MARKERS.baked.exec(r.out[3]).slice(1), [gzPath, "init", digest.slice(0, 16), String(gz.length), String(snap.length), "", f.id]);
  assert.deepEqual(MARKERS["index-copy"].exec(r.out[4]).slice(2), [f.id, f.id]);
  assertNoReserved(r.stdout);
});

test("upsert through the bake: a sibling appends, a rebake replaces and moves to the end, its older .snapz stays, another runtime's copy is never touched", () => {
  const f = fixture();
  fs.mkdirSync(f.out);
  const otherCopy = path.join(f.out, `index.${OTHER}.json`);
  fs.writeFileSync(otherCopy, "another runtime's copy: never touched");
  assert.equal(bake(f, { name: "init" }).status, 0);
  const first = snapzOf(f);
  const m = bake(f, { name: "mathlib", probe: probeWith({ bytes: 200_000 }, "import Mathlib\n") });
  assert.equal(m.status, 0, m.stderr);
  const again = bake(f, { name: "init", probe: probeWith({ seed: 99 }) }); // other bytes: another .snapz
  assert.equal(again.status, 0, again.stderr);
  const index = readIndexFile(f);
  assert.deepEqual(index.snapshots.map((e) => [e.name, e.runtime]), [["mathlib", f.id], ["init", f.id]]);
  assert.deepEqual(index.snapshots[0].imports, ["Mathlib"]);
  const snapz = snapzOf(f);
  assert.equal(snapz.length, 3);
  for (const old of first) assert.ok(snapz.includes(old)); // additive: never unlinked
  const init = index.snapshots[1];
  const bytes = fs.readFileSync(path.join(f.out, path.basename(init.url)));
  assert.equal(init.digest, `sha256:${sha256(bytes)}`);
  assert.equal(path.basename(init.url), `init.${sha256(bytes).slice(0, 16)}.snapz`);
  assert.equal(init.transfer, bytes.length);
  assert.equal(init.bytes, fs.statSync(path.join(f.work, "init.snap")).size);
  assert.deepEqual(fs.readFileSync(path.join(f.out, `index.${f.id}.json`)), fs.readFileSync(path.join(f.out, "index.json")));
  assert.equal(fs.readFileSync(otherCopy, "utf8"), "another runtime's copy: never touched");
  assert.deepEqual(fs.readdirSync(f.out).filter((x) => !x.endsWith(".snapz")).sort(), [`index.${OTHER}.json`, `index.${f.id}.json`, "index.json"].sort());
});

test("--roots, --label, --initial-bytes and --entry-fields: the entry's key order; `import all X` records X", () => {
  const f = fixture();
  const probe = probeWith({}, "module\nimport all Mathlib.Data\npublic meta import Foo.Bar\nprivate import Baz\n");
  const r = bake(f, { roots: "Game, GameServer.Runner", label: "Robo", "initial-bytes": "4294967296", "entry-fields": '{"zeta":1,"page":{"tile":true},"alpha":"a"}', probe });
  assert.equal(r.status, 0, r.stderr);
  const [e] = readIndexFile(f).snapshots;
  assert.deepEqual(Object.keys(e), ["name", "url", "digest", "bytes", "transfer", "imports", "runtime", "roots", "label", "initialBytes", "zeta", "page", "alpha"]);
  assert.deepEqual(e.imports, ["Mathlib.Data", "Foo.Bar"]);
  assert.deepEqual([e.roots, e.label, e.initialBytes, e.zeta, e.page, e.alpha], [["Game", "GameServer.Runner"], "Robo", 4294967296, 1, { tile: true }, "a"]);
  const baked = r.out.find((l) => MARKERS.baked.test(l));
  assert.equal(MARKERS.baked.exec(baked)[6], "Mathlib.Data, Foo.Bar");
  assert.equal(fs.readFileSync(path.join(f.work, "probe.lean"), "utf8"), `${probe}\n`);
  // --entry-fields alone, after the core keys
  const g = fixture();
  assert.equal(bake(g, { "entry-fields": '{"x":[1]}' }).status, 0);
  assert.deepEqual(Object.keys(readIndexFile(g).snapshots[0]), ["name", "url", "digest", "bytes", "transfer", "imports", "runtime", "x"]);
});

// ---------- the runner: environment, Node, script ----------

test("the runner's environment is exactly PATH, HOME, TMPDIR, LEAN_COMPACTOR_RESERVE (+ QED64_ALLOW_LEGACY_IMPORTS=1 when asked, QED64_PROFILE_INIT when non-empty)", () => {
  const foreign = { LEAN_PATH: "/foreign/lean", LEAN4_WASM64_CWD: "work", QED64_RUNNER: "/nope.mjs", LEAN4_WASM64_PTHREAD_STACK_MB: "1", LEAN_WASM_STACK_PROBE_SLOTS: "0", FOO: "bar", NODE_OPTIONS: "--no-deprecation" };
  // macOS adds __CF_USER_TEXT_ENCODING to every process it starts; it is not inherited from the bake
  const envOf = (f) => { const e = { ...recorded(f).env }; delete e.__CF_USER_TEXT_ENCODING; return e; };
  const base = {};
  for (const k of ["PATH", "HOME", "TMPDIR"]) if (ENV[k] !== undefined) base[k] = ENV[k];
  let f = fixture();
  let r = bake(f, {}, { env: foreign });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(envOf(f), { ...base, LEAN_COMPACTOR_RESERVE: "3758096384" });
  f = fixture();
  r = bake(f, { reserve: "1073741824", "allow-legacy-imports": true }, { env: foreign });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(envOf(f), { ...base, LEAN_COMPACTOR_RESERVE: "1073741824", QED64_ALLOW_LEGACY_IMPORTS: "1" });
  assert.match(r.out[0], /; compactor reserve 1\.0 GiB\) → /);
  f = fixture();
  r = bake(f, {}, { env: { QED64_ALLOW_LEGACY_IMPORTS: "yes" } }); // inherited: the same gate, as 1
  assert.equal(r.status, 0, r.stderr);
  assert.equal(envOf(f).QED64_ALLOW_LEGACY_IMPORTS, "1");
  f = fixture();
  r = bake(f, {}, { env: { ...foreign, QED64_ALLOW_LEGACY_IMPORTS: "" } }); // inherited but empty: the gate stays off
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(envOf(f), { ...base, LEAN_COMPACTOR_RESERVE: "3758096384" });
  f = fixture();
  r = bake(f, {}, { env: { ...foreign, QED64_PROFILE_INIT: "phases, x=1" } }); // passed through unchanged when non-empty
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(envOf(f), { ...base, LEAN_COMPACTOR_RESERVE: "3758096384", QED64_PROFILE_INIT: "phases, x=1" });
});

test("the runner is this Node (not PATH's) with --stack-size=8192; --runner resolves against the cwd", () => {
  const f = fixture();
  const fakeBin = path.join(f.root, "fake-bin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "node"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  const r = bake(f, {}, { env: { PATH: fakeBin } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(recorded(f).execPath, process.execPath);
  const g = fixture();
  const rel = bake(g, { runner: path.basename(RUNNER) }, { cwd: path.dirname(RUNNER) });
  assert.equal(rel.status, 0, rel.stderr);
  assert.equal(recorded(g).argv[0], "--work");
});

test("the default runner is this package's node-runner.mjs (QED64_RUNNER is not read): it boots the artifact's lean.js on the bake's argv", () => {
  const f = fixture();
  // a lean.js the package runner loads (vm.runInThisContext): it writes the .snap the save argument names
  fs.writeFileSync(path.join(f.art, "bin", "lean.js"), `const fs = require("fs"), path = require("path");
const work = process.argv[process.argv.indexOf("--work") + 1];
const save = globalThis.Module.arguments.find((x) => x.startsWith("--incr-header-save=")).split("=")[1].replace(/^\\/work\\//, "");
fs.writeFileSync(path.join(work, save), "a raw region from the package runner");
fs.writeFileSync(path.join(work, "lean-js.json"), JSON.stringify({ args: globalThis.Module.arguments, leanPath: process.env.LEAN_PATH, execArgv: process.execArgv, argv: process.argv.slice(2) }));
process.exit(0);
`);
  const qedRunner = path.join(f.root, "qed64-runner.mjs");
  fs.writeFileSync(qedRunner, 'require("fs").writeFileSync("/never", "");\n');
  const r = bake(f, { runner: null }, { env: { QED64_RUNNER: qedRunner, LEAN_PATH: "/foreign/lean" } });
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(fs.readFileSync(path.join(f.work, "lean-js.json"), "utf8"));
  assert.deepEqual(seen.args, ["--incr-header-save=/work/init.snap", "/work/probe.lean"]);
  // the package's own runner, and only it, gets --exit-with-parent (another runner would hand it to Lean)
  assert.deepEqual(seen.argv.slice(0, 2), ["--exit-with-parent", "--parent-pid"]);
  assert.match(seen.argv[2], /^[1-9]\d*$/); // the bake's own pid
  assert.deepEqual(seen.argv.slice(3), ["--work", f.work, "--artifact", f.art, "--lib", f.lib, "--", "--incr-header-save=/work/init.snap", "/work/probe.lean"]);
  assert.equal(seen.leanPath, "/lib/lean");
  assert.deepEqual(seen.execArgv, ["--stack-size=8192"]);
  assert.equal(fs.readFileSync(path.join(f.work, "init.snap"), "utf8"), "a raw region from the package runner");
  assert.equal(readIndexFile(f).snapshots[0].bytes, "a raw region from the package runner".length);
});

// ---------- signals and the runner's fate ----------

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  test(`${sig} to the bake is forwarded to the runner: exit 128+n, no runner left, nothing compressed, no index write`, async () => {
    const f = fixture();
    writeIndex(f, [{ name: "mathlib", url: "/snapshots/m.snapz", runtime: "x" }].map((e) => ({ ...e, runtime: f.id })));
    const indexBefore = fs.readFileSync(path.join(f.out, "index.json"));
    const b = bakeAsync(f, { probe: probeWith({ wedge: true }) });
    let pid = null;
    try {
      await waitFor(() => fs.existsSync(path.join(f.work, "runner.pid")), "the runner");
      pid = runnerPid(f);
      assert.ok(alive(pid));
      b.p.kill(sig);
      const { code, signal } = await b.closed;
      assert.equal(signal, null);
      assert.equal(code, 128 + os.constants.signals[sig]);
      await waitFor(() => !alive(pid), `runner ${pid} to die`, 3000);
    } finally {
      if (pid && alive(pid)) process.kill(pid, "SIGKILL"); // only the PID this test recorded
      if (b.p.exitCode === null && b.p.signalCode === null) b.p.kill("SIGKILL");
    }
    assert.deepEqual(snapzOf(f), []);
    assert.deepEqual(fs.readdirSync(f.out), ["index.json"]);
    assert.deepEqual(fs.readFileSync(path.join(f.out, "index.json")), indexBefore);
    assert.equal(fs.existsSync(workLockOf(f)), false);
    assert.doesNotMatch(b.stdout(), /^(compressing|baked|index copy) /m);
  });
}

test("a runner that ignores SIGTERM: a second signal to the bake SIGKILLs it (exit 143)", async () => {
  const f = fixture();
  const b = bakeAsync(f, { probe: probeWith({ wedge: true, ignoreTerm: true }) });
  let pid = null;
  try {
    await waitFor(() => fs.existsSync(path.join(f.work, "runner.pid")), "the runner");
    pid = runnerPid(f);
    b.p.kill("SIGTERM");
    await sleep(300);
    assert.ok(alive(pid), "the runner ignored SIGTERM");
    assert.equal(b.p.exitCode, null);
    b.p.kill("SIGTERM");
    const { code } = await b.closed;
    assert.equal(code, 143);
    await waitFor(() => !alive(pid), `runner ${pid} to die`, 3000);
  } finally {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    if (b.p.exitCode === null && b.p.signalCode === null) b.p.kill("SIGKILL");
  }
  assert.equal(fs.existsSync(f.out), false);
});

test("a runner that writes a partial .snap and dies by a signal the bake did not send: exit 1, nothing compressed, the index unchanged", () => {
  const f = fixture();
  writeIndex(f, [{ name: "mathlib", url: "/snapshots/m.snapz", runtime: f.id }]);
  const before = fs.readFileSync(path.join(f.out, "index.json"));
  const r = bake(f, { probe: probeWith({ snap: "a partial reg", kill: "SIGKILL" }) });
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(r.err, ["bake-snapshot: the runner was killed by SIGKILL, a signal this bake did not send — nothing compressed, the index is not written"]);
  assert.deepEqual(fs.readdirSync(f.out), ["index.json"]);
  assert.deepEqual(fs.readFileSync(path.join(f.out, "index.json")), before);
  assert.equal(fs.existsSync(workLockOf(f)), false);
});

test("a runner that exits non-zero is exit 1; one that exits 0 without a .snap is the no-snap line (exit 1); neither writes --out", () => {
  let f = fixture();
  let r = bake(f, { probe: probeWith({ exit: 3 }) });
  assert.equal(r.status, 1);
  assert.deepEqual(r.err, ["bake-snapshot: runner exited 3"]);
  assert.equal(fs.existsSync(f.out), false);
  f = fixture();
  r = bake(f, { probe: probeWith({ snap: null }) });
  assert.equal(r.status, 1);
  assert.deepEqual(r.err, ["FAIL: snapshot file was not produced"]);
  assert.deepEqual(markersOf(r.err[0]), ["no-snap"]);
  assert.equal(fs.existsSync(f.out), false);
});

test("a wedged runner (the save done, the exit never coming) is reaped once quiet and stable: exit 0, the index written", async () => {
  const f = fixture();
  const r = bake(f, { probe: probeWith({ wedge: true }), "reap-quiet-ms": "300", "reap-stable-ms": "300" });
  assert.equal(r.status, 0, r.stderr);
  const size = fs.statSync(path.join(f.work, "init.snap")).size;
  const reaped = r.out.filter((l) => MARKERS.reaped.test(l));
  assert.deepEqual(reaped, [`bake output stable (${size} bytes) with runner quiet — reaping the wedged exit`]);
  assert.ok(r.out.indexOf(reaped[0]) < r.out.indexOf("compressing init.snapz …"));
  const pid = runnerPid(f);
  await waitFor(() => !alive(pid), `runner ${pid} to die`, 3000);
  assert.equal(readIndexFile(f).snapshots[0].bytes, size);
  assert.deepEqual(fs.readFileSync(path.join(f.out, `index.${f.id}.json`)), fs.readFileSync(path.join(f.out, "index.json")));
});

test("a runner that floods stdout is not killed: no output buffer limit, and never reaped while it prints", () => {
  const f = fixture();
  const log = path.join(tmp(), "bake.log");
  const fd = fs.openSync(log, "w");
  let r;
  try {
    r = bake(f, { probe: probeWith({ flood: 72 << 20, floodMs: 6000 }), "reap-quiet-ms": "2000", "reap-stable-ms": "100" }, { stdout: fd });
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(f.work, "flood.done")), true, "the runner finished its flood (not reaped mid-flood)");
  const sent = Number(fs.readFileSync(path.join(f.work, "flood.done"), "utf8"));
  assert.ok(sent >= 72 << 20, `flooded ${sent} bytes`);
  assert.ok(fs.statSync(log).size > 64 << 20, "more than QED64's execFile maxBuffer reached the bake's stdout");
  const bytes = fs.readFileSync(log); // a Buffer: the log is too big for one string
  const lineAt = (marker) => { const at = bytes.indexOf(`\n${marker}`); return at < 0 ? null : bytes.subarray(at + 1, bytes.indexOf("\n", at + 1)).toString(); };
  assert.equal(lineAt("bake output stable "), null);
  assert.ok(!bytes.subarray(0, 32).toString().startsWith("bake output stable "));
  assert.match(lineAt("baked "), MARKERS.baked);
  assert.equal(readIndexFile(f).snapshots[0].bytes, fs.statSync(path.join(f.work, "init.snap")).size);
});

// ---------- one bake per --work ----------

test("two bakes on one --work: the second is refused (exit 2) naming the first's pids, and changes nothing", async () => {
  const f = fixture();
  const b = bakeAsync(f, { probe: probeWith({ wedge: true }) });
  let pid = null;
  try {
    await waitFor(() => fs.existsSync(path.join(f.work, "runner.pid")), "the first bake's runner");
    pid = runnerPid(f);
    await waitFor(() => fs.readFileSync(workLockOf(f), "utf8").split("\n").length === 3, "the runner's pid in the lock");
    assert.equal(fs.readFileSync(workLockOf(f), "utf8"), `${b.p.pid}\n${pid}\n`); // the runner joins the bake
    write(path.join(f.work, "other.snap.tmp.42"), "the first bake's business"); // a refused bake removes nothing
    const before = tree(f.root);
    const second = bake({ ...f, out: path.join(f.root, "out2") }, { name: "other" });
    assert.equal(second.status, 2, second.stderr);
    assert.equal(second.stdout, "");
    assert.deepEqual(second.err, [workRefusal(f, `bake pid ${b.p.pid} (running on this host) and runner pid ${pid} (running on this host)`)]);
    assert.deepEqual(tree(f.root), before);
    b.p.kill("SIGTERM");
    assert.equal((await b.closed).code, 143);
    assert.equal(fs.existsSync(workLockOf(f)), false); // released on the bake's own signal handling
  } finally {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    if (b.p.exitCode === null && b.p.signalCode === null) b.p.kill("SIGKILL");
  }
});

test("--work's lock is never taken over: running, dead, unreadable or old, it refuses (exit 2, nothing changed); removed, the bake runs", () => {
  const f = fixture();
  const lock = workLockOf(f);
  const dead = deadPid();
  const holders = [
    [`${process.pid}\n`, `bake pid ${process.pid} (running on this host)`],
    [`${dead}\n`, `bake pid ${dead} (not running on this host)`],
    [`${dead}\n${dead}\n`, `bake pid ${dead} (not running on this host) and runner pid ${dead} (not running on this host)`],
    ["", 'a holder it cannot read ("")'],
    [`${JSON.stringify({ pid: dead, host: os.hostname() })}\n`, `a holder it cannot read (${JSON.stringify(`${JSON.stringify({ pid: dead, host: os.hostname() })}\n`)})`],
  ];
  write(path.join(f.work, "init.snap.tmp.42"), "a running bake's save"); // removed only by a bake that holds the lock
  for (const [text, who] of holders) {
    write(lock, text);
    ago(lock, 10 * 60_000);
    const before = tree(f.root);
    const t0 = Date.now();
    const r = bake(f);
    assert.ok(Date.now() - t0 < 5000, "refused at once, not after a wait");
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, "");
    assert.deepEqual(r.err, [workRefusal(f, who)]);
    assert.deepEqual(tree(f.root), before);
  }
  // removed by whoever knows no bake uses --work: the next bake runs; stale <name>.snap.tmp.* go at its start
  // a dangling symbolic link is a holder it cannot read, not a lock released on every read
  fs.rmSync(lock);
  fs.symlinkSync(path.join(f.root, "nowhere"), lock);
  const before = tree(f.root);
  const d = bake(f);
  assert.equal(d.status, 2, d.stderr);
  assert.deepEqual(d.err, [workRefusal(f, "a holder it cannot read (read failed: ELOOP)")]);
  assert.deepEqual(tree(f.root), before);
  fs.rmSync(lock);
  for (const t of ["init.snap.tmp.42", "init.snap.tmp.7", "mathlib.snap.tmp.42"]) write(path.join(f.work, t), "a killed save");
  const s = bake(f);
  assert.equal(s.status, 0, s.stderr);
  assert.deepEqual(s.err, []);
  assert.ok(s.out.includes(`removed the stale ${path.join(f.work, "init.snap.tmp.42")} (an interrupted save's temp file)`));
  assert.deepEqual(fs.readdirSync(f.work).filter((x) => x.includes(".snap.tmp.")), ["mathlib.snap.tmp.42"]);
  assert.equal(fs.existsSync(lock), false);
  for (const l of [...s.out, ...s.err]) assert.ok(markersOf(l).length <= 1);
  assertNoReserved(s.stdout + s.stderr);
});

test("--work's lock after a SIGKILLed bake: its runner (not the package's) lives on; refused while it does, and still once it is dead", async () => {
  const f = fixture();
  const b = bakeAsync(f, { probe: probeWith({ wedge: true }) });
  let pid = null;
  const lock = workLockOf(f);
  try {
    await waitFor(() => fs.existsSync(path.join(f.work, "runner.pid")), "the runner");
    pid = runnerPid(f);
    await waitFor(() => fs.readFileSync(lock, "utf8") === `${b.p.pid}\n${pid}\n`, "the runner's pid in the lock");
    b.p.kill("SIGKILL"); // the bake cannot pass this on, and this fake runner has no --exit-with-parent
    await b.closed;
    assert.ok(alive(pid));
    const before = tree(f.root);
    const r = bake(f, { name: "other" });
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(r.err, [workRefusal(f, `bake pid ${b.p.pid} (not running on this host) and runner pid ${pid} (running on this host)`)]);
    assert.deepEqual(tree(f.root), before);
    process.kill(pid, "SIGKILL"); // only the PID this test recorded
    await waitFor(() => !alive(pid), `runner ${pid} to die`, 3000);
    const s = bake(f, { name: "other" });
    assert.equal(s.status, 2, s.stderr);
    assert.deepEqual(s.err, [workRefusal(f, `bake pid ${b.p.pid} (not running on this host) and runner pid ${pid} (not running on this host)`)]);
    assert.equal(fs.readFileSync(lock, "utf8"), `${b.p.pid}\n${pid}\n`);
    fs.rmSync(lock); // the caller's decision once every pid reads "not running"
    const t = bake(f, { name: "other" });
    assert.equal(t.status, 0, t.stderr);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    if (b.p.exitCode === null && b.p.signalCode === null) b.p.kill("SIGKILL");
  }
});

test("--exit-with-parent: the package's runner of a SIGKILLed bake exits by itself; the lock stays, naming both as not running", async () => {
  const f = fixture();
  // a lean.js the package runner loads: it saves the .snap, records the runner's pid, then never exits (patch 0031's wedge)
  fs.writeFileSync(path.join(f.art, "bin", "lean.js"), `const fs = require("fs"), path = require("path");
const work = process.argv[process.argv.indexOf("--work") + 1];
fs.writeFileSync(path.join(work, "init.snap"), "a raw region");
fs.writeFileSync(path.join(work, "runner.pid"), String(process.pid));
setInterval(() => {}, 1000);
setTimeout(() => process.exit(9), 30_000); // never outlives a failed test by long
`);
  const b = bakeAsync(f, { runner: null });
  let pid = null;
  try {
    await waitFor(() => fs.existsSync(path.join(f.work, "runner.pid")), "the package runner");
    pid = runnerPid(f);
    await waitFor(() => fs.readFileSync(workLockOf(f), "utf8") === `${b.p.pid}\n${pid}\n`, "the runner's pid in the lock");
    b.p.kill("SIGKILL");
    await b.closed;
    await waitFor(() => !alive(pid), `runner ${pid} to exit with its parent`, 5000);
  } finally {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    if (b.p.exitCode === null && b.p.signalCode === null) b.p.kill("SIGKILL");
  }
  const r = bake(f, { runner: null });
  assert.equal(r.status, 2);
  assert.deepEqual(r.err, [workRefusal(f, `bake pid ${b.p.pid} (not running on this host) and runner pid ${pid} (not running on this host)`)]);
});

test("--exit-with-parent --parent-pid: a parent SIGKILLed before the runner's Node has even started is seen at once", async () => {
  const f = fixture();
  const loaded = path.join(f.root, "lean-js-loaded");
  fs.writeFileSync(path.join(f.art, "bin", "lean.js"), `require("fs").writeFileSync(${JSON.stringify(loaded)}, "");\nsetInterval(() => {}, 1000);\nsetTimeout(() => process.exit(9), 30_000);\n`);
  const parentScript = path.join(f.root, "parent.mjs");
  fs.writeFileSync(parentScript, `import { spawn } from "node:child_process";
import fs from "node:fs";
const c = spawn(process.execPath, ["--stack-size=8192", ${JSON.stringify(path.join(pkg, "node-runner.mjs"))}, "--exit-with-parent", "--parent-pid", String(process.pid),
  "--artifact", ${JSON.stringify(f.art)}, "--lib", ${JSON.stringify(f.lib)}, "--work", ${JSON.stringify(f.work)}, "--", "/work/x.lean"], { stdio: "ignore", detached: false });
fs.writeFileSync(${JSON.stringify(path.join(f.root, "runner.pid"))}, String(c.pid));
process.kill(process.pid, "SIGKILL"); // at once: the runner's Node is still starting
`);
  const r = spawnSync(process.execPath, [parentScript]);
  assert.equal(r.signal, "SIGKILL");
  const pid = Number(fs.readFileSync(path.join(f.root, "runner.pid"), "utf8"));
  try {
    await waitFor(() => !alive(pid), `runner ${pid} to see its parent gone`, 10_000);
  } finally {
    if (alive(pid)) process.kill(pid, "SIGKILL"); // only the PID this test recorded
  }
  assert.equal(fs.existsSync(loaded), false, "seen at once: before the runtime was ever loaded");
});

test("node-runner --parent-pid: not a pid, or a live process that is not its parent, is exit 2 with nothing created", () => {
  const f = fixture();
  for (const [value, line] of [
    ["abc", 'error: --parent-pid "abc" is not a pid'],
    ["0", 'error: --parent-pid "0" is not a pid'],
    ["99999999999", 'error: --parent-pid "99999999999" is not a pid'],
    ["1", `error: --parent-pid 1 is not this runner's parent (its parent is ${process.pid})`],
  ]) {
    const before = tree(f.root);
    const r = spawnSync(process.execPath, ["--stack-size=8192", path.join(pkg, "node-runner.mjs"), "--exit-with-parent", "--parent-pid", value, "--artifact", f.art, "--lib", f.lib, "--work", f.work, "--", "/work/x.lean"], { encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 2, `${value}: ${r.stderr}`);
    assert.equal(r.stderr.trim(), line);
    assert.deepEqual(tree(f.root), before, value);
  }
});

test("--exit-with-parent reaches the package's runner however --runner names it (a symbolic link to it too)", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.art, "bin", "lean.js"), `const fs = require("fs"), path = require("path");
const work = process.argv[process.argv.indexOf("--work") + 1];
fs.writeFileSync(path.join(work, "init.snap"), "a raw region");
fs.writeFileSync(path.join(work, "argv.json"), JSON.stringify(process.argv.slice(2)));
process.exit(0);
`);
  const link = path.join(f.root, "runner-link.mjs");
  fs.symlinkSync(path.join(pkg, "node-runner.mjs"), link);
  const r = bake(f, { runner: link });
  assert.equal(r.status, 0, r.stderr);
  const argv = JSON.parse(fs.readFileSync(path.join(f.work, "argv.json"), "utf8"));
  assert.deepEqual(argv.slice(0, 2), ["--exit-with-parent", "--parent-pid"]);
});

test("a closed stdout never ends a bake: the runner is drained, the bake finishes (exit 0), the lock released", async () => {
  const f = fixture();
  const p = spawn(process.execPath, [BAKE, ...argsOf(f, { probe: probeWith({ flood: 4 << 20, floodMs: 1500 }) })], { stdio: ["ignore", "pipe", "pipe"], env: ENV });
  let stderr = "";
  p.stderr.on("data", (d) => { stderr += d; });
  p.stdout.once("data", () => p.stdout.destroy()); // the reader goes away after the first line (`bake | head -1`)
  const killer = setTimeout(() => p.kill("SIGKILL"), 30_000);
  const code = await new Promise((resolve) => p.on("close", (c) => resolve(c)));
  clearTimeout(killer);
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /EPIPE|crashed|Error/);
  assert.ok(fs.existsSync(path.join(f.work, "flood.done")), "the runner was drained to the end");
  assert.equal(readIndexFile(f).snapshots[0].name, "init");
  assert.equal(fs.existsSync(workLockOf(f)), false);
});

test("a bake that crashes with its runner running kills the runner and KEEPS --work's lock (it names a process that was writing)", async () => {
  const f = fixture();
  const preload = path.join(f.root, "crash.mjs");
  fs.writeFileSync(preload, `import fs from "node:fs";
const pidFile = process.env.CRASH_AFTER;
const t = setInterval(() => { if (fs.existsSync(pidFile)) { clearInterval(t); throw new Error("injected crash"); } }, 20);
`);
  const b = bakeAsync(f, { probe: probeWith({ wedge: true }) }, { NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`, CRASH_AFTER: path.join(f.work, "runner.pid") });
  let pid = null;
  try {
    await waitFor(() => fs.existsSync(path.join(f.work, "runner.pid")), "the runner");
    pid = runnerPid(f);
    const { code } = await b.closed;
    assert.equal(code, 1, b.stderr());
    await waitFor(() => !alive(pid), `runner ${pid} to be killed`, 3000);
  } finally {
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    if (b.p.exitCode === null && b.p.signalCode === null) b.p.kill("SIGKILL");
  }
  assert.match(b.stderr(), /injected crash/);
  assert.ok(b.stderr().includes(`bake-snapshot: the bake ended with its runner (pid ${pid}) still running: killed; ${workLockOf(f)} is kept — remove it once no bake uses --work`), b.stderr());
  assert.equal(fs.readFileSync(workLockOf(f), "utf8"), `${b.p.pid}\n${pid}\n`);
  const r = bake(f);
  assert.deepEqual(r.err, [workRefusal(f, `bake pid ${b.p.pid} (not running on this host) and runner pid ${pid} (not running on this host)`)]);
});

for (const signals of [1, 2]) {
  test(`${signals === 1 ? "a SIGTERM" : "a second SIGTERM after the first was handled (process.exit, no runner)"} while the bake waits for the index lock: 143, the .snapz kept and its entry printed once, both indexes untouched, --work's lock released`, async () => {
    const f = fixture();
    writeIndex(f, [{ name: "mathlib", url: "/snapshots/m.snapz", runtime: f.id }]);
    const indexBefore = fs.readFileSync(path.join(f.out, "index.json"));
    write(path.join(f.out, "index.json.lock"), `${process.pid}\n`);
    // two signals delivered separately, deterministically: the bake's own handler, called twice in a row
    const preload = path.join(f.root, "two-signals.mjs");
    fs.writeFileSync(preload, `import fs from "node:fs";
const out = ${JSON.stringify(f.out)};
const t = setInterval(() => {
  if (!fs.readdirSync(out).some((x) => x.endsWith(".snapz"))) return;
  clearInterval(t);
  setTimeout(() => { process.emit("SIGTERM", "SIGTERM"); process.emit("SIGTERM", "SIGTERM"); }, 200);
}, 20);
t.unref();
`);
    const env = signals === 1 ? { LEAN4_WASM64_BAKE_LOCK_WAIT_MS: "60000" } : { LEAN4_WASM64_BAKE_LOCK_WAIT_MS: "60000", NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` };
    const b = bakeAsync(f, {}, env);
    try {
      await waitFor(() => snapzOf(f).length === 1, "the .snapz");
      await sleep(200);
      if (signals === 1) b.p.kill("SIGTERM");
      const { code } = await b.closed;
      assert.equal(code, 143, b.stderr());
    } finally {
      if (b.p.exitCode === null && b.p.signalCode === null) b.p.kill("SIGKILL");
    }
    const err = lines(b.stderr());
    const [gzName] = snapzOf(f);
    assert.equal(err.filter((l) => UNINDEXED.test(l)).length, 1, b.stderr());
    const entry = JSON.parse(UNINDEXED.exec(err.find((l) => UNINDEXED.test(l)))[1]);
    assert.equal(entry.url, `/snapshots/${gzName}`);
    assert.deepEqual(fs.readFileSync(path.join(f.out, "index.json")), indexBefore);
    assert.equal(fs.existsSync(path.join(f.out, `index.${f.id}.json`)), false);
    assert.equal(fs.readFileSync(path.join(f.out, "index.json.lock"), "utf8"), `${process.pid}\n`);
    assert.equal(fs.existsSync(workLockOf(f)), false);
  });
}

test("a stop signal during the checks (hashing lean.wasm) ends the bake before its first side effect: --work untouched, no runner", () => {
  const f = fixture();
  write(path.join(f.work, "init.snap"), "the previous snapshot, which the probes load");
  write(path.join(f.work, "init.snap.tmp.42"), "a temp");
  write(path.join(f.work, "probe.lean"), "the previous probe\n");
  const preload = path.join(f.root, "signal-while-hashing.mjs");
  fs.writeFileSync(preload, `import fs from "node:fs";
const open = fs.openSync;
let sent = false;
fs.openSync = (p, ...rest) => { if (!sent && String(p).endsWith("lean.wasm")) { sent = true; process.emit("SIGTERM", "SIGTERM"); } return open(p, ...rest); };
`);
  const before = tree(f.root);
  const r = bake(f, {}, { env: { NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` } });
  assert.equal(r.status, 143, r.stderr);
  assert.equal(r.stdout, "");
  assert.deepEqual(tree(f.root), before);
});

test("--work: a directory another process makes meanwhile is used, not refused; a failed lock create undoes the directories it made", () => {
  const f = fixture();
  const racing = path.join(f.root, "race-mkdir.mjs");
  fs.writeFileSync(racing, `import fs from "node:fs";
import path from "node:path";
const mk = fs.mkdirSync;
fs.mkdirSync = (d, o) => { if (path.basename(String(d)) === "race") { mk(d, o); const e = new Error("EEXIST: file already exists, mkdir"); e.code = "EEXIST"; throw e; } return mk(d, o); };
`);
  const work = path.join(f.root, "race", "w");
  const r = bake({ ...f, work }, { work }, { env: { NODE_OPTIONS: `--import ${pathToFileURL(racing).href}` } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(work, "init.snap")));
  const g = fixture();
  const failing = path.join(g.root, "lock-create-fails.mjs");
  fs.writeFileSync(failing, `import fs from "node:fs";
const open = fs.openSync;
fs.openSync = (p, fl, ...rest) => { if (String(p).endsWith(".bake.lock") && fl === "wx") { const e = new Error("EIO: i/o error, open"); e.code = "EIO"; throw e; } return open(p, fl, ...rest); };
`);
  const deep = path.join(g.root, "a", "b", "w");
  const before = tree(g.root);
  const s2 = bake({ ...g, work: deep }, { work: deep }, { env: { NODE_OPTIONS: `--import ${pathToFileURL(failing).href}` } });
  assert.equal(s2.status, 2, s2.stderr);
  assert.deepEqual(s2.err, [`bake-snapshot: cannot create ${path.join(deep, ".bake.lock")} (EIO)`]);
  assert.deepEqual(tree(g.root), before);
});

test("the lock-wait variables are read as QED64 reads its own: junk or 0 means the default (a wait), never a refusal", async () => {
  for (const env of [{ LEAN4_WASM64_BAKE_LOCK_WAIT_MS: "soon" }, { LEAN4_WASM64_BAKE_LOCK_WAIT_MS: "0", QED64_BAKE_LOCK_WAIT_MS: "100" }, { QED64_BAKE_LOCK_WAIT_MS: "-1" }]) {
    const f = fixture();
    const lock = path.join(f.out, "index.json.lock");
    write(lock, `${process.pid}\n`);
    const b = bakeAsync(f, {}, env);
    try {
      await waitFor(() => snapzOf(f).length === 1, "the .snapz");
      await sleep(500); // past every bound but the default's
      assert.equal(b.p.exitCode, null, `${JSON.stringify(env)}: still waiting`);
      fs.rmSync(lock);
      assert.equal((await b.closed).code, 0, b.stderr());
    } finally {
      if (b.p.exitCode === null && b.p.signalCode === null) b.p.kill("SIGKILL");
    }
  }
});

test("a probe header Lean reads only as the bake writes it (the newline it appends) is accepted: `import A\\r`, `#lang lean4`", () => {
  for (const [probe, imports] of [["import A\r", ["A"]], ["#lang lean4\nimport B\n-- FAKE {}", ["B"]]]) {
    const f = fixture();
    const r = bake(f, { probe });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readIndexFile(f).snapshots[0].imports, imports);
  }
});

// ---------- the index lock and the checks under it ----------

test("the index lock is never taken over: a running, dead, JSON or empty holder, ten minutes old, is waited for, then named (exit 1)", () => {
  const dead = deadPid();
  const holders = [
    [`${process.pid}\n`, `pid ${process.pid} (running on this host)`],
    [`${dead}\n`, `pid ${dead} (not running on this host)`],
    [`${JSON.stringify({ pid: dead, host: os.hostname(), start: "s", version: "v" })}\n`, null],
    ["", 'a holder it cannot read ("")'],
  ];
  for (const [text, who] of holders) {
    const f = fixture();
    writeIndex(f, [{ name: "mathlib", url: "/snapshots/m.snapz", runtime: f.id }]);
    const lock = path.join(f.out, "index.json.lock");
    write(lock, text);
    ago(lock, 10 * 60_000);
    const indexBefore = fs.readFileSync(path.join(f.out, "index.json"));
    const t0 = Date.now();
    const r = bake(f, {}, { env: { LEAN4_WASM64_BAKE_LOCK_WAIT_MS: "800", QED64_BAKE_LOCK_WAIT_MS: "not read: the first is set" } });
    assert.ok(Date.now() - t0 >= 800);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.err.length, 2, r.stderr);
    assert.equal(r.err[0], indexLockLine(f, who ?? `a holder it cannot read (${JSON.stringify(text)})`, 800));
    const [gzName] = snapzOf(f);
    const entry = JSON.parse(UNINDEXED.exec(r.err[1])[1]);
    assert.equal(entry.url, `/snapshots/${gzName}`);
    assert.equal(entry.digest, `sha256:${sha256(fs.readFileSync(path.join(f.out, gzName)))}`);
    assert.equal(entry.runtime, f.id);
    assert.deepEqual(fs.readdirSync(f.out).sort(), [gzName, "index.json", "index.json.lock"].sort()); // no copy either
    assert.deepEqual(fs.readFileSync(path.join(f.out, "index.json")), indexBefore);
    assert.equal(fs.readFileSync(lock, "utf8"), text); // reported, never broken
    assert.doesNotMatch(r.stdout, /^(baked|index copy) /m);
    assertNoReserved(r.stderr);
    // removed once no bake writes --out: the rerun finishes the upsert
    fs.rmSync(lock);
    const s = bake(f);
    assert.equal(s.status, 0, s.stderr);
    assert.deepEqual(readIndexFile(f).snapshots.map((e) => e.name), ["mathlib", "init"]);
    assert.deepEqual(fs.readFileSync(path.join(f.out, `index.${f.id}.json`)), fs.readFileSync(path.join(f.out, "index.json")));
    assert.equal(fs.existsSync(lock), false);
  }
});

test("the index lock: QED64's bound variable is read when the package's is unset; released while the bake waits, the bake completes", async () => {
  const f = fixture();
  const lock = path.join(f.out, "index.json.lock");
  write(lock, "1\n"); // QED64's format, pid 1: running
  const r = bake(f, {}, { env: { QED64_BAKE_LOCK_WAIT_MS: "300" } });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.err[0], indexLockLine(f, "pid 1 (running on this host)", 300));
  assert.match(r.err[1], UNINDEXED);
  const b = bakeAsync(f, { name: "mathlib" });
  try {
    // the .snapz is renamed into place just before the upsert: from then on the bake is at the lock
    await waitFor(() => snapzOf(f).length === 2, "the .snapz");
    await sleep(300);
    assert.equal(fs.existsSync(path.join(f.out, "index.json")), false);
    assert.equal(fs.existsSync(path.join(f.out, `index.${f.id}.json`)), false);
    fs.rmSync(lock);
    assert.equal((await b.closed).code, 0, b.stderr());
  } finally {
    if (b.p.exitCode === null && b.p.signalCode === null) b.p.kill("SIGKILL");
  }
  assert.match(b.stdout(), new RegExp(`^index copy ${reEsc(path.join(f.out, `index.${f.id}.json`))} written`, "m"));
  assert.deepEqual(readIndexFile(f).snapshots.map((e) => e.name), ["mathlib"]);
  assert.equal(fs.existsSync(lock), false);
});

test("refusals under the lock exit 1: a foreign or unpaired entry or a corrupt index appearing mid-bake is not replaced; the .snapz is kept, its entry printed", () => {
  const cases = [
    ["foreign", (f) => JSON.stringify({ schema: SCHEMA, snapshots: [{ name: "mathlib", url: "/snapshots/m.snapz", runtime: OTHER }] }), "refuse-foreign"],
    ["unpaired", (f) => JSON.stringify({ schema: SCHEMA, snapshots: [{ name: "mathlib", url: "/snapshots/m.snapz" }] }), "refuse-unpaired"],
    ["corrupt", () => '{"schema": "qed64.snapshot-index/v1", "snapshots": [', null],
  ];
  for (const [label, text, marker] of cases) {
    const f = fixture();
    const indexText = text(f);
    const r = bake(f, { probe: probeWith({ writes: [[path.join(f.out, "index.json"), indexText]] }) });
    assert.equal(r.status, 1, `${label}: ${r.stderr}`);
    assert.equal(r.err.length, 2, `${label}: ${r.stderr}`);
    assert.deepEqual(markersOf(r.err[0]), marker ? [marker] : [], label);
    if (!marker) assert.match(r.err[0], /is not a snapshot index: it is not JSON — refusing to replace it$/);
    assert.match(r.err[1], /^bake-snapshot: unindexed entry \{"name":"init",/);
    assert.equal(fs.readFileSync(path.join(f.out, "index.json"), "utf8"), indexText, label);
    const [gzName] = snapzOf(f);
    assert.deepEqual(fs.readdirSync(f.out).sort(), [gzName, "index.json"].sort(), label);
    assert.doesNotMatch(r.stdout, /^(baked|index copy) /m);
  }
});

test("the copy is switched FIRST: when index.json's rename fails, the copy already holds the new index; no temp or lock is left", () => {
  const f = fixture();
  const preload = path.join(f.root, "no-index-rename.mjs");
  fs.writeFileSync(preload, `import fs from "node:fs";
import path from "node:path";
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (path.basename(String(to)) === "index.json") { const e = new Error("EIO: i/o failure, rename"); e.code = "EIO"; throw e; }
  return rename(from, to);
};
`);
  const r = bake(f, {}, { env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(preload).href}`.trim() } });
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(r.err.slice(0, 1), ["bake-snapshot: writing the index failed (EIO): the .snapz is in place, index.json is not updated (its copy may be)"]);
  assert.match(r.err[1], UNINDEXED);
  assert.doesNotMatch(r.stdout, /^baked /m);
  const copy = JSON.parse(fs.readFileSync(path.join(f.out, `index.${f.id}.json`), "utf8"));
  assert.deepEqual(copy.snapshots.map((e) => [e.name, e.runtime]), [["init", f.id]]);
  assert.equal(fs.existsSync(path.join(f.out, "index.json")), false);
  assert.deepEqual(fs.readdirSync(f.out).filter((x) => !x.endsWith(".snapz")), [`index.${f.id}.json`]);
  assert.equal(fs.existsSync(workLockOf(f)), false);
  assert.equal(fs.existsSync(path.join(f.out, "index.json.lock")), false);
});
