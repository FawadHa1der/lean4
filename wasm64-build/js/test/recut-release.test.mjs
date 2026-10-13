// release.mjs --base: the writer side of a tools re-cut (formats/release.md, "Release by
// reference"). A small first cut is staged and released once; each case clones its files outside
// tools/ into a fresh <id>-r3 dir beside a new tgz, derives the config from the base's record as
// by-reference staging does, and runs release.mjs as a separate process. Every refusal writes
// nothing, and ends by exitCode, not process.exit() (see exitSpy).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalRelease, checkRecutBase, checkReleaseRecord, serializeRelease } from "../release-record.mjs";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// a timeout on every spawn: a tool that hangs (process.exit() after hashing can deadlock Node
// 26.3's shutdown, fetch-release.mjs) fails its test within a minute, by name, not at CI's limit
const run = (script, args, node = []) => {
  const r = spawnSync(process.execPath, [...node, path.join(pkg, script), ...args], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
  if (r.error) assert.fail(`${script} ${args.join(" ")}: ${r.error.code === "ETIMEDOUT" ? "still running after 60 s (a hang), killed" : r.error.message}`);
  return r;
};
const KERNEL = "a8817d01f97227b1b04cc7d661b9e396f6ca8f34";
const BASE_ID = "lean-v4.34.0-a8817d0", RECUT_ID = "lean-v4.34.0-a8817d0-r3";
const RECUT_TGZ = "tools/lean4-wasm64-4.34.0-a8817d0-r3.tgz";
const made = [];
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

/** Node flags for a preload that reports every process.exit() call on stderr (EXIT_CALLED), then
 *  exits as asked: past its usage checks, release.mjs has hashed files, and a refusal there must
 *  set process.exitCode and return (Node 26.3 can deadlock exiting during background JIT work). */
let exitSpy;
const EXIT_CALLED = /^l4w-test: process\.exit\(/m;

/** The first cut every case re-cuts: <root>/<BASE_ID>/, released (release.json + SHA256SUMS). */
let B;
before(() => {
  const root = mkdtemp("l4w-recut-rel-");
  const spy = path.join(root, "exit-spy.mjs");
  fs.writeFileSync(spy, `import fs from "node:fs";
const exit = process.exit;
process.exit = function (code) { fs.writeSync(2, "l4w-test: process.exit(" + code + ") called\\n"); return exit.call(process, code); };
`);
  exitSpy = ["--import", pathToFileURL(spy).href];
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "lean.js"), Buffer.alloc(2500, 1));
  fs.writeFileSync(path.join(bin, "lean.wasm"), Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 251)));
  const rel = path.join(root, BASE_ID);
  let r = run("chunk-runtime.mjs", ["--bin", bin, "--out", path.join(rel, "runtime"), "--lean-version", "4.34.0",
    "--revision", `qed64-wasm64@${KERNEL.slice(0, 10)} (upstream v4.34.0)`, "--part-bytes", "1024"]);
  assert.equal(r.status, 0, r.stderr);
  fs.mkdirSync(path.join(rel, "runtime", "bin"));
  fs.writeFileSync(path.join(rel, "runtime", "bin", "leanmake"), "#!/bin/sh\n");
  const lib = path.join(root, "lib");
  fs.mkdirSync(path.join(lib, "Init"), { recursive: true });
  fs.writeFileSync(path.join(lib, "Init.olean"), Buffer.alloc(300, 3));
  fs.writeFileSync(path.join(lib, "Init", "Prelude.olean"), Buffer.alloc(1200, 5));
  r = run("pack.mjs", ["--lib", lib, "--id", "lean-core", "--out", path.join(rel, "profiles"), "--lean-version", "4.34.0",
    "--revision", KERNEL, "--roots", "Init", "--url-prefix", "/profiles/", "--no-imports"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const extra = path.join(root, "extra");
  fs.mkdirSync(path.join(extra, "Mathlib"), { recursive: true });
  fs.writeFileSync(path.join(extra, "Mathlib", "Extra.olean"), Buffer.alloc(900, 6));
  r = run("pack.mjs", ["--lib", extra, "--id", "mathlib-game-extra", "--out", path.join(rel, "profiles"), "--lean-version", "4.34.0",
    "--revision", KERNEL, "--url-prefix", "/profiles/", "--no-imports"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const f of fs.readdirSync(path.join(rel, "profiles"))) if (f.endsWith(".pack")) fs.rmSync(path.join(rel, "profiles", f));
  fs.mkdirSync(path.join(rel, "native64"));
  fs.writeFileSync(path.join(rel, "native64", "native64.tar.gz"), "not really a tarball");
  fs.mkdirSync(path.join(rel, "lists"));
  fs.writeFileSync(path.join(rel, "lists", "essential-modules.txt"), "Init\n");
  fs.writeFileSync(path.join(rel, "lists", "essential-selection.json"), "{}\n");
  fs.mkdirSync(path.join(rel, "tools"));
  fs.writeFileSync(path.join(rel, "tools", "lean4-wasm64-4.34.0-a8817d0.tgz"), "the first cut's tools");
  const manifest = JSON.parse(fs.readFileSync(path.join(rel, "runtime", "runtime-manifest.json"), "utf8"));
  const mathlib = { commit: "5ed2965256430c3649e86755f9576b54eca72435", tag: "v4.34.0" };
  const config = {
    upstreamTag: "v4.34.0", kernelCommit: KERNEL, kernelPatch: "0035b", leanVersion: "4.34.0",
    gate: { commit: KERNEL, wasmSha256: manifest.files["lean.wasm"].sha256, checks: 33 },
    packs: [{ id: "lean-core", compiler: "8d91aadcda8a0b231e47c42d4ff4b9b8360563aa" },
      { id: "mathlib-game-extra", compiler: "857544b439aa51633344d638dacc03d304b9ea96", mathlib, note: "transport copied from served bytes, not re-packed" }],
    native64: { commit: "857544b439aa51633344d638dacc03d304b9ea96", os: "linux", arch: "aarch64", tar: "native64/native64.tar.gz" },
    docker: { tag: "qed64-toolchain:emsdk-6.0.5", recipeCommit: "974ee228b0" },
    mathlib,
    modules: { essential: "lists/essential-modules.txt" },
    hosting: { layout: "served", mount: { "/runtime/": "runtime/", "/profiles/": "profiles/" }, spec: "wasm64-build/js/formats/HOSTING.md" },
    tools: { package: "lean4-wasm64", version: "4.34.0-a8817d0", tgz: "tools/lean4-wasm64-4.34.0-a8817d0.tgz" },
    notes: ["the first cut's own note"],
  };
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(config));
  r = run("release.mjs", ["--release", rel, "--config", path.join(root, "config.json")]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  B = { root, rel, record: JSON.parse(fs.readFileSync(path.join(rel, "release.json"), "utf8")) };
});

/** The config by-reference staging derives from the base's record alone (stage-release.sh --base). */
const recutConfig = (b) => ({
  id: RECUT_ID, upstreamTag: b.lean.upstreamTag, kernelCommit: b.kernel.commit, kernelPatch: b.kernel.patch,
  kernelRepo: b.kernel.repo, kernelBranch: b.kernel.branch, recut: 3, base: { id: b.id, digest: b.digest },
  leanVersion: b.lean.version,
  gate: { commit: b.gate.commit, wasmSha256: b.gate.wasmSha256, checks: b.gate.checks + 1 },
  packs: b.packs.map((p) => ({ id: p.id, compiler: p.lean.compiler, ...(p.mathlib ? { mathlib: p.mathlib } : {}), ...(p.note ? { note: p.note } : {}) })),
  native64: b.native64, docker: b.docker, mathlib: b.mathlib, modules: b.modules, hosting: b.hosting,
  tools: { package: "lean4-wasm64", version: "4.34.0-a8817d0-r3", tgz: RECUT_TGZ, commit: "c".repeat(40) },
  notes: [`Tools-only re-cut of ${b.id}, by reference.`, ...b.notes],
});

/** A fresh <root>/<RECUT_ID>/: the base's files outside tools/ (no record, no sums), the new tgz, a config. */
function recut(edit = (c) => c) {
  const root = mkdtemp("l4w-recut-rel-");
  const dir = path.join(root, RECUT_ID);
  fs.cpSync(B.rel, dir, { recursive: true, filter: (src) => !["release.json", "SHA256SUMS", "tools"].includes(path.relative(B.rel, src).split(path.sep)[0]) });
  fs.mkdirSync(path.join(dir, "tools"));
  fs.writeFileSync(path.join(dir, RECUT_TGZ), "the -r3 tools");
  const config = edit(recutConfig(B.record));
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { root, dir, config, configPath };
}
/** release.mjs on a case, under exitSpy: whatever the outcome but a usage error (2, before any
 *  read), it ends without process.exit(). */
const release = (s, ...extra) => {
  const r = run("release.mjs", ["--release", s.dir, "--config", s.configPath, ...extra], exitSpy);
  if (r.status !== 2) assert.doesNotMatch(r.stderr, EXIT_CALLED, `release.mjs ${extra.join(" ")} (exit ${r.status}) called process.exit()`);
  return r;
};
const written = (dir) => ["release.json", "SHA256SUMS"].filter((n) => fs.existsSync(path.join(dir, n)));
const sumsOf = (dir) => new Map(fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8").trim().split("\n").map((l) => l.split("  ").reverse()));

test("a clean by-reference config over the cloned files: written, base right after id, the base's but for tools/", () => {
  const s = recut();
  let r = release(s, "--base", B.rel);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`release ${RECUT_ID}: .*, a release by reference of ${BASE_ID} →`));
  const text = fs.readFileSync(path.join(s.dir, "release.json"), "utf8");
  const rec = JSON.parse(text);
  assert.deepEqual(Object.keys(rec).slice(0, 4), ["schema", "id", "base", "lean"]);
  assert.deepEqual(rec.base, { id: BASE_ID, digest: B.record.digest });
  assert.deepEqual(checkReleaseRecord(rec), []);
  assert.deepEqual(checkRecutBase(rec, B.record), []);
  assert.equal(rec.files.length, B.record.files.length);
  // only what a tools re-cut may change differs: gate.checks, tools, notes
  assert.equal(rec.gate.checks, B.record.gate.checks + 1);
  assert.equal(rec.tools.tgz, RECUT_TGZ);
  assert.deepEqual(rec.notes.slice(1), B.record.notes);
  // SHA256SUMS differs from the base's at release.json and the two tgz lines, nowhere else
  const [mine, theirs] = [sumsOf(s.dir), sumsOf(B.rel)];
  const differ = [...new Set([...mine.keys(), ...theirs.keys()])].filter((p) => mine.get(p) !== theirs.get(p)).sort();
  assert.deepEqual(differ, ["release.json", RECUT_TGZ, B.record.tools.tgz]);
  // --base may name the base's release.json itself; the record is the same bytes
  r = release(s, "--base", path.join(B.rel, "release.json"));
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fs.readFileSync(path.join(s.dir, "release.json"), "utf8"), text);
  // and the dir is a complete release
  r = run("verify-release.mjs", ["--release", s.dir, "--deep"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`RELEASE VERIFIED ${RECUT_ID}`));
});

test("--base is a usage flag: an empty value exits 2, before any read; --help names it", () => {
  const s = recut();
  for (const extra of [["--base", ""], ["--base"], ["--base="]]) {
    const r = release(s, ...extra);
    assert.equal(r.status, 2, `${extra.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /--base was given without a value/);
    assert.deepEqual(written(s.dir), []);
  }
  const h = run("release.mjs", ["--help"]);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /--base <path> +a release by reference \(config\.base\)/);
});

test("config.base and --base come together: either alone is refused, nothing written", () => {
  let s = recut();
  let r = release(s);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /config\.base names a base \(a release by reference\): pass --base/);
  assert.deepEqual(written(s.dir), []);
  s = recut((c) => { delete c.base; return c; });
  r = release(s, "--base", B.rel);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /--base was given, but the config names no base/);
  assert.deepEqual(written(s.dir), []);
});

test("--base must be the release config.base pins, by id and by digest; nothing written", () => {
  const resigned = (mutate) => { const { digest: _d, ...r } = structuredClone(B.record); mutate(r); return canonicalRelease(r); };
  const elsewhere = mkdtemp("l4w-recut-base-");
  const write = (name, text) => { const p = path.join(elsewhere, name); fs.writeFileSync(p, text); return p; };
  // another digest: the base's record re-signed with another note
  const other = resigned((r) => { r.notes = ["another note"]; });
  let s = recut();
  let r = release(s, "--base", write("other-digest.json", serializeRelease(other)));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, new RegExp(`is ${BASE_ID} \\(${other.digest}\\), config\\.base pins ${BASE_ID} \\(${B.record.digest}\\)`));
  assert.deepEqual(written(s.dir), []);
  // another id, with config.base pinning that record's digest: the id alone refuses it
  const otherId = resigned((r) => { r.id = "lean-v4.34.0-1234567"; });
  s = recut((c) => ({ ...c, base: { id: BASE_ID, digest: otherId.digest } }));
  r = release(s, "--base", write("other-id.json", serializeRelease(otherId)));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /is lean-v4\.34\.0-1234567 .*config\.base pins lean-v4\.34\.0-a8817d0/);
  assert.deepEqual(written(s.dir), []);
  // unreadable: no such path, a dir without release.json, not JSON, JSON null
  for (const bad of [path.join(elsewhere, "missing"), mkdtemp("l4w-recut-empty-"), write("garbage.json", "{ not json")]) {
    s = recut();
    r = release(s, "--base", bad);
    assert.equal(r.status, 1, `${bad}: ${r.stdout}`);
    assert.match(r.stderr, /--base: the base's release\.json is unreadable/);
    assert.deepEqual(written(s.dir), []);
  }
  s = recut();
  r = release(s, "--base", write("null.json", "null"));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /is undefined \(undefined\), config\.base pins/);
  assert.deepEqual(written(s.dir), []);
});

test("a re-derived record that is not the base's but for tools/ is refused (checkRecutBase), nothing written", () => {
  const cases = [
    // the real -r2 drift: a pack note --packs-from adds
    ["a pack note", (s) => { s.config.packs[0].note = "transport copied from served bytes, not re-packed"; }, /packs differs from the base's/],
    ["hosting key order", (s) => { s.config.hosting = Object.fromEntries(Object.entries(s.config.hosting).reverse()); }, /hosting differs from the base's/],
    ["a cloned file with other bytes", (s) => { fs.writeFileSync(path.join(s.dir, "lists", "essential-modules.txt"), "Init\nMathlib\n"); }, /files\[\]: lists\/essential-modules\.txt is not the base's bytes/],
    ["an extra file outside tools/", (s) => { fs.writeFileSync(path.join(s.dir, "lists", "zz-extra.txt"), "x\n"); }, /files\[\]: lists\/zz-extra\.txt is not a file of the base/],
    ["a base file missing", (s) => { fs.rmSync(path.join(s.dir, "lists", "essential-selection.json")); }, /files\[\]: the base's lists\/essential-selection\.json is missing/],
  ];
  for (const [label, mutate, re] of cases) {
    const s = recut();
    mutate(s);
    fs.writeFileSync(s.configPath, JSON.stringify(s.config));
    const r = release(s, "--base", B.rel);
    assert.equal(r.status, 1, `${label}: ${r.stdout}`);
    assert.match(r.stderr, new RegExp(`REFUSED — not a release by reference of ${BASE_ID}:`), label);
    assert.match(r.stderr, re, label);
    assert.deepEqual(written(s.dir), [], label);
  }
  // a base record edited after it was signed: its own digest field still matches config.base
  const s = recut();
  const tampered = { ...structuredClone(B.record), notes: ["edited, not re-signed"] };
  const p = path.join(s.root, "tampered-base.json");
  fs.writeFileSync(p, serializeRelease(tampered));
  const r = release(s, "--base", p);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /the base's release\.json: self-digest does not match the content/);
  assert.deepEqual(written(s.dir), []);
});

test("config.base on a first cut, or tools/ that break S5, fails the record's own rules; nothing written", () => {
  // no recut: the id is the first cut's, which never names a base
  let s = recut((c) => { const { id: _i, recut: _r, ...rest } = c; return rest; });
  let r = release(s, "--base", B.rel);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /the record would break its own rules:[\s\S]*base\.id is lean-v4\.34\.0-a8817d0 itself: a runtime release by reference names a first cut of another kernel commit/);
  assert.deepEqual(written(s.dir), []);
  // the base's tools version again, under the -r3 name
  s = recut((c) => ({ ...c, tools: { ...c.tools, version: B.record.tools.version } }));
  r = release(s, "--base", B.rel);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /is not tools\/<package>-<version>\.tgz/);
  assert.deepEqual(written(s.dir), []);
  // the base's tgz cloned along with the rest: two files under tools/
  s = recut();
  fs.copyFileSync(path.join(B.rel, B.record.tools.tgz), path.join(s.dir, B.record.tools.tgz));
  r = release(s, "--base", B.rel);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /exactly one file under tools\/, tools\.tgz — got tools\/lean4-wasm64-4\.34\.0-a8817d0-r3\.tgz, tools\/lean4-wasm64-4\.34\.0-a8817d0\.tgz/);
  assert.deepEqual(written(s.dir), []);
});

test("each refusal after hashing sets exitCode and returns, never process.exit(): exit 1, its report, nothing written", () => {
  // one case per refusal site; runtime/bin/leanmake is hashed before the first
  const cases = [
    ["the first checks", () => [], /^release: REFUSED — 1 problem\(s\):\n {2}config\.base names a base/],
    ["files[]", (s) => { fs.writeFileSync(path.join(s.dir, "lists", ".DS_Store"), "x"); return ["--base", B.rel]; },
      /^release: REFUSED — 1 problem\(s\):\n {2}lists\/\.DS_Store: dotfiles and unsafe names are not release files/],
    ["the record's own rules", (s) => { s.config.tools.version = B.record.tools.version; return ["--base", B.rel]; },
      /^release: REFUSED — the record would break its own rules:\n {2}[\s\S]*is not tools\/<package>-<version>\.tgz/],
    ["checkRecutBase", (s) => { fs.writeFileSync(path.join(s.dir, "lists", "essential-modules.txt"), "Init\nMathlib\n"); return ["--base", B.rel]; },
      new RegExp(`^release: REFUSED — not a release by reference of ${BASE_ID}:\\n {2}files\\[\\]: lists/essential-modules\\.txt is not the base's bytes`)],
  ];
  for (const [label, setup, re] of cases) {
    const s = recut();
    const extra = setup(s);
    fs.writeFileSync(s.configPath, JSON.stringify(s.config));
    const r = run("release.mjs", ["--release", s.dir, "--config", s.configPath, ...extra], exitSpy);
    assert.equal(r.status, 1, `${label}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, re, label);
    assert.doesNotMatch(r.stderr, EXIT_CALLED, `${label}: process.exit() after hashing`);
    assert.deepEqual(written(s.dir), [], label);
  }
  // the spy sees an exit: a usage error, before any read, still leaves by process.exit(2)
  const s = recut();
  const r = run("release.mjs", ["--release", s.dir, "--config", s.configPath, "--base", ""], exitSpy);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^l4w-test: process\.exit\(2\) called$/m);
});
