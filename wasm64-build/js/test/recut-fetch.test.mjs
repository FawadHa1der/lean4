// A tools re-cut, the reader side (formats/release.md, "Release by reference"): fetch from
// a thin flat -r3 (tools/, release.json, SHA256SUMS) whose every other file is its first cut's,
// found as the sibling <…>/<base id>/ or at --base-from; a complete served -r3 read alone; the
// refusals that write nothing; verify --base. End to end and offline: a small synthetic first cut
// (chunk → pack → release), the -r3 record synthesized from it, flat and served copies on disk, and
// node:http on 127.0.0.1 for the GitHub-style download URLs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256Hex } from "../artifact-id.mjs";
import { canonicalRelease, checkRecutBase, checkReleaseRecord, isRecutOwnPath, serializeRelease, sha256sums } from "../release-record.mjs";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// every spawn has a deadline: a hang (Node 26.3's exit deadlock, a stuck read) fails here, fast and
// with what the tool printed, never at the CI job's timeout
const TIMEOUT_MS = 60_000;
function runNode(file, args, nodeFlags = []) {
  const r = spawnSync(process.execPath, [...nodeFlags, file, ...args], { encoding: "utf8", timeout: TIMEOUT_MS });
  if (r.error) throw new Error(`${path.basename(file)} ${args.join(" ")}: ${r.error.message}\n${r.stdout}${r.stderr}`);
  return r;
}
const run = (script, args) => runNode(path.join(pkg, script), args);
const runAsync = (script, args) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [path.join(pkg, script), ...args]);
  let stdout = "", stderr = "";
  const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${script} ${args.join(" ")}: no exit within ${TIMEOUT_MS / 1000} s\n${stdout}${stderr}`)); }, TIMEOUT_MS);
  p.stdout.on("data", (d) => (stdout += d)); p.stderr.on("data", (d) => (stderr += d));
  p.on("error", (e) => { clearTimeout(timer); reject(e); });
  p.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});
const made = [];
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const KERNEL = "a8817d01f97227b1b04cc7d661b9e396f6ca8f34";
// rule S3: the base is always the first cut; the re-cut is its -r3
const BASE_ID = "lean-v4.34.0-a8817d0", RECUT_ID = "lean-v4.34.0-a8817d0-r3";
const RECUT_TGZ = "tools/lean4-wasm64-4.34.0-a8817d0-r3.tgz", RECUT_TGZ_BYTES = "tgz of r3";

/** The first cut: a served release dir <root>/served/<BASE_ID>, written by the package's own tools. */
function stageBase() {
  const root = mkdtemp("l4w-recut-fetch-");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "lean.js"), Buffer.alloc(2500, 1));
  fs.writeFileSync(path.join(bin, "lean.wasm"), Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 251)));
  const rel = path.join(root, "served", BASE_ID);
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
  for (const f of fs.readdirSync(path.join(rel, "profiles"))) if (f.endsWith(".pack")) fs.rmSync(path.join(rel, "profiles", f));
  fs.mkdirSync(path.join(rel, "native64"));
  fs.writeFileSync(path.join(rel, "native64", "native64.tar.gz"), "not really a tarball");
  fs.mkdirSync(path.join(rel, "lists"));
  fs.writeFileSync(path.join(rel, "lists", "essential-modules.txt"), "Init\n");
  fs.mkdirSync(path.join(rel, "tools"));
  fs.writeFileSync(path.join(rel, "tools", "lean4-wasm64-4.34.0-a8817d0.tgz"), "tgz");
  const manifest = JSON.parse(fs.readFileSync(path.join(rel, "runtime", "runtime-manifest.json"), "utf8"));
  const config = {
    upstreamTag: "v4.34.0", kernelCommit: KERNEL, kernelPatch: "0035b",
    gate: { commit: KERNEL, wasmSha256: manifest.files["lean.wasm"].sha256, checks: 33 },
    packs: [{ id: "lean-core", compiler: "8d91aadcda8a0b231e47c42d4ff4b9b8360563aa" }],
    native64: { commit: "857544b439aa51633344d638dacc03d304b9ea96", os: "linux", arch: "aarch64", tar: "native64/native64.tar.gz" },
    docker: { tag: "qed64-toolchain:emsdk-6.0.5", recipeCommit: "974ee228b0" },
    mathlib: { commit: "5ed2965256430c3649e86755f9576b54eca72435", tag: "v4.34.0" },
    modules: { essential: "lists/essential-modules.txt" },
    tools: { package: "lean4-wasm64", version: "4.34.0-a8817d0", tgz: "tools/lean4-wasm64-4.34.0-a8817d0.tgz" },
  };
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(config));
  r = run("release.mjs", ["--release", rel, "--config", path.join(root, "config.json")]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { root, rel, bin, record: JSON.parse(fs.readFileSync(path.join(rel, "release.json"), "utf8")) };
}

const resign = (record, mutate) => { const { digest: _d, ...r } = structuredClone(record); mutate(r); return canonicalRelease(r); };
/** What by-reference staging writes: the base's files and fields, its own tools/, base = {id, digest}. */
function recutRecord(base, mutate = () => {}) {
  return resign(base, (r) => {
    r.id = RECUT_ID;
    r.base = { id: base.id, digest: base.digest };
    r.gate.checks = 36; // re-gated with the new tools on the base's runtime
    r.tools = { package: "lean4-wasm64", version: "4.34.0-a8817d0-r3", tgz: RECUT_TGZ, commit: "f".repeat(40) };
    r.notes = [`Tools-only re-cut of ${base.id}, by reference.`, ...(base.notes ?? [])];
    r.files = [...r.files.filter((f) => !isRecutOwnPath(f.path)), { path: RECUT_TGZ, bytes: RECUT_TGZ_BYTES.length, sha256: sha256Hex(Buffer.from(RECUT_TGZ_BYTES)) }]
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    mutate(r);
  });
}
const sums = (rec) => sha256sums([...rec.files, { path: "release.json", sha256: sha256Hex(Buffer.from(serializeRelease(rec))) }]);

/** The -r3's own GitHub assets, flat: the tgz, release.json, SHA256SUMS. */
function writeThin(dir, rec) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, path.basename(rec.tools.tgz)), RECUT_TGZ_BYTES);
  fs.writeFileSync(path.join(dir, "release.json"), serializeRelease(rec));
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), sums(rec));
  return dir;
}
/** GitHub-style flat dirs under <root>/<parent>: <base id>/ (every asset of the first cut) and <recut id>/ (thin). */
function writeFlat(s, rec, parent = "flat") {
  const fb = path.join(s.root, parent, s.record.id), fr = path.join(s.root, parent, rec.id);
  fs.mkdirSync(fb, { recursive: true });
  for (const f of s.record.files) fs.copyFileSync(path.join(s.rel, f.path), path.join(fb, path.basename(f.path)));
  for (const n of ["release.json", "SHA256SUMS"]) fs.copyFileSync(path.join(s.rel, n), path.join(fb, n));
  writeThin(fr, rec);
  return { fb, fr };
}
/** A complete served -r3 mirror (an R2 prefix, a `fetch --only all` of it): the base's files plus its own. */
function writeServed(dir, s, rec) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of rec.files) {
    if (isRecutOwnPath(f.path)) continue;
    fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
    fs.copyFileSync(path.join(s.rel, f.path), path.join(dir, f.path));
  }
  fs.mkdirSync(path.join(dir, "tools"));
  fs.writeFileSync(path.join(dir, rec.tools.tgz), RECUT_TGZ_BYTES);
  fs.writeFileSync(path.join(dir, "release.json"), serializeRelease(rec));
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), sums(rec));
  return dir;
}
const partials = (d) => {
  const found = [];
  (function walk(x) { for (const e of fs.existsSync(x) ? fs.readdirSync(x, { withFileTypes: true }) : []) { const p = path.join(x, e.name); if (e.isDirectory()) walk(p); else if (e.name.includes(".partial-")) found.push(p); } })(d);
  return found;
};

test("the fixture: a first cut and its -r3 by reference, both valid, the base checked", () => {
  const s = stageBase();
  const rec = recutRecord(s.record);
  assert.equal(s.record.id, BASE_ID);
  assert.equal(s.record.base, undefined);
  assert.deepEqual(checkReleaseRecord(rec), []);
  assert.deepEqual(checkRecutBase(rec, s.record), []);
  assert.deepEqual(rec.files.filter((f) => isRecutOwnPath(f.path)).map((f) => f.path), [RECUT_TGZ]);
});

test("a thin flat -r3 beside its flat first cut: fetch takes every other file from the sibling; verify with and without --base", () => {
  const s = stageBase();
  const rec = recutRecord(s.record);
  const { fb, fr } = writeFlat(s, rec);
  const out = path.join(s.root, "got");
  let r = run("fetch-release.mjs", ["--from", fr, "--out", out, "--only", "all", "--id", rec.id, "--digest", rec.digest]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`flat layout from ${esc(fr)}; release by reference of ${esc(BASE_ID)} \\(sha256:[0-9a-f]{16}…\\), base checked, files outside tools/ from ${esc(fb)}`));
  for (const f of rec.files) assert.ok(fs.existsSync(path.join(out, f.path)), f.path);
  assert.equal(fs.existsSync(path.join(out, s.record.tools.tgz)), false, "the base's own tgz is no file of the re-cut");
  assert.equal(fs.readFileSync(path.join(out, "SHA256SUMS"), "utf8"), sums(rec));
  r = run("verify-release.mjs", ["--release", out, "--deep"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`^info {2}release by reference of ${esc(BASE_ID)} \\(sha256:[0-9a-f]{16}…\\): not compared with its base \\(--base`, "m"));
  assert.match(r.stdout, new RegExp(`RELEASE VERIFIED ${esc(RECUT_ID)}`));
  for (const base of [fb, path.join(s.rel, "release.json")]) { // a release dir, or its release.json
    r = run("verify-release.mjs", ["--release", out, "--base", base]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^ ok {3}release by reference of ${esc(BASE_ID)} .*: the base's record is the pinned one, and every file outside tools/ and every shared field is the base's$`, "m"));
    assert.doesNotMatch(r.stdout, /^info /m);
  }
  // the artifact layout, rebuilt from the base's chunks
  const rt = path.join(s.root, "rt");
  r = run("fetch-release.mjs", ["--from", fr, "--out", rt, "--only", "runtime", "--id", rec.id, "--digest", rec.digest]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.readFileSync(path.join(rt, "bin", "lean.wasm")).equals(fs.readFileSync(path.join(s.bin, "lean.wasm"))));
  assert.ok(fs.existsSync(path.join(rt, "bin", "leanmake")));
});

test("a thin flat -r3 beside a served base mirror: a directory sibling's layout is inferred from the sibling", () => {
  const s = stageBase();
  const rec = recutRecord(s.record);
  const fr = writeThin(path.join(path.dirname(s.rel), rec.id), rec); // <root>/served/<recut id>/ beside <root>/served/<base id>/
  const out = path.join(s.root, "got");
  let r = run("fetch-release.mjs", ["--from", fr, "--out", out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`flat layout from .*base checked, files outside tools/ from ${esc(s.rel)}$`, "m"));
  r = run("verify-release.mjs", ["--release", out, "--deep", "--base", s.rel]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("fetch refuses, writing nothing: a base that is not the pinned one, a record off its base, an unlocatable base, an empty --base-from, --base-from without a base", () => {
  const s = stageBase();
  const rec = recutRecord(s.record);
  const refused = (args, status, re, label) => {
    const out = path.join(s.root, `out-${label}`);
    const r = run("fetch-release.mjs", [...args, "--out", out]);
    assert.equal(r.status, status, `${label}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, re, label);
    assert.equal(fs.existsSync(out), false, `${label}: nothing written`);
  };
  // 1. the sibling holds another first cut: consistent self-digest, other content
  let { fb, fr } = writeFlat(s, rec, "resigned");
  fs.writeFileSync(path.join(fb, "release.json"), serializeRelease(resign(s.record, (r) => { r.notes = ["edited"]; })));
  refused(["--from", fr], 1, /refused against its base lean-v4\.34\.0-a8817d0 at [\s\S]*digest is sha256:[0-9a-f]{64}, the record pins sha256:/, "resigned");
  // 2. a base whose gate.commit differs, re-signed, and a re-cut pinning exactly that base
  const g = resign(s.record, (r) => { r.gate.commit = "f".repeat(40); });
  ({ fb, fr } = writeFlat(s, recutRecord(s.record, (r) => { r.base.digest = g.digest; }), "gate"));
  fs.writeFileSync(path.join(fb, "release.json"), serializeRelease(g));
  refused(["--from", fr], 1, /the base's release\.json: gate\.commit ≠ kernel\.commit[\s\S]*gate\.commit differs from the base's/, "gate");
  // 3. the -r3 record itself is off its base: a pack note (the staged -r2's real drift against e1a79c1)
  ({ fr } = writeFlat(s, recutRecord(s.record, (r) => { r.packs[0].note = "transport copied from served bytes, not re-packed"; }), "drift"));
  refused(["--from", fr], 1, /1 problem\(s\):\n {2}packs differs from the base's/, "drift");
  // 4. no sibling: renamed away, or --from does not end in the re-cut's id
  ({ fb, fr } = writeFlat(s, rec, "renamed"));
  const moved = `${fb}.moved`;
  fs.renameSync(fb, moved);
  refused(["--from", fr], 1, /cannot read the base's release\.json from .*pass --base-from <the base release's download URL or dir>/, "renamed");
  const elsewhere = path.join(s.root, "renamed", "thin");
  fs.renameSync(fr, elsewhere);
  refused(["--from", elsewhere], 1, /does not end in lean-v4\.34\.0-a8817d0-r3, so its sibling cannot be found — pass --base-from/, "elsewhere");
  const out = path.join(s.root, "out-base-from");
  let r = run("fetch-release.mjs", ["--from", elsewhere, "--out", out, "--base-from", moved, "--id", rec.id, "--digest", rec.digest]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`base checked, files outside tools/ from ${esc(moved)}`));
  assert.equal(run("verify-release.mjs", ["--release", out, "--base", moved]).status, 0);
  // 5. an empty --base-from is usage, not "use the default"
  ({ fr } = writeFlat(s, rec));
  refused(["--from", fr, "--base-from", ""], 2, /--base-from was given without a value: refusing to guess the base/, "empty");
  refused(["--from", fr, "--base-from="], 2, /refusing to guess the base/, "empty-eq");
  // 6. --base-from for a record without a base is a refusal, not a silent no-op
  refused(["--from", s.rel, "--base-from", s.rel], 1, /--base-from was given, but lean-v4\.34\.0-a8817d0 is not a release by reference/, "no-base");
  r = run("fetch-release.mjs", ["--from", fr, "--out", path.join(s.root, "out-unknown"), "--only", "nope"]);
  assert.equal(r.status, 2); assert.equal(fs.existsSync(path.join(s.root, "out-unknown")), false, "an unknown group is refused before the base is read");
});

test("a base record that breaks the check's assumptions is a named refusal, never a crash: a null files[] entry, a record too deep to digest", (t) => {
  const s = stageBase();
  // 1. a null entry in the base's files[], re-signed, and a re-cut pinning exactly that record
  const nulled = resign(s.record, (r) => { r.files.unshift(null); });
  const rec = recutRecord(s.record, (r) => { r.base.digest = nulled.digest; });
  let { fb, fr } = writeFlat(s, rec, "nulled");
  fs.writeFileSync(path.join(fb, "release.json"), serializeRelease(nulled));
  let out = path.join(s.root, "out-nulled");
  let r = run("fetch-release.mjs", ["--from", fr, "--out", out]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /^fetch: lean-v4\.34\.0-a8817d0-r3 refused against its base lean-v4\.34\.0-a8817d0 at .* — 1 problem\(s\):\n {2}the base's release\.json: files\[\]: undefined is not a safe release path$/m);
  assert.doesNotMatch(r.stderr, /TypeError|\n {4}at /);
  assert.equal(fs.existsSync(out), false, "nothing written");
  const mirror = writeServed(path.join(s.root, "mirror", rec.id), s, rec);
  r = run("verify-release.mjs", ["--release", mirror, "--base", fb]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^FAIL {2}release by reference of lean-v4\.34\.0-a8817d0 .* — the base's release\.json: files\[\]: undefined is not a safe release path$/m);
  assert.doesNotMatch(r.stdout, /cannot read/);
  // 2. the pinned id and digest over a record nested too deep for JSON.stringify(…, null, 2):
  //    it parses, and then the check itself throws (a RangeError) — refused by name all the same
  const deep = `${'{"a":'.repeat(100_000)}1${"}".repeat(100_000)}`;
  const text = JSON.stringify({ ...s.record, mathlib: "DEEP" }).replace('"DEEP"', deep);
  const parsed = JSON.parse(text); // V8's JSON.parse is iterative: any depth parses
  try { JSON.stringify(parsed, null, 2); t.diagnostic("this V8 digests the deep record: its half is moot"); return; } catch { /* the case at hand */ }
  const plain = recutRecord(s.record);
  ({ fb, fr } = writeFlat(s, plain, "deep"));
  fs.writeFileSync(path.join(fb, "release.json"), text);
  out = path.join(s.root, "out-deep");
  r = run("fetch-release.mjs", ["--from", fr, "--out", out]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /^fetch: lean-v4\.34\.0-a8817d0-r3 refused against its base lean-v4\.34\.0-a8817d0 at .* — 1 problem\(s\):\n {2}the base's release\.json could not be checked: Maximum call stack size exceeded$/m);
  assert.doesNotMatch(r.stderr, /\n {4}at /);
  assert.equal(fs.existsSync(out), false, "nothing written");
  r = run("verify-release.mjs", ["--release", writeServed(path.join(s.root, "mirror-deep", plain.id), s, plain), "--base", fb]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^FAIL {2}release by reference of .* — the base's release\.json .*release\.json could not be checked: Maximum call stack size exceeded$/m);
  assert.doesNotMatch(r.stdout, /cannot read/);
});

test("fetch's refusals after its first read end by exitCode, never process.exit() (Node 26.3's exit deadlock)", () => {
  const s = stageBase();
  const rec = recutRecord(s.record);
  // a preload that makes every process.exit() call visible (synchronously, before the exit)
  const hook = path.join(s.root, "loud-exit.mjs");
  fs.writeFileSync(hook, 'import fs from "node:fs";\nconst exit = process.exit;\nprocess.exit = (code) => { fs.writeSync(2, `process.exit(${code}) called\\n`); return exit(code); };\n');
  let n = 0;
  const fetchLoud = (args) => {
    const out = path.join(s.root, `out-${n++}`);
    return { out, ...runNode(path.join(pkg, "fetch-release.mjs"), [...args, "--out", out], ["--import", pathToFileURL(hook).href]) };
  };
  // the hook works: usage is refused before any read, by process.exit(2)
  let r = fetchLoud(["--from", s.rel, "--base-from", ""]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /^process\.exit\(2\) called$/m);
  const { fb, fr } = writeFlat(s, rec, "loud");
  const drift = writeFlat(s, recutRecord(s.record, (x) => { x.packs[0].note = "drift"; }), "loud-drift").fr;
  const elsewhere = writeThin(path.join(s.root, "loud-elsewhere", "thin"), rec);
  const orphan = writeThin(path.join(s.root, "loud-orphan", rec.id), rec);
  const cases = [
    ["--base-from on a record without a base", ["--from", s.rel, "--base-from", fb], 1, /is not a release by reference/],
    ["no sibling to be found", ["--from", elsewhere], 1, /its sibling cannot be found/],
    ["an unreadable base", ["--from", orphan], 1, /cannot read the base's release\.json/],
    ["a base it refuses", ["--from", drift], 1, /refused against its base/],
    ["the record refused", ["--from", fr, "--id", BASE_ID], 1, /release is lean-v4\.34\.0-a8817d0-r3, expected/],
    ["an unknown group", ["--from", fr, "--only", "nope"], 2, /unknown --only group/],
  ];
  for (const [label, args, status, re] of cases) {
    r = fetchLoud(args);
    assert.equal(r.status, status, `${label}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, re, label);
    assert.doesNotMatch(r.stderr, /process\.exit\(\d+\) called/, label);
    assert.equal(fs.existsSync(r.out), false, `${label}: nothing written`);
  }
});

test("fetch refuses a tampered base file: the re-cut's record catches it, nothing unverified is left", () => {
  const s = stageBase();
  const rec = recutRecord(s.record);
  const { fb, fr } = writeFlat(s, rec);
  const victim = rec.files.find((f) => f.path.startsWith("runtime/chunks/"));
  const b = fs.readFileSync(path.join(fb, path.basename(victim.path))); b[0] ^= 0xff; fs.writeFileSync(path.join(fb, path.basename(victim.path)), b);
  const out = path.join(s.root, "got");
  const r = run("fetch-release.mjs", ["--from", fr, "--out", out, "--only", "runtime-chunks"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`${esc(victim.path)}: expected \\d+ bytes sha256`));
  assert.match(r.stdout, /FETCH FAILED/);
  // the base's record was fine, so release.json was written (A5); the tampered file was not
  assert.equal(fs.existsSync(path.join(out, victim.path)), false);
  assert.deepEqual(partials(out), []);
});

test("a rerun into the same --out, once the tampered base file is restored, keeps what the first run verified and completes from both sources", () => {
  const s = stageBase();
  const rec = recutRecord(s.record);
  const { fb, fr } = writeFlat(s, rec);
  // the last chunk in path order: every base file before it is fetched, and kept, by the first run
  const last = rec.files.filter((f) => f.path.startsWith("runtime/chunks/")).map((f) => f.path).sort().at(-1);
  const victim = path.join(fb, path.basename(last));
  const good = fs.readFileSync(victim);
  const bad = Buffer.from(good); bad[0] ^= 0xff; fs.writeFileSync(victim, bad);
  const out = path.join(s.root, "got");
  const args = ["--from", fr, "--out", out, "--only", "all", "--id", rec.id, "--digest", rec.digest];
  let r = run("fetch-release.mjs", args);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`${esc(last)}: expected \\d+ bytes sha256`));
  const kept = rec.files.map((f) => f.path).filter((p) => fs.existsSync(path.join(out, p)));
  assert.ok(kept.length > 3 && kept.every((p) => !isRecutOwnPath(p) && p < last), `the first run kept base files before ${last}: ${kept.join(", ")}`);
  assert.deepEqual(partials(out), []);
  fs.writeFileSync(victim, good);
  r = run("fetch-release.mjs", args);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`^${rec.files.length} files verified \\(${rec.files.length - kept.length} fetched, ${kept.length} already present\\)$`, "m"));
  assert.equal(fs.readFileSync(path.join(out, RECUT_TGZ), "utf8"), RECUT_TGZ_BYTES, "the re-cut's own tgz, from --from");
  r = run("verify-release.mjs", ["--release", out, "--deep", "--base", fb]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("a flat fetch of tools/ alone needs no base; anything else does", () => {
  const s = stageBase();
  const rec = recutRecord(s.record);
  const fr = writeThin(path.join(s.root, "alone", rec.id), rec); // no base anywhere beside it
  const out = path.join(s.root, "got");
  let r = run("fetch-release.mjs", ["--from", fr, "--out", out, "--only", "tools", "--id", rec.id, "--digest", rec.digest]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /release by reference of lean-v4\.34\.0-a8817d0 \(sha256:[0-9a-f]{16}…\), only tools\/ selected: base not compared \(--base-from compares\)/);
  assert.equal(fs.readFileSync(path.join(out, RECUT_TGZ), "utf8"), RECUT_TGZ_BYTES);
  assert.deepEqual(fs.readdirSync(out).sort(), ["release.json", "tools"]);
  r = run("fetch-release.mjs", ["--from", fr, "--out", path.join(s.root, "x"), "--only", "tools,lists"]);
  assert.equal(r.status, 1); assert.match(r.stderr, /cannot read the base's release\.json/); assert.equal(fs.existsSync(path.join(s.root, "x")), false);
  r = run("fetch-release.mjs", ["--from", fr, "--out", path.join(s.root, "y"), "--only", "runtime"]);
  assert.equal(r.status, 1, "the artifact layout reads the base's runtime"); assert.equal(fs.existsSync(path.join(s.root, "y")), false);
  // --base-from compares even when no file comes from it
  r = run("fetch-release.mjs", ["--from", fr, "--out", path.join(s.root, "z"), "--only", "tools", "--base-from", s.rel]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /, base checked$/m);
});

test("a complete served -r3 mirror is read alone; --base-from compares it with the base", () => {
  const s = stageBase();
  const rec = recutRecord(s.record);
  const dir = writeServed(path.join(s.root, "mirror", rec.id), s, rec); // no base anywhere beside it
  let r = run("verify-release.mjs", ["--release", dir, "--deep"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const a = path.join(s.root, "a");
  r = run("fetch-release.mjs", ["--from", dir, "--out", a, "--id", rec.id, "--digest", rec.digest]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /served layout from .*; release by reference of lean-v4\.34\.0-a8817d0 \(sha256:[0-9a-f]{16}…\), served, complete under its own id: base not compared \(--base-from compares\)/);
  assert.equal(run("verify-release.mjs", ["--release", a, "--deep", "--base", s.rel]).status, 0);
  r = run("fetch-release.mjs", ["--from", dir, "--out", path.join(s.root, "b"), "--only", "lists", "--base-from", s.rel]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /served layout from .*, base checked$/m);
  // a wrong base: the re-cut itself, and another first cut
  r = run("fetch-release.mjs", ["--from", dir, "--out", path.join(s.root, "c"), "--only", "lists", "--base-from", dir]);
  assert.equal(r.status, 1); assert.match(r.stderr, /the base's release\.json is "lean-v4\.34\.0-a8817d0-r3", the record names lean-v4\.34\.0-a8817d0/);
  assert.equal(fs.existsSync(path.join(s.root, "c")), false);
  const other = path.join(s.root, "other");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "release.json"), serializeRelease(resign(s.record, (x) => { x.notes = ["another cut"]; })));
  r = run("fetch-release.mjs", ["--from", dir, "--out", path.join(s.root, "d"), "--base-from", other]);
  assert.equal(r.status, 1); assert.match(r.stderr, /the record pins/); assert.equal(fs.existsSync(path.join(s.root, "d")), false);
});

test("over HTTP: a GitHub-style /releases/download/<id>/ URL finds its base at /releases/download/<base id>/", async () => {
  const s = stageBase();
  const rec = recutRecord(s.record);
  writeFlat(s, rec);
  const seen = [];
  const server = http.createServer((req, res) => {
    const m = /^\/o\/r\/releases\/download\/([^/]+)\/([^/]+)$/.exec(new URL(req.url, "http://x").pathname);
    seen.push(m ? `${m[1]}/${m[2]}` : req.url);
    const p = m && path.join(s.root, "flat", m[1], m[2]);
    if (!p || !fs.existsSync(p)) { res.statusCode = 404; return res.end(); }
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/o/r/releases/download/${rec.id}/`;
    const out = path.join(s.root, "got");
    let r = await runAsync("fetch-release.mjs", ["--from", url, "--out", out, "--only", "runtime,tools", "--id", rec.id, "--digest", rec.digest]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`files outside tools/ from ${esc(url.replace(rec.id, BASE_ID))}`));
    assert.ok(fs.readFileSync(path.join(out, "bin", "lean.wasm")).equals(fs.readFileSync(path.join(s.bin, "lean.wasm"))), "lean.wasm rebuilt");
    assert.equal(fs.readFileSync(path.join(out, RECUT_TGZ), "utf8"), RECUT_TGZ_BYTES);
    const tgzName = path.basename(RECUT_TGZ);
    assert.deepEqual(seen.filter((q) => q.startsWith(`${rec.id}/`)).sort(), [`${rec.id}/${tgzName}`, `${rec.id}/release.json`], "only the record and the tgz from the re-cut");
    assert.ok(seen.includes(`${BASE_ID}/release.json`) && seen.includes(`${BASE_ID}/runtime-manifest.json`) && seen.includes(`${BASE_ID}/leanmake`));
    assert.ok(seen.some((q) => q.startsWith(`${BASE_ID}/lean.wasm.`)), "chunks from the base");
    assert.ok(!seen.some((q) => q.startsWith(`${BASE_ID}/lean4-wasm64-`)), "never the base's own tgz");
    // tools/ alone: nothing from the base, not even its record
    seen.length = 0;
    r = await runAsync("fetch-release.mjs", ["--from", url, "--out", path.join(s.root, "tools-only"), "--only", "tools"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(seen.sort(), [`${rec.id}/${tgzName}`, `${rec.id}/release.json`]);
  } finally {
    server.close();
  }
});

test("over HTTP: --base-from a served URL (an R2-style prefix) is read by path, never the sibling; --layout served on a thin flat -r3 reads no base and fails", async () => {
  const s = stageBase();
  const rec = recutRecord(s.record);
  writeFlat(s, rec); // the flat sibling exists too: it must not be read
  const seen = [];
  // /<owner>/r/releases/download/<id>/<name>: GitHub-style, flat; /site/lean4-wasm64/<id>/<path>: served
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x").pathname;
    seen.push(u);
    const gh = /^\/[a-z]+\/r\/releases\/download\/([^/]+)\/([^/]+)$/.exec(u);
    const site = /^\/site\/lean4-wasm64\/([^/]+)\/([A-Za-z0-9._/+-]+)$/.exec(u);
    const p = gh ? path.join(s.root, "flat", gh[1], gh[2]) : site ? path.join(s.root, "served", site[1], site[2]) : null;
    if (!p || !p.startsWith(s.root + path.sep) || !fs.existsSync(p) || !fs.statSync(p).isFile()) { res.statusCode = 404; return res.end(); }
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const host = `http://127.0.0.1:${server.address().port}`;
    const from = `${host}/o/r/releases/download/${rec.id}/`, baseFrom = `${host}/site/lean4-wasm64/${BASE_ID}/`;
    const forcedFrom = `${host}/x/r/releases/download/${rec.id}/`;
    const out = path.join(s.root, "got"), forced = path.join(s.root, "forced");
    // at once: the forced fetch spends ~15 s in fetch's retries of the file its served path misses
    const [r, f] = await Promise.all([
      runAsync("fetch-release.mjs", ["--from", from, "--base-from", baseFrom, "--out", out, "--id", rec.id, "--digest", rec.digest]),
      runAsync("fetch-release.mjs", ["--from", forcedFrom, "--layout", "served", "--out", forced, "--only", "lists"]),
    ]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`flat layout from ${esc(from)}; release by reference of ${esc(BASE_ID)} \\(sha256:[0-9a-f]{16}…\\), base checked, files outside tools/ from ${esc(baseFrom)}$`, "m"));
    const tgzName = path.basename(RECUT_TGZ);
    assert.deepEqual(seen.filter((q) => q.startsWith("/o/")).sort(), [`/o/r/releases/download/${rec.id}/${tgzName}`, `/o/r/releases/download/${rec.id}/release.json`], "from --from: the record and the tgz only; the sibling never");
    const fromSite = seen.filter((q) => q.startsWith("/site/")).map((q) => q.slice(`/site/lean4-wasm64/${BASE_ID}/`.length)).sort();
    assert.deepEqual(fromSite, ["release.json", ...rec.files.filter((x) => !isRecutOwnPath(x.path)).map((x) => x.path)].sort(), "from the served base: its record and every shared file, by path");
    const v = run("verify-release.mjs", ["--release", out, "--deep", "--base", s.rel]);
    assert.equal(v.status, 0, v.stdout + v.stderr);
    // --layout served: --from is taken as complete under the re-cut's own id, so no base is read,
    // and a thin GitHub release does not hold the served paths
    assert.equal(f.status, 1, f.stdout + f.stderr);
    assert.match(f.stdout, new RegExp(`served layout from ${esc(forcedFrom)}; release by reference of ${esc(BASE_ID)} .*served, complete under its own id: base not compared`));
    assert.match(f.stderr, /fetch: FAILED — HTTP 404 for .*\/lists\/essential-modules\.txt/);
    const forcedSeen = seen.filter((q) => q.startsWith("/x/"));
    assert.ok(forcedSeen.includes(`/x/r/releases/download/${rec.id}/release.json`) && forcedSeen.includes(`/x/r/releases/download/${rec.id}/lists/essential-modules.txt`), forcedSeen.join(", "));
    assert.ok(forcedSeen.every((q) => q.startsWith(`/x/r/releases/download/${rec.id}/`)), `no base request: ${forcedSeen.join(", ")}`);
  } finally {
    server.close();
  }
});

test("verify --base: usage, a record without a base, a wrong base; --json carries base.compared", () => {
  const s = stageBase();
  const rec = recutRecord(s.record);
  const dir = writeServed(path.join(s.root, "mirror", rec.id), s, rec);
  for (const args of [["--base", ""], ["--base="], ["--base"]]) {
    const r = run("verify-release.mjs", ["--release", dir, ...args]);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--base was given without a value/);
  }
  let r = run("verify-release.mjs", ["--release", s.rel, "--base", s.rel]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL {2}--base was given, but lean-v4\.34\.0-a8817d0 is not a release by reference/m);
  const other = path.join(s.root, "other.json");
  fs.writeFileSync(other, serializeRelease(resign(s.record, (x) => { x.notes = ["another cut"]; })));
  r = run("verify-release.mjs", ["--release", dir, "--base", other]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL {2}release by reference of lean-v4\.34\.0-a8817d0 .* — the base's release\.json digest is sha256:[0-9a-f]{64}, the record pins sha256:/m);
  r = run("verify-release.mjs", ["--release", dir, "--base", path.join(s.root, "nowhere")]);
  assert.equal(r.status, 1); assert.match(r.stdout, /^FAIL {2}release by reference of .*cannot read the base's release\.json/m);
  r = run("verify-release.mjs", ["--release", dir, "--base", dir]); // the re-cut is not its own base
  assert.equal(r.status, 1); assert.match(r.stdout, /names a base of its own/);
  let n = 0;
  const json = (args) => {
    const j = path.join(s.root, `verify-${n++}.json`);
    const v = run("verify-release.mjs", [...args, "--json", j]);
    return { status: v.status, j: JSON.parse(fs.readFileSync(j, "utf8")) };
  };
  let v = json(["--release", dir, "--base", s.rel]);
  assert.equal(v.status, 0);
  assert.deepEqual(v.j.base, { id: BASE_ID, digest: s.record.digest, compared: true });
  v = json(["--release", dir]);
  assert.equal(v.status, 0);
  assert.deepEqual(v.j.base, { id: BASE_ID, digest: s.record.digest, compared: false });
  v = json(["--release", s.rel]);
  assert.equal(v.status, 0);
  assert.equal(v.j.base, null);
});

// the -r2 tools (lean-v4.34.0-e1a79c1-r2's tools.commit): the last ones written before `base` existed
const REPO = path.resolve(pkg, "..", "..");
const R2_TOOLS = "2050a9ca0c";
const git = (...args) => spawnSync("git", ["-C", REPO, ...args], { timeout: TIMEOUT_MS, maxBuffer: 256 << 20 });
const haveR2Tools = git("cat-file", "-e", `${R2_TOOLS}^{commit}`).status === 0;

test("older readers fail closed, end to end: the -r2 tools' own fetch refuses a tools re-cut before writing anything, their verify calls it malformed", { skip: haveR2Tools ? false : `commit ${R2_TOOLS} (the -r2 tools) is not in this clone (a shallow checkout?)` }, () => {
  const old = mkdtemp("l4w-r2-tools-");
  const a = git("archive", "--format=tar", R2_TOOLS, "wasm64-build/js");
  assert.equal(a.status, 0, String(a.stderr));
  const x = spawnSync("tar", ["-x", "-C", old], { input: a.stdout, timeout: TIMEOUT_MS });
  assert.equal(x.status, 0, String(x.stderr));
  const tool = (name) => path.join(old, "wasm64-build", "js", name);
  const s = stageBase();
  const rec = recutRecord(s.record);
  const { fr } = writeFlat(s, rec);
  const mirror = writeServed(path.join(s.root, "mirror", rec.id), s, rec);
  for (const [label, from] of [["flat", fr], ["served", mirror]]) {
    const out = path.join(s.root, `old-${label}`);
    const r = runNode(tool("fetch-release.mjs"), ["--from", from, "--out", out, "--id", rec.id, "--digest", rec.digest]);
    assert.equal(r.status, 1, `${label}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^fetch: release\.json refused — \d+ problem\(s\):\n[\s\S]*^ {2}unknown keys: base$/m, label);
    assert.equal(fs.existsSync(out), false, `${label}: nothing written`);
  }
  const v = runNode(tool("verify-release.mjs"), ["--release", mirror, "--deep"]);
  assert.equal(v.status, 1, v.stdout + v.stderr);
  assert.match(v.stdout, /^FAIL .*unknown keys: base/m);
  assert.match(v.stdout, new RegExp(`RELEASE FAILED \\(malformed release\\.json\\) ${esc(RECUT_ID)}`));
  // and it is `base` they refuse: the same tools verify the first cut
  const ok = runNode(tool("verify-release.mjs"), ["--release", s.rel]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});

test("help: fetch names --base-from and a fresh --out, verify names --base", () => {
  let r = run("fetch-release.mjs", ["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\[--base-from <url\|dir>\]/);
  assert.match(r.stdout, /--base-from <src> {2}a release by reference/);
  // the sibling default is for a flat --from that reads files from the base; nothing else reads a sibling
  assert.match(r.stdout, /Flat --from:\s+every file it does not own \(outside tools\/; a runtime release by reference also owns\s+runtime\/ and lean-lib\) comes from there \(default: the sibling <…>\/<base id>\/ when --from\s+ends in its id\)\. Served --from, or only its own files: compares with it \(no default\)/);
  assert.match(r.stdout, /--out <dir> .*a fresh dir/);
  r = run("verify-release.mjs", ["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--base <path> {5}a release by reference/);
});
