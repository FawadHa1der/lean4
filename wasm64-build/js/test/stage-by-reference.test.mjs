// stage-release.sh --base, a release by reference (formats/release.md, "Release by reference") of
// either kind: a tools re-cut (--recut) and a runtime release by reference (--runtime). Its node steps
// (wasm64-build/stage-by-reference.mjs) as unit tests on small synthetic mirrors and on the committed
// e1a79c1 record; then the script itself, end to end, on a small synthetic first cut, from scratch
// copies of the repository whose paths hold spaces. Shims stand in for git (read-only answers, with
// knobs for the refusals), npm (packs the copy's js/, with a stand-in gate.mjs: no wasm runtime here),
// gh and rclone (they only record their argv). No network, and nothing outside the test's temp dirs
// is written.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalRelease, checkRecutBase, checkReleaseRecord, isOwnPath, isRecutOwnPath, serializeRelease, sha256sums } from "../release-record.mjs";
import { buildIdFromSha256 } from "../artifact-id.mjs";
import { K0040, WASM0040, runtimeRecutOf } from "./runtime-recut-fixture.mjs";
import { olean } from "./olean-fixture.mjs";
import {
  baseFields, baseProblems, checkMirror, cloneShared, finalCheck, isWithin, mirrorMisses, mirrorOverlaps, physicalPath,
  recutConfig, writeRecutConfig,
} from "../../stage-by-reference.mjs";
import { contentTypeOf } from "../../publish-release.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");     // wasm64-build/js
const build = path.resolve(pkg, "..");    // wasm64-build
const SBR = path.join(build, "stage-by-reference.mjs");
const E1_FILE = path.join(build, "releases", "lean-v4.34.0-e1a79c1.json");
const E1 = JSON.parse(fs.readFileSync(E1_FILE, "utf8"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const made = [];
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
const live = new Set(); // process groups of interrupted stagings, killed whatever a test did
after(() => {
  for (const pid of live) { try { process.kill(-pid, "SIGKILL"); } catch {} }
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

/** A tiny mirror: <root>/<id>/ holding 3 shared files, a tools/ one, and 2 the record does not list. */
function tinyMirror(root, id = "lean-v9.9.9-abcdef0", { dir = path.join(root, id), n = 3 } = {}) {
  const put = (p, data) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), data);
    return { path: p, bytes: Buffer.byteLength(data), sha256: sha(data) };
  };
  const shared = ["lists/l.txt", "profiles/p.part-000", "runtime/chunks/c0"];
  for (let i = 3; i < n; i++) shared.push(`runtime/chunks/c${i}`);
  const files = [...shared.map((p, i) => put(p, `bytes of ${p} ${"x".repeat(i)}`)), put("tools/old.tgz", "old tools")];
  put("stray/x", "never staged"); put("runtime/unlisted", "never staged");
  const record = { id, files };
  const file = path.join(root, `${id}.record.json`);
  fs.writeFileSync(file, JSON.stringify(record));
  return { dir, file, files, record };
}
/** Every path under `d` (relative, sorted), with its size: a snapshot to compare before and after. */
function snapshot(d) {
  const out = [];
  (function walk(q) {
    for (const e of fs.readdirSync(q, { withFileTypes: true })) {
      const p = path.join(q, e.name);
      out.push(`${path.relative(d, p)}${e.isDirectory() ? "/" : ` ${fs.lstatSync(p).size}`}`);
      if (e.isDirectory()) walk(p);
    }
  })(d);
  return out.sort();
}
/** Whether two names are one directory, by stat alone (the filesystem probe; not the code under test). */
const sameDir = (a, b) => { try { const [x, y] = [fs.statSync(a), fs.statSync(b)]; return x.dev === y.dev && x.ino === y.ino; } catch { return false; } };
const filesUnder = (d) => snapshot(d).filter((l) => !l.endsWith("/")).map((l) => l.replace(/ \d+$/, ""));

// ---------- base ----------

test("base: the committed e1a79c1 record is a base of v4.34.0; the step prints the fields the script reads", () => {
  assert.deepEqual(baseProblems(E1, "v4.34.0"), []);
  const fields = baseFields(E1_FILE, "v4.34.0");
  assert.equal(fields, [E1.id, E1.digest, E1.kernel.commit, E1.gate.wasmSha256, E1.packs.find((k) => k.id === "lean-lib").rawSha256, E1.docker.recipeCommit].join(" "));
  assert.equal(fields.split(" ").length, 6, "the script reads 6 fields");
  // a base without a recipe commit prints "-" (the runtime kind then refuses it)
  const root = mkdtemp("l4w-sbr-fields-");
  const file = path.join(root, "release.json");
  const { recipeCommit: _r, ...docker } = E1.docker;
  const { digest: _d, ...rest } = E1;
  fs.writeFileSync(file, JSON.stringify(canonicalRelease({ ...rest, docker })));
  assert.equal(baseFields(file, "v4.34.0").split(" ").at(-1), "-");
});

test("base: refuses another tag, a re-cut, a base with a base, another package, no lean-lib — naming the file", () => {
  const refused = (b, tag, re) => assert.ok(baseProblems(b, tag).some((q) => re.test(q)), `${re}: ${baseProblems(b, tag).join(" | ")}`);
  refused(E1, "v4.35.0", /^it is lean-v4\.34\.0-e1a79c1, not a first cut of v4\.35\.0 /);
  const r2 = JSON.parse(fs.readFileSync(path.join(build, "releases", "lean-v4.34.0-e1a79c1-r2.json"), "utf8"));
  refused(r2, "v4.34.0", /^it is lean-v4\.34\.0-e1a79c1-r2, not a first cut of v4\.34\.0/);
  refused({ ...E1, base: { id: "lean-v4.34.0-0000000", digest: E1.digest } }, "v4.34.0", /^it names a base of its own \(lean-v4\.34\.0-0000000\): a base names no base of its own$/);
  refused(E1, "v4.35.0", /: a release by reference names a first cut$/);
  refused({ ...E1, tools: { ...E1.tools, package: "other" } }, "v4.34.0", /^its tools are "other", not lean4-wasm64: a release by reference ships the base's package$/);
  refused({ ...E1, packs: E1.packs.filter((k) => k.id !== "lean-lib") }, "v4.34.0", /^it has no lean-lib pack/);
  refused(null, "v4.34.0", /^it is undefined, not a first cut/);
  const root = mkdtemp("l4w-sbr-base-");
  const file = path.join(root, "release.json");
  fs.writeFileSync(file, JSON.stringify({ ...E1, packs: E1.packs.filter((k) => k.id !== "lean-lib") }));
  assert.throws(() => baseFields(file, "v4.34.0"), new RegExp(`^Error: ${escapeRe(file)}: .*it has no lean-lib pack`));
});

// ---------- mirror ----------

test("mirror: a complete mirror beside --out passes and writes nothing; one that is, holds or lies in a dir staging replaces is refused", () => {
  const root = mkdtemp("l4w-sbr-mirror-");
  const m = tinyMirror(root);
  const out = path.join(root, "out");
  checkMirror(m.file, m.dir, out, "lean-v9.9.9-abcdef0-r2");
  assert.equal(fs.existsSync(out), false, "the check writes nothing");
  const overlapping = (mirror, o, id, why) => {
    assert.throws(() => checkMirror(m.file, mirror, o, id), /^Error: it overlaps .*, which staging replaces \(another --out\)$/, why);
    assert.notDeepEqual(mirrorOverlaps(mirror, o, id), [], why);
  };
  // the release dir is the mirror
  overlapping(m.dir, root, path.basename(m.dir), "<out>/<id> is the mirror");
  assert.deepEqual(mirrorOverlaps(m.dir, root, path.basename(m.dir)), [physicalPath(m.dir)]);
  // the release dir (or its gate / tools dir) lies inside the mirror
  overlapping(m.dir, m.dir, "lean-v9.9.9-abcdef0-r2", "--out is the mirror");
  overlapping(m.dir, path.join(m.dir, "runtime"), "x", "--out inside the mirror");
  // the mirror lies inside a dir staging replaces
  const inGate = tinyMirror(root, "inner", { dir: path.join(root, "o2", "lean-v9.9.9-abcdef0-r2.gate", "inner") });
  assert.throws(() => checkMirror(inGate.file, inGate.dir, path.join(root, "o2"), "lean-v9.9.9-abcdef0-r2"), /lean-v9\.9\.9-abcdef0-r2\.gate, which staging replaces/);
  // another name of the same dir: a symlink
  fs.symlinkSync(root, path.join(root, "link"));
  overlapping(m.dir, path.join(root, "link"), path.basename(m.dir), "--out through a symlink");
  // the dirs it compares are the three staging removes, nothing else
  assert.deepEqual(mirrorOverlaps(m.dir, root, "elsewhere"), []);
});

test("mirror: another case of --out names the mirror on a case-insensitive filesystem (macOS's default APFS)", (t) => {
  const root = mkdtemp("l4w-sbr-case-");
  // the review's O5: --out spelled in another case, so that <out>/<id> is the mirror itself
  const m = tinyMirror(root, "Mirrors", { dir: path.join(root, "O5", "lean-v9.9.9-abcdef0-r2") });
  const other = path.join(root, "o5");
  if (!sameDir(other, path.join(root, "O5"))) return t.skip("case-sensitive filesystem");
  assert.throws(() => checkMirror(m.file, m.dir, other, "lean-v9.9.9-abcdef0-r2"), /^Error: it overlaps .*O5\/lean-v9\.9\.9-abcdef0-r2, which staging replaces/);
  // and the other way round: the mirror spelled in another case, inside --out's <id>.tools
  const n = tinyMirror(root, "n", { dir: path.join(root, "q", "lean-v9.9.9-abcdef0-r2.tools", "m") });
  assert.throws(() => checkMirror(n.file, path.join(root, "Q", "LEAN-V9.9.9-ABCDEF0-R2.TOOLS", "M"), path.join(root, "q"), "lean-v9.9.9-abcdef0-r2"), /which staging replaces/);
});

test("mirror: a firmlink name of --out (/System/Volumes/Data/…) is the same dir, though realpath keeps its spelling", (t) => {
  const root = mkdtemp("l4w-sbr-firm-");
  const m = tinyMirror(root, "m", { dir: path.join(root, "lean-v9.9.9-abcdef0-r2") });
  const alias = `/System/Volumes/Data${physicalPath(root)}`;
  if (process.platform !== "darwin" || !sameDir(alias, root)) return t.skip("no firmlinked data volume here");
  assert.throws(() => checkMirror(m.file, m.dir, alias, "lean-v9.9.9-abcdef0-r2"), /which staging replaces/);
});

test("isWithin: by identity, also of a path that does not exist yet; never of what does not exist", () => {
  const root = mkdtemp("l4w-sbr-within-");
  fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
  assert.equal(isWithin(path.join(root, "a"), path.join(root, "a")), true);
  assert.equal(isWithin(path.join(root, "a", "b"), path.join(root, "a")), true);
  assert.equal(isWithin(path.join(root, "a", "b", "not", "yet"), path.join(root, "a")), true);
  assert.equal(isWithin(path.join(root, "a"), path.join(root, "a", "b")), false);
  assert.equal(isWithin(path.join(root, "a"), path.join(root, "nothing")), false);
  assert.equal(isWithin(path.join(root, "ab"), path.join(root, "a")), false, "a prefix of the name is not an ancestor");
  assert.equal(physicalPath(path.join(root, "a", "x", "y")), path.join(fs.realpathSync.native(root), "a", "x", "y"));
});

test("mirror: a file missing, of another size, a symlink or a directory is refused; tools/ and unlisted files are not read", () => {
  const root = mkdtemp("l4w-sbr-miss-");
  const m = tinyMirror(root, "lean-v9.9.9-abcdef0", { n: 8 });
  fs.rmSync(path.join(m.dir, "tools"), { recursive: true });
  assert.deepEqual(mirrorMisses(m.record, m.dir), [], "tools/ is the re-cut's own: not needed");
  fs.rmSync(path.join(m.dir, "lists", "l.txt"));
  fs.appendFileSync(path.join(m.dir, "profiles", "p.part-000"), "!");
  fs.rmSync(path.join(m.dir, "runtime", "chunks", "c0"));
  fs.symlinkSync(path.join(m.dir, "stray", "x"), path.join(m.dir, "runtime", "chunks", "c0"));
  fs.rmSync(path.join(m.dir, "runtime", "chunks", "c3"));
  fs.mkdirSync(path.join(m.dir, "runtime", "chunks", "c3"));
  fs.rmSync(path.join(m.dir, "runtime", "chunks", "c4"));
  fs.rmSync(path.join(m.dir, "runtime", "chunks", "c5"));
  const p = m.files.find((f) => f.path === "profiles/p.part-000");
  assert.deepEqual(mirrorMisses(m.record, m.dir), [
    "lists/l.txt missing", `profiles/p.part-000 is ${p.bytes + 1} bytes, not ${p.bytes}`, "runtime/chunks/c0 is not a regular file",
    "runtime/chunks/c3 is not a regular file", "runtime/chunks/c4 missing", "runtime/chunks/c5 missing",
  ]);
  assert.throws(() => checkMirror(m.file, m.dir, path.join(root, "out"), "lean-v9.9.9-abcdef0-r2"),
    /^Error: it does not hold lean-v9\.9\.9-abcdef0's files in the served layout \(fetch --only all\): lists\/l\.txt missing, .*runtime\/chunks\/c4 missing, … \(6 in all\)$/);
});

// ---------- clone ----------

test("clone: only the record's files outside tools/, each its own inode and the record's bytes; other bytes of the same size remove the release dir", async () => {
  const root = mkdtemp("l4w-sbr-clone-");
  const m = tinyMirror(root);
  const rel = path.join(root, "out dir", "lean-v9.9.9-abcdef0-r2");
  const said = await cloneShared(m.file, m.dir, rel);
  assert.equal(said, `3 files cloned from ${m.dir} (0.00 GB), each sha256-checked against lean-v9.9.9-abcdef0's record`);
  assert.deepEqual(filesUnder(rel), ["lists/l.txt", "profiles/p.part-000", "runtime/chunks/c0"]);
  for (const f of m.files.filter((f) => !isRecutOwnPath(f.path))) {
    assert.notEqual(fs.statSync(path.join(rel, f.path)).ino, fs.statSync(path.join(m.dir, f.path)).ino, "never a hard link");
    assert.equal(sha(fs.readFileSync(path.join(rel, f.path))), f.sha256);
  }
  // A7: the size is right, the bytes are not
  const part = path.join(m.dir, "profiles", "p.part-000");
  fs.writeFileSync(part, fs.readFileSync(part, "utf8").toUpperCase());
  await assert.rejects(cloneShared(m.file, m.dir, rel), /^Error: profiles\/p\.part-000: the mirror's bytes are not lean-v9\.9\.9-abcdef0's/);
  assert.equal(fs.existsSync(rel), false, "a failed clone leaves no release dir");
  fs.rmSync(part);
  await assert.rejects(cloneShared(m.file, m.dir, rel), /ENOENT/);
  assert.equal(fs.existsSync(rel), false);
});

// ---------- config ----------

test("config: every field but the re-cut's own is e1a79c1's; the count, notes and tools are the re-cut's", () => {
  const own = { id: `${E1.id}-r3`, recut: "3", checks: "34", version: "4.34.0-e1a79c1-r3", tgz: "lean4-wasm64-4.34.0-e1a79c1-r3.tgz", commit: "b".repeat(40), notes: ["one", "two"] };
  const c = recutConfig(E1, own);
  assert.deepEqual(c, {
    id: `${E1.id}-r3`, upstreamTag: "v4.34.0", kernelCommit: E1.kernel.commit, kernelPatch: "0037",
    kernelRepo: E1.kernel.repo, kernelBranch: E1.kernel.branch, recut: 3, base: { id: E1.id, digest: E1.digest },
    leanVersion: E1.lean.version,
    gate: { commit: E1.gate.commit, wasmSha256: E1.gate.wasmSha256, checks: 34 },
    packs: E1.packs.map((p) => ({ id: p.id, compiler: p.lean.compiler, ...(p.mathlib ? { mathlib: p.mathlib } : {}), ...(p.note ? { note: p.note } : {}) })),
    native64: E1.native64, docker: E1.docker, mathlib: E1.mathlib, modules: E1.modules, hosting: E1.hosting,
    tools: { package: "lean4-wasm64", version: "4.34.0-e1a79c1-r3", tgz: "tools/lean4-wasm64-4.34.0-e1a79c1-r3.tgz", commit: "b".repeat(40) },
    notes: ["one", "two", ...E1.notes],
  });
  // the base's pack notes are kept (the -r2 drift was a note the base lacks)
  assert.deepEqual(c.packs.map((p) => p.note ?? null), E1.packs.map((p) => p.note ?? null));
  for (const checks of ["", "3x", "-1"]) assert.equal(recutConfig(E1, { ...own, checks }).gate.checks, null, JSON.stringify(checks));
  const root = mkdtemp("l4w-sbr-config-");
  const file = path.join(root, "c.json");
  writeRecutConfig(E1_FILE, file, own.id, own.recut, own.checks, own.version, own.tgz, own.commit, own.notes);
  assert.equal(fs.readFileSync(file, "utf8"), `${JSON.stringify(c, null, 2)}\n`);
});

test("config with a runtime: its kernel, gate and lean-lib entry, no recut, a separator before e1a79c1's notes; every other field e1a79c1's", () => {
  const own = { id: "lean-v4.34.0-64d6ebb", checks: "56", version: "4.34.0-64d6ebb", tgz: "lean4-wasm64-4.34.0-64d6ebb.tgz", commit: "b".repeat(40), notes: ["one", "two"] };
  const runtime = { kernelCommit: K0040, kernelPatch: "0040", wasmSha256: WASM0040 };
  const c = recutConfig(E1, { ...own, runtime });
  const plain = recutConfig(E1, { ...own, recut: "3" });
  assert.equal("recut" in c, false);
  const mine = ["kernelCommit", "kernelPatch", "recut", "gate", "packs", "notes"];
  for (const k of Object.keys(plain).filter((x) => !mine.includes(x))) assert.deepEqual(c[k], plain[k], k);
  assert.deepEqual(Object.keys(c), Object.keys(plain).filter((k) => k !== "recut"), "today's key order, without recut");
  assert.deepEqual([c.kernelCommit, c.kernelPatch], [K0040, "0040"]);
  assert.deepEqual(c.gate, { commit: K0040, wasmSha256: WASM0040, checks: 56 });
  // the packs keep their order and notes; lean-lib is its own build's (release.mjs reads the rest from its manifest)
  assert.deepEqual(c.packs, plain.packs.map((p) => (p.id === "lean-lib" ? { id: "lean-lib", compiler: K0040 } : p)));
  assert.deepEqual(c.notes.slice(0, 2), ["one", "two"]);
  assert.equal(c.notes[2], `Notes of ${E1.id} (the base, ${E1.digest}) follow verbatim: what they say of its packs, native64 and lists holds for this release, `
    + "whose files those are; what they say of its runtime and lean-lib is that release's.");
  assert.deepEqual(c.notes.slice(3), E1.notes);
  // without a runtime: today's builder
  assert.deepEqual(plain.notes, ["one", "two", ...E1.notes]);
  assert.equal(plain.kernelCommit, E1.kernel.commit);
  // the step: <own> is a re-cut number or <kernel commit>:<patch>:<lean.wasm sha256>, nothing else
  const root = mkdtemp("l4w-sbr-config-rt-");
  const file = path.join(root, "c.json");
  writeRecutConfig(E1_FILE, file, own.id, `${K0040}:0040:${WASM0040}`, own.checks, own.version, own.tgz, own.commit, own.notes);
  assert.equal(fs.readFileSync(file, "utf8"), `${JSON.stringify(c, null, 2)}\n`);
  for (const bad of ["x", "3a", `${K0040}:40:${WASM0040}`, `${K0040.slice(1)}:0040:${WASM0040}`, `${K0040}:0040`, `${K0040}:0040:${WASM0040}:x`]) {
    assert.throws(() => writeRecutConfig(E1_FILE, path.join(root, "bad.json"), own.id, bad, own.checks, own.version, own.tgz, own.commit),
      /^Error: <own> ".*" is neither a re-cut number nor <kernel commit>:<patch>:<lean\.wasm sha256>$/, bad);
  }
  assert.equal(fs.existsSync(path.join(root, "bad.json")), false);
  const r = spawnSync(process.execPath, [SBR, "config", E1_FILE, path.join(root, "bad.json"), own.id, "x", "4", own.version, own.tgz, own.commit], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^stage-by-reference config: <own> "x" is neither a re-cut number nor /);
  assert.equal(fs.existsSync(path.join(root, "bad.json")), false);
});

// ---------- final ----------

const R3 = `${E1.id}-r3`, R3_TGZ = "tools/lean4-wasm64-4.34.0-e1a79c1-r3.tgz";
/** A -r3 record of e1a79c1, as release.mjs --base writes it. */
const recutOfE1 = (over = {}) => {
  const { digest: _d, ...rest } = structuredClone(E1);
  const files = [...E1.files.filter((f) => !isRecutOwnPath(f.path)), { path: R3_TGZ, bytes: 80_000, sha256: "c".repeat(64) }]
    .sort((x, y) => (x.path < y.path ? -1 : 1));
  return canonicalRelease({ ...rest, id: R3, base: { id: E1.id, digest: E1.digest }, gate: { ...E1.gate, checks: 34 },
    tools: { ...E1.tools, version: "4.34.0-e1a79c1-r3", tgz: R3_TGZ, commit: "b".repeat(40) }, notes: ["own", ...E1.notes], files, ...over });
};
/** <root>/<id>/ with release.json and SHA256SUMS (edited by `sums`); returns the dir and the sidecar prefix. */
function writeRecut(root, record, sums = (s) => s) {
  const rel = path.join(root, record.id);
  fs.rmSync(rel, { recursive: true, force: true });
  fs.mkdirSync(rel, { recursive: true });
  const text = serializeRelease(record);
  fs.writeFileSync(path.join(rel, "release.json"), text);
  fs.writeFileSync(path.join(rel, "SHA256SUMS"), sums(sha256sums([...record.files, { path: "release.json", sha256: sha(text) }])));
  const sidecar = path.join(root, record.id);
  for (const s of ["r2-objects.txt", "r2-manifests.txt"]) fs.rmSync(`${sidecar}.${s}`, { force: true });
  return { rel, sidecar };
}
const lists = (sidecar) => ["r2-objects.txt", "r2-manifests.txt"].filter((s) => fs.existsSync(`${sidecar}.${s}`));

test("final: a -r3 of e1a79c1 differs at release.json and the two tarballs only; the R2 lists split its 138 shared paths by content type", async () => {
  const good = recutOfE1();
  assert.deepEqual(checkReleaseRecord(good), []);
  assert.deepEqual(checkRecutBase(good, E1), []);
  const root = mkdtemp("l4w-sbr-final-");
  const { rel, sidecar } = writeRecut(root, good);
  assert.equal(await finalCheck(E1_FILE, rel, sidecar),
    `only release.json and its own files (tools/) differ from ${E1.id}: SHA256SUMS differs at 3 paths; 139 files, 1 own, 138 shared (130 objects, 8 manifests)`);
  const read = (s) => fs.readFileSync(`${sidecar}.${s}`, "utf8");
  const shared = E1.files.map((f) => f.path).filter((p) => !isRecutOwnPath(p));
  assert.equal(read("r2-objects.txt"), shared.filter((p) => contentTypeOf(p) === "application/octet-stream").map((p) => `${p}\n`).join(""));
  assert.equal(read("r2-manifests.txt"), shared.filter((p) => contentTypeOf(p) === "application/json").map((p) => `${p}\n`).join(""));
  const [objects, manifests] = ["r2-objects.txt", "r2-manifests.txt"].map((s) => read(s).split("\n").filter(Boolean));
  assert.equal(objects.length, 130);
  assert.ok(manifests.length === 8 && manifests.every((p) => p.endsWith(".json")));
  assert.deepEqual([...objects, ...manifests].sort(), [...shared].sort());
});

test("final: refuses a SHA256SUMS that differs elsewhere, a record of another base or none, and the -r2 pack-note drift; writes no R2 list", async () => {
  const root = mkdtemp("l4w-sbr-final-");
  const refused = async (record, sums, re) => {
    const { rel, sidecar } = writeRecut(root, record, sums);
    await assert.rejects(finalCheck(E1_FILE, rel, sidecar), re);
    assert.deepEqual(lists(sidecar), [], "no R2 list on a refusal");
  };
  const shared = "lists/extra-modules.txt";
  // a shared path's line with other bytes
  await refused(recutOfE1(), (s) => s.replace(new RegExp(`^[0-9a-f]{64}(  ${escapeRe(shared)})$`, "m"), `${"d".repeat(64)}$1`),
    new RegExp(`^Error: SHA256SUMS differs from ${escapeRe(E1.id)}'s at lists/extra-modules\\.txt: a release by reference differs from its base only at release\\.json and the files it owns \\(tools/\\)$`));
  // a shared path's line missing, or a line for a file the base does not have
  await refused(recutOfE1(), (s) => s.split("\n").filter((l) => !l.endsWith(`  ${shared}`)).join("\n"), /SHA256SUMS differs from .* at lists\/extra-modules\.txt: /);
  await refused(recutOfE1(), (s) => `${s}${"e".repeat(64)}  runtime/chunks/zz-extra\n`, /SHA256SUMS differs from .* at .*runtime\/chunks\/zz-extra/);
  await refused(recutOfE1(), (s) => `${s}not a line\n`, /^Error: SHA256SUMS line malformed: not a line$/);
  // another digest of the base, or no base at all
  await refused(recutOfE1({ base: { id: E1.id, digest: `sha256:${"0".repeat(64)}` } }), undefined,
    new RegExp(`^Error: release\\.json names base .*, not ${escapeRe(E1.id)} \\(${escapeRe(E1.digest)}\\)`));
  const { base: _b, ...noBase } = recutOfE1();
  await refused(canonicalRelease(noBase), undefined, /^Error: release\.json names base undefined, not lean-v4\.34\.0-e1a79c1 /);
  // the staged -r2's drift: a pack note the base lacks
  await refused(recutOfE1({ packs: E1.packs.map((k) => (k.id === "lean-lib" ? { ...k, note: "transport copied from served bytes, not re-packed" } : k)) }), undefined,
    /packs differs from the base's/);
});

test("final, a runtime release by reference of e1a79c1: differs at release.json and its own files only, and writes no R2 list; a shared line that differs is refused", async () => {
  const rt = runtimeRecutOf(E1);
  const root = mkdtemp("l4w-sbr-final-rt-");
  let { rel, sidecar } = writeRecut(root, rt);
  const said = await finalCheck(E1_FILE, rel, sidecar);
  assert.match(said, new RegExp(`^only release\\.json and its own files \\(runtime/, profiles/lean-lib\\.\\* and tools/\\) differ from ${escapeRe(E1.id)}: SHA256SUMS differs at \\d+ paths; 137 files, 48 own, 89 shared \\(84 objects, 5 manifests\\)$`));
  assert.deepEqual(lists(sidecar), [], "publish derives a runtime release's lists from its record");
  // the base's runtime chunks and lean-lib parts (listed only by the base) are judged as its own: no problem
  ({ rel, sidecar } = writeRecut(root, rt, (s) => s.replace(/^[0-9a-f]{64}(  lists\/extra-modules\.txt)$/m, `${"d".repeat(64)}$1`)));
  await assert.rejects(finalCheck(E1_FILE, rel, sidecar),
    new RegExp(`^Error: SHA256SUMS differs from ${escapeRe(E1.id)}'s at lists/extra-modules\\.txt: a release by reference differs from its base only at release\\.json and the files it owns \\(runtime/, profiles/lean-lib\\.\\* and tools/\\)$`));
  assert.deepEqual(lists(sidecar), []);
  // a shared pack's manifest line: the same refusal
  ({ rel, sidecar } = writeRecut(root, rt, (s) => s.replace(/^[0-9a-f]{64}(  profiles\/lean-core\.manifest\.json)$/m, `${"d".repeat(64)}$1`)));
  await assert.rejects(finalCheck(E1_FILE, rel, sidecar), /at profiles\/lean-core\.manifest\.json: a release by reference differs/);
});

// ---------- the step runner the script calls ----------

test("the step runner: usage exits 2, a refusal 1 with its reason on stderr, a step's output on stdout", () => {
  const run = (...args) => spawnSync(process.execPath, [SBR, ...args], { encoding: "utf8", timeout: 60_000 });
  let r = run();
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^usage: stage-by-reference\.mjs <base\|mirror\|clone\|config\|final>/);
  r = run("config", E1_FILE, "x", "y");
  assert.equal(r.status, 2);
  r = run("base", E1_FILE, "v4.34.0");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${baseFields(E1_FILE, "v4.34.0")}\n`);
  r = run("base", E1_FILE, "v4.35.0");
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, new RegExp(`^stage-by-reference base: ${escapeRe(E1_FILE)}: it is ${escapeRe(E1.id)}, not a first cut of v4\\.35\\.0`));
});

// ---------- stage-release.sh --base, end to end ----------

const KERNEL = "abcdef1234567890abcdef1234567890abcdef12";
const BASE_ID = "lean-v4.34.0-abcdef1", RECUT_ID = `${BASE_ID}-r3`, RECUT_TGZ = "lean4-wasm64-4.34.0-abcdef1-r3.tgz";
// the runtime release by reference: a later kernel commit, its own build dir
const RT_KERNEL = "1234567890abcdef1234567890abcdef12345678", RT_ID = "lean-v4.34.0-1234567", RT_VERSION = "4.34.0-1234567";
const RT_TGZ = `lean4-wasm64-${RT_VERSION}.tgz`;
/** The runtime build's lib/lean: the 8 roots of packs.json's lean-lib, each with real imports inside the tree. */
const LEAN_LIB = { Init: ["Init.Prelude"], "Init.Prelude": [], Std: ["Init"], Lean: ["Std"], Lake: ["Lean"], LakeMain: ["Lake"], LeanChecker: ["Lean"], LeanIR: ["Lean"], Leanc: ["Lean"] };
// the script runs with PATH=<shims>:/usr/bin:/bin
const needs = ["bash", "tar", "shasum", "cmp", "sort", "awk"].filter((c) => spawnSync("/bin/sh", ["-c", `command -v ${c}`], { env: { PATH: "/usr/bin:/bin" } }).status !== 0);
const E2E = process.platform === "win32" ? "POSIX shell only" : needs.length ? `${needs.join(", ")} not on PATH` : false;

/** Shim sources: CommonJS, run by the `node` link in the shim dir. Each appends {tool, C?, argv} to $STAGE_TEST_LOG. */
const SHIM_HEAD = `#!/usr/bin/env node
const fs = require("fs"), path = require("path"), os = require("os"), { spawnSync } = require("child_process");
const log = (x) => fs.appendFileSync(process.env.STAGE_TEST_LOG, JSON.stringify(x) + "\\n");
`;
const SHIMS = {
  // read-only answers for the base and the line: the tag holds the mirror's record, every ancestry holds,
  // the tree is clean, the recipe is the base's and no source changed; the printed next steps' commands
  // (git -C <repo> …) are recorded, never run. Knobs, each off by default:
  //   STAGE_TEST_NOT_ANCESTOR "<a> <b>[;…]"   merge-base --is-ancestor <a> <b> fails
  //   STAGE_TEST_UNKNOWN_COMMIT <c>           cat-file -e <c>^{commit} fails
  //   STAGE_TEST_TAGS                         the output of tag --merged (default: v4.33.0, v4.34.0, v4.34.0-rc1)
  //   STAGE_TEST_PATCHES <file>               show HEAD:wasm64-build/PATCHES.md
  //   STAGE_TEST_RECIPE                       log (the docker-wasm64 recipe; default: the base's docker.recipeCommit)
  //   STAGE_TEST_STDLIB_DIFF, _FORMAT_DIFF     diff: the changed paths ("," between them) for a pathspec naming
  //                                           src/Init (the stdlib) or not (the olean format); --quiet exits 1 when any
  git: `${SHIM_HEAD}let a = process.argv.slice(2), C = null;
if (a[0] === "-C") { C = a[1]; a = a.slice(2); }
log({ tool: "git", C, argv: a });
const e = process.env, id = e.STAGE_TEST_BASE_ID, say = (s) => process.stdout.write(s);
if (C !== null && ["add", "commit", "tag", "push"].includes(a[0])) process.exit(0);
const notAncestor = (x, y) => (e.STAGE_TEST_NOT_ANCESTOR ?? "").split(";").filter(Boolean).some((p) => p === x + " " + y);
switch (a[0]) {
  case "--version": say("git version 0 (stage test shim)\\n"); break;
  case "rev-parse": if (a[1] === "HEAD") say("c".repeat(40) + "\\n"); else if (a.includes("refs/tags/" + id)) say("1".repeat(40) + "\\n"); else process.exitCode = 1; break;
  case "show":
    if (a[1] === "refs/tags/" + id + ":wasm64-build/releases/" + id + ".json") say(fs.readFileSync(e.STAGE_TEST_BASE_RECORD));
    else if (a[1] === "HEAD:wasm64-build/PATCHES.md" && e.STAGE_TEST_PATCHES) say(fs.readFileSync(e.STAGE_TEST_PATCHES));
    else process.exitCode = 128;
    break;
  case "merge-base": if (a[1] === "--is-ancestor" && notAncestor(a[2], a[3])) process.exitCode = 1; break;
  case "cat-file": if (e.STAGE_TEST_UNKNOWN_COMMIT && a.includes(e.STAGE_TEST_UNKNOWN_COMMIT + "^{commit}")) process.exitCode = 1; break;
  case "status": break;
  case "tag": say(e.STAGE_TEST_TAGS ?? "v4.33.0\\nv4.34.0\\nv4.34.0-rc1\\n"); break;
  case "symbolic-ref": say("refs/heads/qed64-wasm64\\n"); break;
  case "log": say((e.STAGE_TEST_RECIPE ?? JSON.parse(fs.readFileSync(e.STAGE_TEST_BASE_RECORD, "utf8")).docker.recipeCommit) + "\\n"); break;
  case "diff": {
    const list = ((a.includes("src/Init") ? e.STAGE_TEST_STDLIB_DIFF : e.STAGE_TEST_FORMAT_DIFF) ?? "").split(",").filter(Boolean);
    if (a.includes("--quiet")) process.exitCode = list.length ? 1 : 0;
    else say(list.map((x) => x + "\\n").join(""));
    break;
  }
  default: console.error("git shim: refusing " + a.join(" ")); process.exitCode = 97;
}
`,
  // npm pack of the copy's js/ (cwd), with the stand-in gate and, for the interrupt cases, one tool that hangs
  npm: `${SHIM_HEAD}const a = process.argv.slice(2);
log({ tool: "npm", argv: a });
const dest = a[a.indexOf("--pack-destination") + 1];
if (a[0] !== "pack" || !dest) { console.error("npm shim: only npm pack --pack-destination <dir>"); process.exit(97); }
const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "l4w-npm-"));
fs.cpSync(process.cwd(), path.join(tmp, "package"), { recursive: true });
fs.copyFileSync(process.env.STAGE_TEST_GATE, path.join(tmp, "package", "gate.mjs"));
if (process.env.STAGE_TEST_HANG) fs.copyFileSync(process.env.STAGE_TEST_HANG_SCRIPT, path.join(tmp, "package", process.env.STAGE_TEST_HANG));
const r = spawnSync("tar", ["-czf", path.join(dest, "lean4-wasm64-" + version + ".tgz"), "-C", tmp, "package"], { stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } });
fs.rmSync(tmp, { recursive: true, force: true });
process.exitCode = r.status ?? 1;
`,
  gh: `${SHIM_HEAD}log({ tool: "gh", argv: process.argv.slice(2) });\n`,
  rclone: `${SHIM_HEAD}log({ tool: "rclone", argv: process.argv.slice(2) });\n`,
};
const GATE_STANDIN = `import fs from "node:fs"; import path from "node:path";
const a = process.argv[process.argv.indexOf("--artifact") + 1];
const miss = ["bin/lean.js", "bin/lean.wasm", "lib/lean/Init.olean", "lib/lean/Init/Prelude.olean"].filter((f) => !fs.existsSync(path.join(a, f)));
if (miss.length) { console.log("FAIL the artifact lacks " + miss.join(", ")); process.exitCode = 1; }
else console.log(" ok stand-in 1\\n ok stand-in 2\\n ok stand-in 3\\nGATE PASSED (a stand-in: no wasm runtime in unit tests)");
`;
const HANG = `import fs from "node:fs";
fs.writeFileSync(process.env.STAGE_TEST_MARK, String(process.pid));
setInterval(() => {}, 1 << 30);
`;

let W = null;
/** The world, built once: <root>/stage area/{base mirror/<BASE_ID>, repo copy, bin, bin-nonpm}. */
function world() {
  if (W) return W;
  const S = path.join(mkdtemp("l4w-stage-"), "stage area");
  const run = (script, args) => {
    const r = spawnSync(process.execPath, [path.join(pkg, script), ...args], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, `${script}: ${r.stderr}${r.stdout}`);
  };
  // the base: a small first cut, released by release.mjs (a lean-lib pack, so that the gate has its tree)
  const mirror = path.join(S, "base mirror", BASE_ID);
  const bin = path.join(S, "src", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "lean.js"), Buffer.alloc(2500, 1));
  fs.writeFileSync(path.join(bin, "lean.wasm"), Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 251)));
  run("chunk-runtime.mjs", ["--bin", bin, "--out", path.join(mirror, "runtime"), "--lean-version", "4.34.0",
    "--revision", `qed64-wasm64@${KERNEL.slice(0, 10)} (upstream v4.34.0)`, "--part-bytes", "1024"]);
  fs.mkdirSync(path.join(mirror, "runtime", "bin"));
  fs.writeFileSync(path.join(mirror, "runtime", "bin", "leanmake"), "#!/bin/sh\n");
  const lib = path.join(S, "src", "lib");
  fs.mkdirSync(path.join(lib, "Init"), { recursive: true });
  fs.writeFileSync(path.join(lib, "Init.olean"), Buffer.alloc(300, 3));
  fs.writeFileSync(path.join(lib, "Init", "Prelude.olean"), Buffer.alloc(1200, 5));
  run("pack.mjs", ["--lib", lib, "--id", "lean-lib", "--out", path.join(mirror, "profiles"), "--lean-version", "4.34.0",
    "--revision", KERNEL, "--roots", "Init", "--url-prefix", "/profiles/", "--no-imports"]);
  for (const f of fs.readdirSync(path.join(mirror, "profiles"))) if (f.endsWith(".pack")) fs.rmSync(path.join(mirror, "profiles", f));
  fs.mkdirSync(path.join(mirror, "native64"));
  fs.writeFileSync(path.join(mirror, "native64", "native64.tar.gz"), "not really a tarball");
  fs.mkdirSync(path.join(mirror, "lists"));
  fs.writeFileSync(path.join(mirror, "lists", "essential-modules.txt"), "Init\n");
  fs.writeFileSync(path.join(mirror, "lists", "essential-selection.json"), "{}\n");
  fs.mkdirSync(path.join(mirror, "tools"));
  fs.writeFileSync(path.join(mirror, "tools", "lean4-wasm64-4.34.0-abcdef1.tgz"), "the first cut's tools");
  const manifest = JSON.parse(fs.readFileSync(path.join(mirror, "runtime", "runtime-manifest.json"), "utf8"));
  const mathlib = { commit: "5ed2965256430c3649e86755f9576b54eca72435", tag: "v4.34.0" };
  const config = {
    upstreamTag: "v4.34.0", kernelCommit: KERNEL, kernelPatch: "0037", leanVersion: "4.34.0",
    gate: { commit: KERNEL, wasmSha256: manifest.files["lean.wasm"].sha256, checks: 33 },
    packs: [{ id: "lean-lib", compiler: KERNEL }],
    native64: { commit: "857544b439aa51633344d638dacc03d304b9ea96", os: "linux", arch: "aarch64", tar: "native64/native64.tar.gz" },
    docker: { tag: "qed64-toolchain:emsdk-6.0.5", recipeCommit: "974ee228b0c368f1d74f55ed4794ef60c15de4c2" },
    mathlib, modules: { essential: "lists/essential-modules.txt" },
    hosting: { layout: "served", mount: { "/runtime/": "runtime/", "/profiles/": "profiles/" }, spec: "wasm64-build/js/formats/HOSTING.md" },
    tools: { package: "lean4-wasm64", version: "4.34.0-abcdef1", tgz: "tools/lean4-wasm64-4.34.0-abcdef1.tgz" },
    notes: ["the first cut's own note"],
  };
  fs.writeFileSync(path.join(S, "src", "config.json"), JSON.stringify(config));
  run("release.mjs", ["--release", mirror, "--config", path.join(S, "src", "config.json")]);
  const base = JSON.parse(fs.readFileSync(path.join(mirror, "release.json"), "utf8"));
  // the repositories: what staging runs, copied (the script, its node steps, publish's content types, js/
  // without its tests at the release's version) — the printed next steps write into the copy. One for the
  // tools re-cut (-r3), one for the runtime release by reference.
  const repoCopy = (name, version) => {
    const repo = path.join(S, name);
    fs.mkdirSync(path.join(repo, "wasm64-build"), { recursive: true });
    for (const f of ["stage-release.sh", "stage-by-reference.mjs", "publish-release.mjs"]) fs.copyFileSync(path.join(build, f), path.join(repo, "wasm64-build", f));
    fs.chmodSync(path.join(repo, "wasm64-build", "stage-release.sh"), 0o755);
    fs.cpSync(pkg, path.join(repo, "wasm64-build", "js"), { recursive: true, filter: (src) => !["test", "node_modules"].includes(path.relative(pkg, src).split(path.sep)[0]) });
    const pj = path.join(repo, "wasm64-build", "js", "package.json");
    fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(fs.readFileSync(pj, "utf8")), version }, null, 2) + "\n");
    fs.writeFileSync(path.join(repo, "wasm64-build", "import-release.sh"), `${SHIM_HEAD}log({ tool: "import-release.sh", argv: process.argv.slice(2) });\n`, { mode: 0o755 });
    return repo;
  };
  const repo = repoCopy("repo copy", "4.34.0-abcdef1-r3");
  const rtRepo = repoCopy("repo copy rt", RT_VERSION);
  // the shims, and the same without npm
  const shims = path.join(S, "bin"), nonpm = path.join(S, "bin-nonpm");
  for (const d of [shims, nonpm]) { fs.mkdirSync(d); fs.symlinkSync(process.execPath, path.join(d, "node")); }
  for (const [name, src] of Object.entries(SHIMS)) {
    fs.writeFileSync(path.join(shims, name), src, { mode: 0o755 });
    if (name !== "npm") fs.writeFileSync(path.join(nonpm, name), src, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(S, "gate-standin.mjs"), GATE_STANDIN);
  fs.writeFileSync(path.join(S, "hang.mjs"), HANG);
  const logFile = path.join(S, "calls.jsonl");
  const env = (extra = {}, bin = shims) => ({
    PATH: `${bin}:/usr/bin:/bin`, HOME: process.env.HOME ?? S, TMPDIR: os.tmpdir(), LANG: "C",
    STAGE_TEST_LOG: logFile, STAGE_TEST_BASE_ID: BASE_ID, STAGE_TEST_BASE_RECORD: path.join(mirror, "release.json"),
    STAGE_TEST_GATE: path.join(S, "gate-standin.mjs"), STAGE_TEST_HANG_SCRIPT: path.join(S, "hang.mjs"), ...extra,
  });
  const script = path.join(repo, "wasm64-build", "stage-release.sh");
  const stage = (args, { extra = {}, bin, using = script } = {}) => spawnSync(using, ["v4.34.0", ...args], { cwd: S, encoding: "utf8", timeout: 120_000, env: env(extra, bin) });
  const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  // the runtime release by reference's own build dir (gated: GATE-PASSED, gate.log), its lib/lean
  // trees of oleans with real import tables, and the PATCHES.md that places its kernel commit at 0040
  const rtBuild = path.join(S, "build 0040");
  const put = (rel, bytes) => { fs.mkdirSync(path.dirname(path.join(rtBuild, rel)), { recursive: true }); fs.writeFileSync(path.join(rtBuild, rel), bytes); };
  put("build/stage1/bin/lean.js", Buffer.alloc(1800, 4));
  const wasm = Buffer.from(Array.from({ length: 4200 }, (_, i) => (i * 11 + 3) % 247));
  put("build/stage1/bin/lean.wasm", wasm);
  put("build/stage1/bin/leanmake", "#!/bin/sh\n# the 0040 build's\n");
  put("build/stage1/bin/lean.js.symbols", "0:main\n");
  for (const [m, imports] of Object.entries(LEAN_LIB)) put(`build/stage1/lib/lean/${m.split(".").join("/")}.olean`, olean(imports));
  put("BUILT-COMMIT", `${RT_KERNEL}\n`);
  put("GATE-PASSED", `${RT_KERNEL}\n${sha(wasm)}\n`);
  put("gate.log", " ok one\n ok two\n ok three\n ok four\nGATE PASSED\n");
  const patches = path.join(S, "PATCHES.md");
  fs.writeFileSync(patches, `# Patches\n\n## 0037 — the base's runtime (${KERNEL.slice(0, 10)})\n\ntext\n\n## 0040 — native Wasm exceptions (${RT_KERNEL.slice(0, 10)})\n\ntext\n`);
  const rtScript = path.join(rtRepo, "wasm64-build", "stage-release.sh");
  W = { S, mirror, base, repo, rtRepo, script, rtScript, env, stage, logFile, calls, nonpm, rtBuild, wasmSha: sha(wasm), patches };
  return W;
}

test("stage-release.sh --base: stages a re-cut by reference end to end, and its printed next steps run as printed from paths with spaces", { skip: E2E, timeout: 180_000 }, () => {
  const w = world();
  const out = path.join(w.S, "out dir");
  const r = w.stage(["--base", w.mirror, "--recut", "3", "--note", "a test re-cut (by reference)", "--out", out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rel = path.join(out, RECUT_ID);
  // the node steps, as the script runs them
  assert.match(r.stdout, new RegExp(`^re-cut by reference ${RECUT_ID} of ${BASE_ID} \\(sha256:`, "m"));
  assert.match(r.stdout, new RegExp(`^\\d+ files cloned from .*base mirror/${BASE_ID} \\(0\\.00 GB\\), each sha256-checked against ${BASE_ID}'s record$`, "m"));
  assert.match(r.stdout, /^GATE PASSED \(3 checks\): /m);
  assert.match(r.stdout, new RegExp(`RELEASE VERIFIED ${RECUT_ID}`));
  const shared = w.base.files.map((f) => f.path).filter((p) => !isRecutOwnPath(p));
  assert.match(r.stdout, new RegExp(`^only release\\.json and its own files \\(tools/\\) differ from ${BASE_ID}: SHA256SUMS differs at 3 paths; ${shared.length + 1} files, 1 own, ${shared.length} shared `, "m"));
  // the record: the base's but for the re-cut's own fields and files
  const rec = JSON.parse(fs.readFileSync(path.join(rel, "release.json"), "utf8"));
  assert.deepEqual(rec.base, { id: BASE_ID, digest: w.base.digest });
  assert.deepEqual(checkRecutBase(rec, w.base), []);
  assert.equal(rec.gate.checks, 3);
  assert.deepEqual(rec.notes, ["a test re-cut (by reference)", ...w.base.notes]);
  assert.deepEqual(filesUnder(rel).filter((p) => !["release.json", "SHA256SUMS"].includes(p)), [...shared, `tools/${RECUT_TGZ}`].sort());
  const objects = fs.readFileSync(path.join(out, `${RECUT_ID}.r2-objects.txt`), "utf8").split("\n").filter(Boolean);
  const manifests = fs.readFileSync(path.join(out, `${RECUT_ID}.r2-manifests.txt`), "utf8").split("\n").filter(Boolean);
  assert.deepEqual([...objects, ...manifests].sort(), [...shared].sort());
  assert.ok(manifests.length > 0 && manifests.every((p) => p.endsWith(".json")));
  for (const n of ["config.json", "verify.json", "gate.log", "gate.stamp"]) assert.ok(fs.existsSync(path.join(out, `${RECUT_ID}.${n}`)), n);

  // the printed next steps, each line run by bash as printed (the shims record what they were given)
  const steps = r.stdout.slice(r.stdout.indexOf("Next (RELEASE.md)")).split("\n").filter((l) => /^ {2}\S/.test(l) && !/^ {2}#/.test(l));
  assert.equal(steps.length, 13, steps.join("\n"));
  fs.rmSync(w.logFile, { force: true });
  for (const line of steps) {
    const s = spawnSync("/bin/bash", ["-c", line], { cwd: w.S, encoding: "utf8", timeout: 60_000, env: w.env() });
    assert.equal(s.status, 0, `${line}\n${s.stderr}`);
  }
  const calls = w.calls();
  const by = (tool) => calls.filter((c) => c.tool === tool);
  assert.deepEqual(by("import-release.sh").map((c) => c.argv), [["publish", RECUT_ID, "--release-dir", rel, "--dry-run"]]);
  assert.equal(fs.readFileSync(path.join(w.repo, "wasm64-build", "releases", `${RECUT_ID}.json`), "utf8"), fs.readFileSync(path.join(rel, "release.json"), "utf8"));
  const gits = by("git").filter((c) => c.C !== null);
  assert.deepEqual(gits.map((c) => [c.C, c.argv[0]]), [[w.repo, "add"], [w.repo, "commit"], [w.repo, "tag"], [w.repo, "push"]]);
  assert.deepEqual(by("gh").find((c) => c.argv[1] === "upload").argv,
    ["release", "upload", RECUT_ID, "--repo", "FawadHa1der/lean4", path.join(rel, "tools", RECUT_TGZ), path.join(rel, "release.json"), path.join(rel, "SHA256SUMS")]);
  const rc = by("rclone");
  assert.equal(rc.length, 5);
  assert.deepEqual(rc.slice(0, 2).map((c) => c.argv[c.argv.indexOf("--files-from-raw") + 1]),
    [path.join(out, `${RECUT_ID}.r2-objects.txt`), path.join(out, `${RECUT_ID}.r2-manifests.txt`)]);
  assert.deepEqual(rc.slice(2).map((c) => c.argv[1]), [rel, rel, rel]);
});

/** Stages into a fresh --out with one tool of the tarball hanging; signals the whole process group once it hangs. */
async function interrupted(hang, signal) {
  const w = world();
  const out = path.join(w.S, `out ${signal}`);
  const mark = path.join(w.S, `${signal}.mark`);
  const child = spawn(w.script, ["v4.34.0", "--base", w.mirror, "--recut", "3", "--note", "x", "--out", out],
    { cwd: w.S, env: w.env({ STAGE_TEST_HANG: hang, STAGE_TEST_MARK: mark }), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  live.add(child.pid);
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  let ended = null;
  const exited = new Promise((resolve) => child.on("exit", (code, sig) => { ended = { code, sig }; resolve(ended); }));
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(mark)) {
    if (ended) throw new Error(`staging ended (${JSON.stringify(ended)}) before ${hang} ran:\n${log}`);
    if (Date.now() > deadline) { process.kill(-child.pid, "SIGKILL"); throw new Error(`${hang} never ran:\n${log}`); }
    await new Promise((r) => setTimeout(r, 25));
  }
  const rel = path.join(out, RECUT_ID);
  const present = () => ["release.json", "SHA256SUMS"].filter((n) => fs.existsSync(path.join(rel, n)));
  const during = present();
  process.kill(-child.pid, signal);
  const kill = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 30_000);
  const end = await exited;
  clearTimeout(kill);
  live.delete(child.pid);
  return { ...end, during, after: present(), rel, out, log };
}

test("stage-release.sh --base: an interrupt while the gate's fetch reads the base's record from the release dir leaves no release.json", { skip: E2E, timeout: 180_000 }, async () => {
  const r = await interrupted("fetch-release.mjs", "SIGINT");
  assert.deepEqual(r.during, ["release.json"], "the window: the base's record in the release dir");
  assert.equal(r.code, 130, `${JSON.stringify(r)}`);
  assert.deepEqual(r.after, [], r.log);
  assert.ok(fs.existsSync(path.join(r.rel, "runtime")), "the clones stay (a re-run replaces them)");
});

test("stage-release.sh --base: a TERM during verify leaves neither release.json nor SHA256SUMS, and no R2 list", { skip: E2E, timeout: 180_000 }, async () => {
  const r = await interrupted("verify-release.mjs", "SIGTERM");
  assert.deepEqual(r.during, ["release.json", "SHA256SUMS"], "the window: release.mjs wrote both");
  assert.equal(r.code, 143, `${JSON.stringify(r)}`);
  assert.deepEqual(r.after, [], r.log);
  assert.equal(fs.existsSync(path.join(r.out, `${RECUT_ID}.r2-objects.txt`)), false);
});

test("stage-release.sh --base: npm off PATH is refused before any write", { skip: E2E, timeout: 180_000 }, () => {
  const w = world();
  const out = path.join(w.S, "out nonpm");
  const r = w.stage(["--base", w.mirror, "--recut", "3", "--note", "x", "--out", out], { bin: w.nonpm });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /^stage-release: npm is not on PATH \(the tools tarball is npm pack's\)$/m);
  assert.equal(fs.existsSync(out), false);
});

test("stage-release.sh --base: an --out in another case that makes the mirror the release dir is refused before any write", { skip: E2E, timeout: 180_000 }, (t) => {
  const w = world();
  // the review's O5: a mirror named like the re-cut's release dir, and --out its parent in another case
  const o5 = path.join(w.S, "O5", RECUT_ID);
  fs.cpSync(w.mirror, o5, { recursive: true });
  if (!sameDir(path.join(w.S, "o5"), path.join(w.S, "O5"))) return t.skip("case-sensitive filesystem");
  const held = snapshot(o5), before = snapshot(path.dirname(w.mirror));
  const r = w.stage(["--base", o5, "--recut", "3", "--note", "x", "--out", path.join(w.S, "o5")]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /it overlaps .*, which staging replaces \(another --out\)/);
  assert.match(r.stderr, /^stage-release: cannot stage from the mirror .* \(reason above\)$/m);
  assert.deepEqual(snapshot(o5), held, "the mirror is untouched");
  assert.deepEqual(fs.readdirSync(path.join(w.S, "O5")), [RECUT_ID], "nothing beside it");
  assert.deepEqual(snapshot(path.dirname(w.mirror)), before);
});

test("stage-release.sh --base: a mirror file of the right size with other bytes stops at the clones, the release dir removed", { skip: E2E, timeout: 180_000 }, () => {
  const w = world();
  const tampered = path.join(w.S, "tampered", BASE_ID);
  fs.cpSync(w.mirror, tampered, { recursive: true });
  const chunk = w.base.files.find((f) => f.path.startsWith("runtime/chunks/")).path;
  const bytes = fs.readFileSync(path.join(tampered, chunk));
  bytes[0] ^= 0xff;
  fs.writeFileSync(path.join(tampered, chunk), bytes);
  const out = path.join(w.S, "out tampered");
  const r = w.stage(["--base", tampered, "--recut", "3", "--note", "x", "--out", out]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`${escapeRe(chunk)}: the mirror's bytes are not ${BASE_ID}'s`));
  assert.match(r.stderr, /^stage-release: cloning from .* failed \(reason above\); .* removed$/m);
  assert.equal(fs.existsSync(path.join(out, RECUT_ID)), false);
});

test("stage-release.sh --base --recut: the line's refusals (kernel not on the line, HEAD without it, another upstream tag), before any write", { skip: E2E, timeout: 180_000 }, () => {
  const w = world();
  const cases = [
    ["kernel not on the line", { STAGE_TEST_NOT_ANCESTOR: `${KERNEL} qed64-wasm64` }, new RegExp(`^stage-release: kernel commit ${KERNEL} is not on qed64-wasm64$`, "m")],
    ["HEAD without the kernel", { STAGE_TEST_NOT_ANCESTOR: `${KERNEL} HEAD` }, /^stage-release: HEAD does not contain kernel commit .* \(stage from qed64-wasm64 or a descendant\)$/m],
    ["another upstream tag", { STAGE_TEST_TAGS: "v4.34.0\nv4.35.0\n" }, /^stage-release: kernel commit abcdef1234 carries upstream v4\.35\.0, not v4\.34\.0$/m],
    ["an unknown kernel", { STAGE_TEST_UNKNOWN_COMMIT: KERNEL }, new RegExp(`^stage-release: kernel commit ${KERNEL} is not in this repository$`, "m")],
  ];
  for (const [label, extra, re] of cases) {
    const out = path.join(w.S, `out line ${label}`);
    const r = w.stage(["--base", w.mirror, "--recut", "3", "--note", "x", "--out", out], { extra });
    assert.equal(r.status, 1, `${label}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, re, label);
    assert.equal(fs.existsSync(out), false, `${label}: nothing written`);
  }
});

// ---------- stage-release.sh --base --runtime: a runtime release by reference, end to end ----------

const rtArgs = (w, out, more = []) => ["--runtime", w.rtBuild, "--base", w.mirror, "--note", "the 0040 runtime, by reference", ...more, "--out", out];

test("stage-release.sh --base --runtime: stages a runtime release by reference from its own build dir, with no import build dir, Docker or gate run", { skip: E2E, timeout: 180_000 }, () => {
  const w = world();
  const out = path.join(w.S, "out rt");
  fs.rmSync(w.logFile, { force: true });
  const r = w.stage(rtArgs(w, out), { using: w.rtScript, extra: { STAGE_TEST_PATCHES: w.patches } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rel = path.join(out, RT_ID);
  assert.match(r.stdout, new RegExp(`^runtime release by reference ${RT_ID} of ${BASE_ID} \\(sha256:[0-9a-f]{16}…\\): kernel ${RT_KERNEL.slice(0, 10)} \\(patch 0040\\), runtime .*build 0040 \\(gate 4 checks\\), tools ${RT_VERSION} at cccccccccc, mirror `, "m"));
  assert.match(r.stdout, /^gate: .*build 0040\/GATE-PASSED \(1234567890, lean\.wasm [0-9a-f]{16}…\), 4 checks — the build dir's gate, as for a release by value$/m);
  assert.match(r.stdout, new RegExp(`RELEASE VERIFIED ${RT_ID}`));
  assert.match(r.stdout, new RegExp(`^only release\\.json and its own files \\(runtime/, profiles/lean-lib\\.\\* and tools/\\) differ from ${BASE_ID}: `, "m"));
  // the record: its own runtime, lean-lib and tools; every other field and file the base's
  const rec = JSON.parse(fs.readFileSync(path.join(rel, "release.json"), "utf8"));
  assert.deepEqual(checkReleaseRecord(rec), []);
  assert.deepEqual(checkRecutBase(rec, w.base), []);
  assert.deepEqual(rec.base, { id: BASE_ID, digest: w.base.digest });
  assert.equal(rec.kernel.commit, RT_KERNEL);
  assert.equal(rec.kernel.patch, "0040");
  assert.deepEqual(rec.gate, { passed: true, commit: RT_KERNEL, wasmSha256: w.wasmSha, checks: 4 });
  assert.equal(rec.runtime.buildId, buildIdFromSha256(w.wasmSha));
  assert.equal(rec.runtime.sourceRevision, `qed64-wasm64@${RT_KERNEL.slice(0, 10)} (upstream v4.34.0)`);
  const lib = rec.packs.find((p) => p.id === "lean-lib");
  assert.deepEqual([lib.release, lib.lean.compiler, lib.lean.gitRevision, lib.modules], [`lean-lib-4.34.0-${rec.runtime.buildId}`, RT_KERNEL, RT_KERNEL.slice(0, 12), Object.keys(LEAN_LIB).length]);
  assert.equal(rec.notes[0], "the 0040 runtime, by reference");
  assert.match(rec.notes[1], new RegExp(`^Notes of ${BASE_ID} \\(the base, ${escapeRe(w.base.digest)}\\) follow verbatim: `));
  assert.deepEqual(rec.notes.slice(2), w.base.notes);
  assert.equal(rec.tools.version, RT_VERSION);
  // the files: its own are runtime/**, profiles/lean-lib.* and its tgz; the others are exactly the base's outside those
  const own = rec.files.map((f) => f.path).filter((p) => isOwnPath(rec, p));
  assert.ok(own.every((p) => p.startsWith("runtime/") || p.startsWith("profiles/lean-lib.") || p === `tools/${RT_TGZ}`), own.join(", "));
  assert.ok(own.includes(`tools/${RT_TGZ}`) && own.includes("runtime/bin/leanmake") && own.includes("profiles/lean-lib.manifest.json"));
  const sharedOf = (record) => record.files.filter((f) => !isOwnPath(rec, f.path)).map((f) => `${f.path} ${f.sha256}`);
  assert.deepEqual(sharedOf(rec), sharedOf(w.base));
  assert.deepEqual(filesUnder(rel).filter((p) => !["release.json", "SHA256SUMS"].includes(p)), rec.files.map((f) => f.path));
  // nothing of the base's runtime or lean-lib is left, and the symbol map stays in the build tree
  const baseOwn = w.base.files.map((f) => f.path).filter((p) => isOwnPath(rec, p) && !rec.files.some((f) => f.path === p));
  assert.ok(baseOwn.length > 3);
  for (const p of baseOwn) assert.equal(fs.existsSync(path.join(rel, p)), false, p);
  assert.equal(fs.readFileSync(path.join(rel, "runtime", "bin", "leanmake"), "utf8"), "#!/bin/sh\n# the 0040 build's\n");
  assert.equal(fs.existsSync(path.join(rel, "runtime", "bin", "lean.js.symbols")), false);
  // beside it: the config, the verification, the extracted tools and lean-lib's provenance; no gate, no R2 lists
  const beside = fs.readdirSync(out).filter((n) => n !== RT_ID).sort();
  assert.deepEqual(beside, [`${RT_ID}.config.json`, `${RT_ID}.pack-set.json`, `${RT_ID}.tools`, `${RT_ID}.verify.json`, `${RT_ID}.verify.log`]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, `${RT_ID}.pack-set.json`), "utf8")).packs.map((p) => [p.id, p.compiler]), [["lean-lib", RT_KERNEL]]);
  // no Docker, no gate, no import build dir: only git, npm and the step runner were called
  assert.deepEqual([...new Set(w.calls().map((c) => c.tool))].sort(), ["git", "npm"]);
  assert.ok(!w.calls().some((c) => c.tool === "git" && JSON.stringify(c.argv).includes("wasm64-lean-kernel-build")));
  // the printed next step: the publish dry run only, runnable as printed from a path with spaces
  const steps = r.stdout.slice(r.stdout.indexOf("Next (RELEASE.md)")).split("\n").filter((l) => /^ {2}\S/.test(l) && !/^ {2}#/.test(l));
  assert.equal(steps.length, 1, steps.join("\n"));
  fs.rmSync(w.logFile, { force: true });
  const s = spawnSync("/bin/bash", ["-c", steps[0]], { cwd: w.S, encoding: "utf8", timeout: 60_000, env: w.env() });
  assert.equal(s.status, 0, s.stderr);
  assert.deepEqual(w.calls().map((c) => [c.tool, c.argv]), [["import-release.sh", ["publish", RT_ID, "--release-dir", rel, "--dry-run"]]]);
});

test("stage-release.sh --base --runtime --stdlib-drift: a stdlib change is staged once its note says why, and the note is recorded", { skip: E2E, timeout: 180_000 }, () => {
  const w = world();
  const out = path.join(w.S, "out rt drift");
  const why = "harmless: the runtime runs its own compiled code for Lean/Shell";
  const r = w.stage(rtArgs(w, out, ["--stdlib-drift", why]), { using: w.rtScript, extra: { STAGE_TEST_PATCHES: w.patches, STAGE_TEST_STDLIB_DIFF: "src/Lean/Shell.lean" } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rec = JSON.parse(fs.readFileSync(path.join(out, RT_ID, "release.json"), "utf8"));
  assert.deepEqual(rec.notes.slice(0, 2), ["the 0040 runtime, by reference", why]);
  assert.deepEqual(checkRecutBase(rec, w.base), []);
});

test("stage-release.sh --base --runtime: every refusal comes before any write, with its exit code", { skip: E2E, timeout: 180_000 }, () => {
  const w = world();
  const variant = (name, edit) => {
    const d = path.join(w.S, `build ${name}`);
    fs.cpSync(w.rtBuild, d, { recursive: true });
    edit(d);
    return d;
  };
  const noGate = variant("no gate", (d) => fs.rmSync(path.join(d, "GATE-PASSED")));
  const otherGate = variant("other gate", (d) => fs.writeFileSync(path.join(d, "GATE-PASSED"), `${RT_KERNEL}\n${"0".repeat(64)}\n`));
  const baseKernel = variant("base kernel", (d) => {
    fs.writeFileSync(path.join(d, "BUILT-COMMIT"), `${KERNEL}\n`);
    fs.writeFileSync(path.join(d, "GATE-PASSED"), `${KERNEL}\n${w.wasmSha}\n`);
  });
  const P = { STAGE_TEST_PATCHES: w.patches };
  const pj = path.join(w.rtRepo, "wasm64-build", "js", "package.json");
  const pjText = fs.readFileSync(pj, "utf8");
  const cases = [
    ["--recut with --runtime", (o) => [...rtArgs(w, o), "--recut", "2"], {}, 2, /^stage-release: --base with --runtime is a runtime release by reference, the first cut of its kernel commit: drop --recut/m],
    ["--base alone", (o) => ["--base", w.mirror, "--note", "x", "--out", o], {}, 2, /^stage-release: --base needs --recut <n> \(a tools-only re-cut\) or --runtime <build dir> \(a runtime release by reference\)$/m],
    ["--packs-from with --base --runtime", (o) => [...rtArgs(w, o), "--packs-from", w.mirror], {}, 2, /^stage-release: --base excludes --packs-from: a release by reference takes every file and field it does not own from its base$/m],
    ["no --note", (o) => ["--runtime", w.rtBuild, "--base", w.mirror, "--out", o], {}, 2, /^stage-release: --base needs at least one --note/m],
    ["--stdlib-drift without --base", (o) => ["--runtime", w.rtBuild, "--stdlib-drift", "x", "--note", "x", "--out", o], {}, 2, /^stage-release: --stdlib-drift goes with --runtime <build dir> --base <mirror> \(a runtime release by reference\)$/m],
    ["--stdlib-drift with no drift", (o) => rtArgs(w, o, ["--stdlib-drift", "x"]), P, 2, /^stage-release: no stdlib Lean source changed since the base's kernel abcdef1234: drop --stdlib-drift$/m],
    ["no GATE-PASSED", (o) => ["--runtime", noGate, "--base", w.mirror, "--note", "x", "--out", o], P, 31, /has no passing gate for commit 1234567890 and this lean\.wasm/],
    ["GATE-PASSED naming another lean.wasm", (o) => ["--runtime", otherGate, "--base", w.mirror, "--note", "x", "--out", o], P, 31, /has no passing gate for commit 1234567890 and this lean\.wasm/],
    ["a build of the base's kernel", (o) => ["--runtime", baseKernel, "--base", w.mirror, "--note", "x", "--out", o], P, 1, /is a build of the base's kernel abcdef1234: a tools-only re-cut keeps the runtime \(--recut <n> without --runtime\)$/m],
    ["not descending from the base's kernel", (o) => rtArgs(w, o), { ...P, STAGE_TEST_NOT_ANCESTOR: `${KERNEL} ${RT_KERNEL}` }, 1, /^stage-release: kernel commit 1234567890 does not descend from the base's kernel abcdef1234: /m],
    ["another Docker recipe", (o) => rtArgs(w, o), { ...P, STAGE_TEST_RECIPE: "0".repeat(40) }, 1, /^stage-release: docker-wasm64 at 1234567890 is not the base's recipe \(974ee228b0\): the base's docker record would not describe this runtime's toolchain — a full import \(RELEASE-PIPELINE\.md\)$/m],
    ["an olean-format change", (o) => rtArgs(w, o), { ...P, STAGE_TEST_FORMAT_DIFF: "src/runtime/object.h" }, 1, /^stage-release: the olean format's C\+\+ \(src\/include\/lean\/lean\.h .*\) changed since the base's kernel abcdef1234: this runtime could misread the shared packs .* a full import \(RELEASE-PIPELINE\.md\)$/m],
    ["a stdlib change without --stdlib-drift", (o) => rtArgs(w, o), { ...P, STAGE_TEST_STDLIB_DIFF: "src/Lean/Shell.lean,src/Init/Prelude.lean" }, 1, /^stage-release: stdlib Lean sources changed since the base's kernel abcdef1234 \(2 files, e\.g\. src\/Lean\/Shell\.lean src\/Init\/Prelude\.lean\): .* say why: --stdlib-drift <note>, which is recorded in notes$/m],
    ["the kernel not on the line", (o) => rtArgs(w, o), { ...P, STAGE_TEST_NOT_ANCESTOR: `${RT_KERNEL} qed64-wasm64` }, 1, new RegExp(`^stage-release: kernel commit ${RT_KERNEL} is not on qed64-wasm64$`, "m")],
    ["a package version with -r2", (o) => rtArgs(w, o), { ...P, PKG: `${RT_VERSION}-r2` }, 1, new RegExp(`^stage-release: wasm64-build/js/package\\.json version is ${RT_VERSION}-r2, the release needs ${RT_VERSION} \\(bump and commit it first\\)$`, "m")],
  ];
  try {
    for (const [label, args, extra, code, re] of cases) {
      const out = path.join(w.S, `out rt refused ${label}`);
      const { PKG, ...env } = extra;
      fs.writeFileSync(pj, PKG ? JSON.stringify({ ...JSON.parse(pjText), version: PKG }, null, 2) + "\n" : pjText);
      const r = w.stage(args(out), { using: w.rtScript, extra: env });
      assert.equal(r.status, code, `${label}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, re, label);
      assert.equal(fs.existsSync(out), false, `${label}: nothing written`);
    }
  } finally {
    fs.writeFileSync(pj, pjText);
  }
});
