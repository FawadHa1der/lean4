#!/usr/bin/env node
// stage-by-reference.mjs <step> <args…> — the node steps of `stage-release.sh --base`, a release by
// reference (js/formats/release.md, "Release by reference") of either kind: a tools re-cut
// (--recut <n>) or a runtime release by reference (--runtime <build dir>). The script runs each step
// as its own process, in this order, and dies with its own message after a refusal (exit 1, the
// reason on stderr). It runs from the working tree beside the script, as publish-release.mjs does:
// it is not in the tools tarball. Unit-tested: js/test/stage-by-reference.test.mjs.
//
//   base   <base release.json> <tag>
//          the base must be a first cut of <tag> (checkReleaseRecord, no base of its own, the
//          lean4-wasm64 package, a lean-lib pack); prints "<id> <digest> <kernel commit>
//          <gate.wasmSha256> <lean-lib rawSha256>"
//   pairing <base release.json> <kernel commit>
//          a runtime release by reference: whether a runtime built at <kernel commit> may share the
//          base's packs, native64 and lists (pairing(); publish-release.mjs runs it again on the
//          record). Refuses a kernel commit that does not descend from the base's, a docker-wasm64
//          recipe at it other than the base's, and a change to the olean format's C++; prints the
//          stdlib sources (STDLIB_SOURCES) changed since the base's kernel, one per line
//   mirror <base release.json> <mirror dir> <out> <id>
//          before any write: the mirror is not, does not contain and does not lie inside <out>/<id>,
//          <out>/<id>.gate or <out>/<id>.tools (judged by each directory's identity, not its
//          spelling), and holds every file of the base outside tools/ as a regular file of its size
//   clone  <base release.json> <mirror dir> <release dir>
//          clones those files into <release dir>, each sha256-checked against the base's record;
//          a failure removes <release dir>
//   config <base release.json> <config out> <id> <own> <checks> <version> <tgz> <commit> [<note>…]
//          writes the release config from the base's record and <own>: a re-cut number (a tools
//          re-cut) or <kernel commit>:<patch>:<lean.wasm sha256> (a runtime release by reference,
//          whose build's GATE-PASSED binds the two); release.mjs --base re-derives the rest from
//          the staged dir
//   final  <base release.json> <release dir> <sidecar prefix>
//          release.json names the base and keeps its equality rules, and SHA256SUMS differs from the
//          base's at release.json and at the files the release owns only; then, for a tools re-cut
//          (its printed manual fallback), writes the shared paths for the R2 copy to
//          <sidecar prefix>.r2-objects.txt / .r2-manifests.txt
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RELEASE_ID, byReferenceKind, checkRecutBase, checkReleaseRecord, isOwnPath, isRecutOwnPath, ownLabel, sha256sums } from "./js/release-record.mjs";
import { sha256File } from "./js/artifact-id.mjs";

const readRecord = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// ---------- base ----------

/** Why `b` cannot be the base of a release by reference of `tag` (empty: it can). */
export function baseProblems(b, tag) {
  const p = checkReleaseRecord(b);
  const m = RELEASE_ID.exec(b?.id ?? "");
  if (!m || m[1] !== tag || m[3]) p.push(`it is ${b?.id}, not a first cut of ${tag} (lean-${tag}-<kernel7>): a release by reference names a first cut`);
  if (b?.base !== undefined) p.push(`it names a base of its own (${b.base?.id}): a base names no base of its own`);
  if (b?.tools?.package !== "lean4-wasm64") p.push(`its tools are ${JSON.stringify(b?.tools?.package)}, not lean4-wasm64: a release by reference ships the base's package`);
  if (!(b?.packs ?? []).find((k) => k?.id === "lean-lib")) p.push("it has no lean-lib pack: the new tools are gated on the base's runtime and its lean-lib");
  return p;
}

/** Step `base`: the fields of the base the script reads, one line (or a refusal naming the file). */
export function baseFields(file, tag) {
  const b = readRecord(file);
  const p = baseProblems(b, tag);
  if (p.length) throw new Error(`${file}: ${p.join("; ")}`);
  const leanLib = b.packs.find((k) => k?.id === "lean-lib");
  return [b.id, b.digest, b.kernel.commit, b.gate.wasmSha256, leanLib.rawSha256].join(" ");
}

// ---------- pairing (a runtime release by reference) ----------

/** The olean format's C++: a runtime that shares its base's packs must read their oleans as the base's did (their githash check is compiled off). */
export const OLEAN_FORMAT = Object.freeze(["src/include/lean/lean.h", "src/runtime/object.h", "src/runtime/compact.h", "src/runtime/compact.cpp", "src/library/module.cpp"]);
/**
 * The sources of the shared packs' library modules (src/Init, src/Std, src/Lean; src/lake: the
 * Lake.* modules a pack may carry, such as mathlib-game-extra's Lake.Util.Casing) and of the
 * compiler that compiles them and names their auxiliary declarations (stage0). A change since the
 * base's kernel is drift: the shared oleans lag this runtime's compiled code. It needs
 * --stdlib-drift <why that is harmless>.
 */
export const STDLIB_SOURCES = Object.freeze(["src/Init", "src/Init.lean", "src/Std", "src/Std.lean", "src/Lean", "src/Lean.lean", "src/lake", "stage0"]);

/**
 * Whether a runtime built at kernel commit `c` may share base `b`'s packs, native64 and lists (a
 * runtime release by reference; RELEASE.md), asked of git through `git(args) → {status, stdout}`
 * in the repository: both kernel commits are in it, `c` descends from the base's kernel,
 * docker-wasm64 at `c` is the base's docker.recipeCommit, and the olean format's C++ is unchanged
 * between them. These refuse the known ways in which the shared packs stop pairing with a runtime;
 * they prove nothing more. Staging runs it (the `pairing` step), and publish again on the record,
 * whatever wrote it. → {problems, drift}: `drift` lists the STDLIB_SOURCES paths that changed.
 */
export function pairing(b, c, git) {
  const k = b?.kernel?.commit;
  const short = (x) => String(x).slice(0, 10);
  const missing = [k, c].filter((x) => git(["cat-file", "-e", `${x}^{commit}`]).status !== 0);
  if (missing.length) return { problems: missing.map((x) => `kernel commit ${x} is not in this repository`), drift: [] };
  const problems = [];
  if (git(["merge-base", "--is-ancestor", k, c]).status !== 0) {
    problems.push(`kernel commit ${short(c)} does not descend from the base's kernel ${short(k)}: a runtime release by reference is a later build of the base's line`);
  }
  const recipe = b.docker?.recipeCommit;
  const at = git(["log", "-1", "--format=%H", c, "--", "docker-wasm64"]);
  if (!recipe || at.status !== 0 || at.stdout.trim() !== recipe) {
    problems.push(`docker-wasm64 at ${short(c)} is not the base's recipe (${recipe ? short(recipe) : "none recorded"}): the base's docker record would not describe this runtime's toolchain — a full import (RELEASE-PIPELINE.md)`);
  }
  if (git(["diff", "--quiet", k, c, "--", ...OLEAN_FORMAT]).status !== 0) {
    problems.push(`the olean format's C++ (${OLEAN_FORMAT.join(" ")}) changed since the base's kernel ${short(k)}: this runtime could misread the shared packs (their githash check is compiled off) — a full import (RELEASE-PIPELINE.md)`);
  }
  const d = git(["diff", "--name-only", k, c, "--", ...STDLIB_SOURCES]);
  if (d.status !== 0) problems.push(`git diff --name-only ${short(k)} ${short(c)} failed (exit ${d.status})`);
  return { problems, drift: d.status === 0 ? d.stdout.split("\n").filter(Boolean) : [] };
}

/** Step `pairing`: refuses a runtime at `c` that cannot share the base's files; prints the drift, one path per line (nothing when none). */
export function checkPairing(file, c) {
  const { problems, drift } = pairing(readRecord(file), c, (args) => spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 << 20 }));
  if (problems.length) throw new Error(problems.join("; "));
  return drift.length ? drift.join("\n") : undefined;
}

// ---------- mirror ----------

/**
 * A path's physical spelling, also of a path that does not exist yet: its nearest existing ancestor
 * through fs.realpathSync.native (symlinks resolved, and on a case-insensitive filesystem the case
 * the disk holds), then the rest as given.
 */
export function physicalPath(q) {
  q = path.resolve(q);
  const rest = [];
  while (!fs.existsSync(q)) { rest.unshift(path.basename(q)); q = path.dirname(q); }
  return path.join(fs.realpathSync.native(q), ...rest);
}

const statOrNull = (q) => { try { return fs.statSync(q); } catch { return null; } };

/**
 * Whether `a` is `d` or lies inside it, judged by identity (dev + ino of `d` against `a` and each of
 * its existing ancestors), never by spelling: a case-insensitive filesystem (macOS's default APFS),
 * a symlink or a firmlink (/System/Volumes/Data/…) gives one directory several names.
 */
export function isWithin(a, d) {
  const sd = statOrNull(d);
  if (!sd) return false; // nothing exists inside what does not exist
  for (let q = physicalPath(a); ; q = path.dirname(q)) {
    const s = statOrNull(q);
    if (s && s.dev === sd.dev && s.ino === sd.ino) return true;
    if (path.dirname(q) === q) return false;
  }
}

/** The dirs staging removes and rewrites (<out>/<id>, <id>.gate, <id>.tools) that the mirror is, holds or lies inside. */
export function mirrorOverlaps(mirror, out, id) {
  return [id, `${id}.gate`, `${id}.tools`].map((n) => path.join(out, n))
    .filter((w) => isWithin(mirror, w) || isWithin(w, mirror)).map(physicalPath);
}

/** The base's files outside tools/ that the mirror does not hold as a regular file of the record's size. */
export function mirrorMisses(b, mirror) {
  const bad = [];
  for (const f of b.files.filter((f) => !isRecutOwnPath(f.path))) {
    let st = null;
    try { st = fs.lstatSync(path.join(mirror, f.path)); } catch {}
    if (!st) bad.push(`${f.path} missing`);
    else if (!st.isFile()) bad.push(`${f.path} is not a regular file`);
    else if (st.size !== f.bytes) bad.push(`${f.path} is ${st.size} bytes, not ${f.bytes}`);
  }
  return bad;
}

/** Step `mirror`: refuses a mirror staging would overwrite, or one that lacks a shared file. Writes nothing. */
export function checkMirror(file, mirror, out, id) {
  const b = readRecord(file);
  const p = [];
  const hit = mirrorOverlaps(mirror, out, id);
  if (hit.length) p.push(`it overlaps ${hit.join(", ")}, which staging replaces (another --out)`);
  const bad = mirrorMisses(b, mirror);
  if (bad.length) p.push(`it does not hold ${b.id}'s files in the served layout (fetch --only all): ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? `, … (${bad.length} in all)` : ""}`);
  if (p.length) throw new Error(p.join("; "));
}

// ---------- clone ----------

/** Step `clone`: every file of the base outside tools/, cloned into `rel` and sha256-checked; a failure removes `rel`. */
export async function cloneShared(file, mirror, rel) {
  const b = readRecord(file);
  const shared = b.files.filter((f) => !isRecutOwnPath(f.path));
  let bytes = 0;
  try {
    for (const f of shared) {
      const dst = path.join(rel, f.path);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      // a clone where the filesystem can (APFS, btrfs, XFS), a copy elsewhere; never a hard link, which
      // would share the mirror's inode. Only listed paths: nothing else in the mirror is staged.
      fs.copyFileSync(path.join(mirror, f.path), dst, fs.constants.COPYFILE_FICLONE);
      // the clone is what the gate and the release read: hash it, not the mirror's file
      if (!fs.lstatSync(dst).isFile() || fs.statSync(dst).size !== f.bytes || (await sha256File(dst)) !== f.sha256) {
        throw new Error(`${f.path}: the mirror's bytes are not ${b.id}'s (not a regular file, or its size or sha256 is not its record's)`);
      }
      bytes += f.bytes;
    }
  } catch (e) {
    fs.rmSync(rel, { recursive: true, force: true });
    throw e;
  }
  return `${shared.length} files cloned from ${mirror} (${(bytes / 1e9).toFixed(2)} GB), each sha256-checked against ${b.id}'s record`;
}

// ---------- config ----------

/**
 * The release config of a release by reference, from its base's record `b` and what it owns:
 * every field but its own as the base recorded it. A tools re-cut (`recut`): its own are id, recut,
 * base, gate.checks, tools and notes. A runtime release by reference (`runtime` = {kernelCommit,
 * kernelPatch, wasmSha256}, its build's): also the kernel commit and patch, the gate (bound to them)
 * and the lean-lib entry (its own build's: release.mjs reads the rest from its manifest), and no
 * recut; the base's notes then follow a separator that says which of them hold for it. `recut` and
 * `checks` are the script's text (a count that is not digits is null).
 */
export function recutConfig(b, { id, recut, runtime = null, checks, version, tgz, commit, notes = [] }) {
  const count = /^\d+$/.test(checks) ? Number(checks) : null;
  const kernelCommit = runtime ? runtime.kernelCommit : b.kernel.commit;
  // what release.mjs cannot derive from the cloned manifests, as the base recorded it (a pack's note included)
  const entry = (p) => ({ id: p.id, compiler: p.lean.compiler, ...(p.mathlib ? { mathlib: p.mathlib } : {}), ...(p.note ? { note: p.note } : {}) });
  const sep = `Notes of ${b.id} (the base, ${b.digest}) follow verbatim: what they say of its packs, native64 and lists holds for this release, `
    + "whose files those are; what they say of its runtime and lean-lib is that release's.";
  return {
    id, upstreamTag: b.lean.upstreamTag, kernelCommit, kernelPatch: runtime ? runtime.kernelPatch : b.kernel.patch,
    kernelRepo: b.kernel.repo, kernelBranch: b.kernel.branch, ...(runtime ? {} : { recut: Number(recut) }), base: { id: b.id, digest: b.digest },
    leanVersion: b.lean.version,
    gate: runtime ? { commit: kernelCommit, wasmSha256: runtime.wasmSha256, checks: count } : { commit: b.gate.commit, wasmSha256: b.gate.wasmSha256, checks: count },
    packs: b.packs.map((p) => (runtime && p.id === "lean-lib" ? { id: "lean-lib", compiler: kernelCommit } : entry(p))),
    native64: b.native64, docker: b.docker, mathlib: b.mathlib, modules: b.modules, hosting: b.hosting,
    tools: { package: "lean4-wasm64", version, tgz: `tools/${tgz}`, commit },
    // its own notes first, then the base's verbatim (formats/release.md)
    notes: runtime ? [...notes, sep, ...b.notes] : [...notes, ...b.notes],
  };
}

const RUNTIME_OWN = /^([0-9a-f]{40}):(\d{4}[a-z]?):([0-9a-f]{64})$/;

/** Step `config`: writes recutConfig(<base record>) to `config`; `own` is a re-cut number or <kernel commit>:<patch>:<lean.wasm sha256>. */
export function writeRecutConfig(file, config, id, own, checks, version, tgz, commit, notes = []) {
  let kind;
  if (/^\d+$/.test(own)) kind = { recut: own };
  else {
    const m = RUNTIME_OWN.exec(own);
    if (!m) throw new Error(`<own> ${JSON.stringify(own)} is neither a re-cut number nor <kernel commit>:<patch>:<lean.wasm sha256>`);
    kind = { runtime: { kernelCommit: m[1], kernelPatch: m[2], wasmSha256: m[3] } };
  }
  fs.writeFileSync(config, JSON.stringify(recutConfig(readRecord(file), { id, ...kind, checks, version, tgz, commit, notes }), null, 2) + "\n");
}

// ---------- final ----------

const parseSums = (text) => new Map(text.split("\n").filter(Boolean).map((l) => {
  const m = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(l);
  if (!m) throw new Error(`SHA256SUMS line malformed: ${l.slice(0, 80)}`);
  return [m[2], m[1]];
}));

/**
 * Step `final`, after release.mjs and verify: the record names this base and keeps the equality
 * rules, and its SHA256SUMS differs from the base's at release.json and at files it owns only
 * (RELEASE.md; a path only the base lists is judged by the same rule). Then, for a tools re-cut
 * only, the shared paths by the content type R2 serves them with, written to
 * `<sidecar>.r2-objects.txt` and `<sidecar>.r2-manifests.txt` (its printed manual fallback reads
 * them; `publish` derives its own lists from the record). Nothing is written on a refusal.
 */
export async function finalCheck(file, rel, sidecar) {
  const { contentTypeOf } = await import("./publish-release.mjs");
  const baseText = fs.readFileSync(file);
  const b = JSON.parse(baseText);
  const r = JSON.parse(fs.readFileSync(path.join(rel, "release.json"), "utf8"));
  const p = [];
  // whatever release.mjs and verify did: the record names this base, and the equality rules hold
  if (r.base?.id !== b.id || r.base?.digest !== b.digest) p.push(`release.json names base ${JSON.stringify(r.base)}, not ${b.id} (${b.digest})`);
  p.push(...checkRecutBase(r, b));
  // SHA256SUMS against the base's own, computed from its record: only release.json and its own files may differ
  const theirs = parseSums(sha256sums([...b.files, { path: "release.json", sha256: createHash("sha256").update(baseText).digest("hex") }]));
  const ours = parseSums(fs.readFileSync(path.join(rel, "SHA256SUMS"), "utf8"));
  const differ = [...new Set([...theirs.keys(), ...ours.keys()])].filter((q) => theirs.get(q) !== ours.get(q)).sort();
  const bad = differ.filter((q) => q !== "release.json" && !isOwnPath(r, q));
  if (!differ.includes("release.json")) p.push(`SHA256SUMS names ${b.id}'s release.json: a release by reference has its own`);
  if (bad.length) p.push(`SHA256SUMS differs from ${b.id}'s at ${bad.join(", ")}: a release by reference differs from its base only at release.json and the files it owns (${ownLabel(r)})`);
  if (p.length) throw new Error(p.join("; "));
  // the shared paths by the content type R2 serves them with (publish-release.mjs, HOSTING.md): the
  // server-side copy from the base's prefix keeps each object's own
  const shared = r.files.map((f) => f.path).filter((q) => !isOwnPath(r, q));
  const objects = shared.filter((q) => contentTypeOf(q) === "application/octet-stream");
  const manifests = shared.filter((q) => contentTypeOf(q) === "application/json");
  if (byReferenceKind(r) === "tools") {
    fs.writeFileSync(`${sidecar}.r2-objects.txt`, objects.map((q) => `${q}\n`).join(""));
    fs.writeFileSync(`${sidecar}.r2-manifests.txt`, manifests.map((q) => `${q}\n`).join(""));
  }
  return `only release.json and its own files (${ownLabel(r)}) differ from ${b.id}: SHA256SUMS differs at ${differ.length} paths; `
    + `${r.files.length} files, ${r.files.length - shared.length} own, ${shared.length} shared (${objects.length} objects, ${manifests.length} manifests)`;
}

// ---------- the script's entry ----------

const STEPS = {
  base: { args: 2, run: ([file, tag]) => baseFields(file, tag) },
  pairing: { args: 2, run: ([file, c]) => checkPairing(file, c) },
  mirror: { args: 4, run: ([file, mirror, out, id]) => checkMirror(file, mirror, out, id) },
  clone: { args: 3, run: ([file, mirror, rel]) => cloneShared(file, mirror, rel) },
  config: { args: 8, more: true, run: ([file, config, id, own, checks, version, tgz, commit, ...notes]) => writeRecutConfig(file, config, id, own, checks, version, tgz, commit, notes) },
  final: { args: 3, run: ([file, rel, sidecar]) => finalCheck(file, rel, sidecar) },
};

/** Runs one step as the script calls it; returns the exit code (0 done, 1 refused, 2 usage). */
export async function main(argv = process.argv.slice(2)) {
  const [step, ...args] = argv;
  const s = Object.hasOwn(STEPS, step ?? "") ? STEPS[step] : null;
  if (!s || (s.more ? args.length < s.args : args.length !== s.args)) {
    console.error(`usage: stage-by-reference.mjs <${Object.keys(STEPS).join("|")}> <args…>   (stage-release.sh --base runs it; see its header)`);
    return 2;
  }
  try {
    const out = await s.run(args);
    if (out !== undefined) console.log(out);
    return 0;
  } catch (e) {
    console.error(`stage-by-reference ${step}: ${e?.message ?? e}`);
    return 1;
  }
}

const invokedDirectly = (() => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
// exitCode, not process.exit(): exiting while V8 compiles in the background can deadlock Node's
// platform shutdown (Node 26.3; fetch-release.mjs)
if (invokedDirectly) process.exitCode = await main();
