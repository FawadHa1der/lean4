// The lean4-wasm64.release/v1 record: canonical form and self-digest
// (formats/release.md). Shared by release.mjs (writer), verify-release.mjs and
// fetch-release.mjs (readers). Node built-ins only.
//
// Canonical form: the keys in RELEASE_KEY_ORDER, in that order, `digest` last;
// JSON.stringify(record, null, 2) + "\n". The digest is
// "sha256:" + sha256(JSON.stringify(record without `digest`, null, 2)), so a
// reader recomputes it from the parsed object (JSON.parse keeps key order).
import { createHash } from "node:crypto";
import { RELEASE_SCHEMA, buildIdFromSha256, comparePatchIds, isBuildId, isSha256Hex, parsePatchId } from "./artifact-id.mjs";

export const RELEASE_KEY_ORDER = Object.freeze([
  "schema", "id", "base", "lean", "kernel", "gate", "runtime", "packs", "native64",
  "docker", "mathlib", "modules", "hosting", "tools", "notes", "files", "digest",
]);

/** Release ids: lean-<upstream tag>-<kernel commit, 7 hex>[-r<N>] (N ≥ 2: a tools re-cut). */
export const RELEASE_ID = /^lean-(v\d+\.\d+\.\d+(?:-rc\d+)?)-([0-9a-f]{7})(?:-r([2-9]|[1-9]\d+))?$/;
/** A record digest, as `--digest` and `base.digest` spell it. */
export const RELEASE_DIGEST = /^sha256:[0-9a-f]{64}$/;
/** The first cut a re-cut id belongs to (lean-v4.34.0-e1a79c1-r3 → lean-v4.34.0-e1a79c1); null for a first cut or a non-id. */
export const firstCutOf = (id) => {
  const m = RELEASE_ID.exec(typeof id === "string" ? id : "");
  return m?.[3] ? `lean-${m[1]}-${m[2]}` : null;
};

// ---------- a release by reference (formats/release.md, "Release by reference") ----------
/** The only directory a tools re-cut changes; every other file is its base's. */
export const RECUT_OWN_DIRS = Object.freeze(["tools"]);
/** Record fields a tools re-cut has from its base, compared as JSON text (key order included). */
export const RECUT_SAME_KEYS = Object.freeze(["schema", "lean", "kernel", "runtime", "packs", "native64", "docker", "mathlib", "modules", "hosting"]);
/** gate fields that are the base's: the gate ran on the same binary (`checks` is the new tools' count). */
export const RECUT_SAME_GATE_KEYS = Object.freeze(["passed", "commit", "wasmSha256"]);
// Top-level record fields a runtime release by reference has from its base (with kernel.repo,
// kernel.branch, runtime.target and packs but its lean-lib entry: shared() below)
const RUNTIME_SAME_KEYS = Object.freeze(["schema", "lean", "native64", "docker", "mathlib", "modules", "hosting"]);

// What each kind of release by reference owns: its own files (its own GitHub assets), by path
// prefix. lean-lib's are exactly the names pack-set.mjs gives it (its manifest and transport parts),
// so a pack whose id merely starts with "lean-lib." stays shared.
const TOOLS_OWN = RECUT_OWN_DIRS.map((d) => `${d}/`);
const OWN = {
  tools: { prefixes: TOOLS_OWN, label: "tools/" },
  runtime: { prefixes: ["runtime/", "profiles/lean-lib.manifest.json", "profiles/lean-lib.pack.gzip.", ...TOOLS_OWN], label: "runtime/, profiles/lean-lib.* and tools/" },
};
const owns = (k, p) => typeof p === "string" && OWN[k].prefixes.some((d) => p.startsWith(d));
/** Whether `p` is under tools/: a tools re-cut's own file, and the one directory every release by reference owns. */
export const isRecutOwnPath = (p) => owns("tools", p);
/**
 * The kind of a release by reference, from its id and base.id alone: "tools" (base.id is the id's
 * first cut: the same kernel commit, so the base's runtime: a tools re-cut), "runtime" (any other
 * base: its own runtime and lean-lib), null (no base: a release by value).
 */
export const byReferenceKind = (r) => {
  if (r?.base === undefined) return null;
  const first = firstCutOf(r?.id);
  return first !== null && r.base?.id === first ? "tools" : "runtime";
};
/** Whether `p` is one of the release's own files (its own GitHub asset). A release without base owns every file. */
export const isOwnPath = (r, p) => {
  const k = byReferenceKind(r);
  return k ? owns(k, p) : typeof p === "string";
};
/** How messages name what a release owns. */
export const ownLabel = (r) => { const k = byReferenceKind(r); return k ? OWN[k].label : "every file"; };

/** The fields a release by reference of kind `k` shares with its base (equality rule E2), by name. */
function shared(k, r) {
  const pick = (keys) => Object.fromEntries(keys.map((x) => [x, r?.[x]]));
  if (k === "tools") return { ...pick(RECUT_SAME_KEYS), ...Object.fromEntries(RECUT_SAME_GATE_KEYS.map((x) => [`gate.${x}`, r?.gate?.[x]])) };
  return {
    ...pick(RUNTIME_SAME_KEYS),
    "kernel.repo": r?.kernel?.repo, "kernel.branch": r?.kernel?.branch, "runtime.target": r?.runtime?.target,
    // which packs, in which order, each the base's entry — but lean-lib, the release's own (S6 binds it)
    packs: Array.isArray(r?.packs) ? r.packs.map((p) => (p?.id === "lean-lib" ? { id: p.id } : p)) : r?.packs,
  };
}

/**
 * The by-reference rule (formats/release.md, "Equality with the base"), given the base's
 * release.json: the base is exactly the release `base` pins (id, digest and its self-digest:
 * checked first, so any other record is refused on that alone) and names no base of its own (E1);
 * it passes checkReleaseRecord; the fields the record's kind shares with its base equal the base's
 * (E2); tools.package is the base's, tools.version is not and, for a runtime release by reference,
 * runtime.buildId is not and kernel.patch does not precede the base's (E3); and the files it does not own are exactly the base's files outside
 * them (path, bytes, sha256: none missing, none extra; E4). Returns the problems (empty = the rule
 * holds), whatever the base's release.json holds. Pure: the caller reads the base's record from
 * wherever the base is.
 */
export function checkRecutBase(r, b) {
  if (!r?.base) return ["release.json names no base"];
  if (!b || typeof b !== "object" || Array.isArray(b)) return ["the base's release.json is not an object"];
  // The pin first, and cheap: a record other than the one base.digest pins is refused on that
  // alone, before its structure (a files[] of any length, from wherever the base was read) is walked.
  const pin = [];
  let pinned = b.digest === r.base.digest;
  if (b.id !== r.base.id) pin.push(`the base's release.json is ${JSON.stringify(b.id)}, the record names ${r.base.id}`);
  if (!pinned) pin.push(`the base's release.json digest is ${b.digest}, the record pins ${r.base.digest}`);
  else if (releaseDigest(b) !== b.digest) { pinned = false; pin.push("the base's release.json: self-digest does not match the content"); }
  if (b.base !== undefined) pin.push(`the base ${b.id} names a base of its own (${b.base?.id}): a base names no base of its own`);
  if (!pinned) return pin;
  const p = checkReleaseRecord(b).map((q) => `the base's release.json: ${q}`).concat(pin);
  const k = byReferenceKind(r);
  // E2: one projection per kind, compared key by key as JSON text (key order included)
  const mine = shared(k, r), theirs = shared(k, b);
  for (const key of Object.keys(mine)) if (JSON.stringify(mine[key]) !== JSON.stringify(theirs[key])) p.push(`${key} differs from the base's`);
  // E3: what must differ
  if (r.tools?.package !== b.tools?.package) p.push(`tools.package ${JSON.stringify(r.tools?.package)} is not the base's ${JSON.stringify(b.tools?.package)}`);
  if (r.tools?.version === b.tools?.version) p.push(`tools.version ${r.tools?.version} is the base's: a release by reference ships its own tools`);
  if (k === "runtime" && r.runtime?.buildId === b.runtime?.buildId) {
    p.push(`runtime.buildId ${r.runtime?.buildId} is the base's: a runtime release by reference ships its own runtime (a tools re-cut, -rN, keeps the base's)`);
  }
  // ... and is a later build of the base's line: its patch id never precedes the base's (a malformed
  // id is checkReleaseRecord's problem)
  let earlier = false;
  try { earlier = k === "runtime" && comparePatchIds(r.kernel?.patch, b.kernel?.patch) < 0; } catch {}
  if (earlier) p.push(`kernel.patch ${r.kernel.patch} precedes the base's ${b.kernel.patch}: a runtime release by reference is a later build of the base's line`);
  // E4: an entry that is no object (null, say) is the base's structural problem above, never a crash here
  const theirFiles = new Map((Array.isArray(b.files) ? b.files : []).filter((f) => f && typeof f === "object" && !isOwnPath(r, f.path)).map((f) => [f.path, f]));
  for (const f of Array.isArray(r.files) ? r.files : []) {
    if (isOwnPath(r, f?.path)) continue;
    const g = theirFiles.get(f?.path);
    if (!g) p.push(`files[]: ${f?.path} is not a file of the base`);
    else if (g.bytes !== f?.bytes || g.sha256 !== f?.sha256) p.push(`files[]: ${f?.path} is not the base's bytes`);
    theirFiles.delete(f?.path);
  }
  for (const q of theirFiles.keys()) p.push(`files[]: the base's ${q} is missing`);
  return p;
}

export function expectedReleaseId(upstreamTag, kernelCommit, recut) {
  return `lean-${upstreamTag}-${kernelCommit.slice(0, 7)}${recut ? `-r${recut}` : ""}`;
}

export function releaseDigest(record) {
  const { digest: _ignored, ...rest } = record;
  return `sha256:${createHash("sha256").update(JSON.stringify(rest, null, 2)).digest("hex")}`;
}

/** Order the keys canonically and set the self-digest. Unknown keys are refused. */
export function canonicalRelease(fields) {
  const unknown = Object.keys(fields).filter((k) => !RELEASE_KEY_ORDER.includes(k));
  if (unknown.length) throw new Error(`unknown release.json keys: ${unknown.join(", ")}`);
  const ordered = {};
  for (const k of RELEASE_KEY_ORDER) if (k !== "digest" && fields[k] !== undefined) ordered[k] = fields[k];
  ordered.digest = releaseDigest(ordered);
  return ordered;
}

export const serializeRelease = (record) => `${JSON.stringify(record, null, 2)}\n`;

/** SHA256SUMS text (sha256sum format, sorted by path) for {path, sha256} entries. */
export function sha256sums(entries) {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => `${e.sha256}  ${e.path}`).join("\n") + "\n";
}

/** The top-level directories of a release (formats/README.md, layout). */
export const RELEASE_DIRS = ["runtime", "profiles", "native64", "lists", "tools"];
/** One path segment: no "." / ".." / dotfiles, no separators, no escapes. */
export const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
/** Manifest URLs a release carries — site-absolute, mounted at the origin root (HOSTING.md). */
export const CHUNK_URL = /^\/runtime\/chunks\/[A-Za-z0-9][A-Za-z0-9._+-]*$/;
export const PART_URL = /^\/profiles\/[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * A release-relative file path: "/"-separated safe segments under one of
 * RELEASE_DIRS. Never absolute, never ".", "..", empty, a dotfile or a
 * backslash — so joining it under an output directory cannot leave it.
 */
export function isReleasePath(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 512) return false;
  const segs = p.split("/");
  return segs.length >= 2 && RELEASE_DIRS.includes(segs[0]) && segs.every((s) => SAFE_SEGMENT.test(s));
}

/**
 * The release-relative path a manifest URL names, resolved the way a browser
 * resolves it on the site the release is mounted at: against the URL of the
 * manifest that holds it (`fromRel`, e.g. "profiles/x.manifest.json"). Site-
 * absolute URLs (/runtime/chunks/…, /profiles/…) and bare part names beside the
 * manifest both land inside the release. A URL naming another origin, or one
 * with percent-escapes (which could smuggle "/" or ".." past the
 * normalization), throws.
 */
export function servedPath(url, fromRel = "") {
  const base = "https://release.invalid/";
  const u = new URL(url, base + fromRel);
  if (u.origin !== new URL(base).origin) throw new Error(`${url}: not a path on the release's own origin`);
  if (u.pathname.includes("%") || u.search || u.hash) throw new Error(`${url}: escapes, queries and fragments are not release paths`);
  return u.pathname.replace(/^\/+/, "");
}

/**
 * Every structural rule of a lean4-wasm64.release/v1 record that needs no file
 * bytes (formats/release.md): schema, canonical keys, self-digest, the id rule,
 * the gate binding, the build-id rule, safe paths, that every path the record
 * names is one of its files, and, for a release by reference, the structure of
 * `base` (the comparison with the base is checkRecutBase). Returns the problems
 * (empty = valid). Fetch runs it before any I/O; verify-release and release.mjs
 * run it too.
 */
export function checkReleaseRecord(r) {
  const p = [];
  const isInt = (n, min = 0) => Number.isInteger(n) && n >= min;
  const HEX40 = /^[0-9a-f]{40}$/;
  if (!r || typeof r !== "object") return ["release.json is not an object"];
  if (r.schema !== RELEASE_SCHEMA) p.push(`schema ${JSON.stringify(r.schema)} is not ${RELEASE_SCHEMA}`);
  const keys = Object.keys(r);
  const unknown = keys.filter((k) => !RELEASE_KEY_ORDER.includes(k));
  if (unknown.length) p.push(`unknown keys: ${unknown.join(", ")}`);
  const canonical = RELEASE_KEY_ORDER.filter((k) => keys.includes(k));
  if (keys.join() !== canonical.join() || keys.at(-1) !== "digest") p.push("keys are not in canonical order with digest last");
  if (r.digest !== releaseDigest(r)) p.push("self-digest does not match the content");
  // identity
  const m = RELEASE_ID.exec(r.id ?? "");
  if (!m) p.push(`id ${JSON.stringify(r.id)} is not lean-<tag>-<kernel7>[-rN]`);
  else {
    if (m[1] !== r.lean?.upstreamTag) p.push(`id ${r.id} names tag ${m[1]}, lean.upstreamTag is ${r.lean?.upstreamTag}`);
    if (m[2] !== String(r.kernel?.commit).slice(0, 7)) p.push(`id ${r.id} names kernel ${m[2]}, kernel.commit is ${r.kernel?.commit}`);
  }
  if (typeof r.lean?.version !== "string" || !r.lean.version) p.push("lean.version missing");
  if (!HEX40.test(r.kernel?.commit ?? "")) p.push("kernel.commit is not a 40-hex commit");
  try { parsePatchId(r.kernel?.patch); } catch (e) { p.push(`kernel.patch: ${e.message}`); }
  if (r.gate?.passed !== true) p.push("gate.passed is not true");
  if (r.gate?.commit !== r.kernel?.commit) p.push("gate.commit ≠ kernel.commit: the gate must have run on the released build");
  const rt = r.runtime ?? {};
  const wasm = rt.files?.["lean.wasm"];
  if (!isSha256Hex(r.gate?.wasmSha256) || r.gate.wasmSha256 !== wasm?.sha256) p.push("gate.wasmSha256 is not the runtime's lean.wasm sha256");
  if (!isBuildId(rt.buildId)) p.push(`runtime.buildId ${JSON.stringify(rt.buildId)} is not wasm64-<16 hex>`);
  else if (isSha256Hex(wasm?.sha256) && rt.buildId !== buildIdFromSha256(wasm.sha256)) p.push("runtime.buildId breaks the build-id rule for runtime.files[lean.wasm].sha256");
  const fileNames = Object.keys(rt.files ?? {}).sort().join();
  if (fileNames !== "lean.js,lean.wasm") p.push(`runtime.files must be exactly lean.js and lean.wasm, got ${fileNames || "none"}`);
  for (const [n, f] of Object.entries(rt.files ?? {})) {
    if (!isInt(f?.bytes, 1) || !isSha256Hex(f?.sha256) || !isInt(f?.chunks, 1)) p.push(`runtime.files[${n}] needs bytes, a 64-hex sha256 and a chunk count`);
  }
  // closed objects: a key nobody defined is a typo or an injection, never data
  const closed = (what, o, keys) => {
    if (o === undefined || o === null) return;
    if (typeof o !== "object" || Array.isArray(o)) { p.push(`${what} is not an object`); return; }
    const extra = Object.keys(o).filter((k) => !keys.includes(k));
    if (extra.length) p.push(`${what}: unknown keys ${extra.join(", ")}`);
  };
  closed("lean", r.lean, ["version", "upstreamTag"]);
  closed("kernel", r.kernel, ["repo", "branch", "commit", "patch"]);
  closed("gate", r.gate, ["passed", "commit", "wasmSha256", "checks"]);
  closed("runtime", r.runtime, ["buildId", "manifest", "target", "sourceRevision", "files", "bin"]);
  for (const [n, f] of Object.entries(rt.files ?? {})) closed(`runtime.files[${n}]`, f, ["bytes", "sha256", "chunks"]);
  for (const e of Array.isArray(rt.bin) ? rt.bin : []) closed(`runtime.bin[${e?.name}]`, e, ["name", "path", "bytes", "sha256"]);
  closed("native64", r.native64, ["commit", "os", "arch", "tar"]);
  closed("docker", r.docker, ["tag", "recipeCommit", "imageId", "base"]);
  closed("mathlib", r.mathlib, ["commit", "tag"]);
  closed("tools", r.tools, ["package", "version", "tgz", "commit"]);
  // a release by reference: its structure here, needing no other record (rules S1-S6); the
  // comparison with the base is checkRecutBase
  if (r.base !== undefined) {
    const kind = byReferenceKind(r);
    if (!r.base || typeof r.base !== "object" || Array.isArray(r.base)) p.push("base is not an object {id, digest}");
    else {
      closed("base", r.base, ["id", "digest"]);
      if (m) {
        // S2: a first cut of the id's own tag
        const mb = RELEASE_ID.exec(typeof r.base.id === "string" ? r.base.id : "");
        if (!mb || mb[3] || mb[1] !== m[1]) p.push(`base.id ${JSON.stringify(r.base.id)} is not a first cut of ${m[1]} (lean-${m[1]}-<kernel7>): a release by reference names a first cut of its tag`);
        // S3: a runtime release by reference is a first cut of its own kernel commit, naming another
        if (kind === "runtime" && m[3]) p.push(`base.id ${r.base.id} is not ${firstCutOf(r.id)}: an -rN release by reference is a tools re-cut of its first cut`);
        else if (kind === "runtime" && r.base.id === r.id) p.push(`base.id is ${r.id} itself: a runtime release by reference names a first cut of another kernel commit`);
      }
      if (!RELEASE_DIGEST.test(r.base.digest ?? "")) p.push("base.digest is not sha256:<64 lowercase hex>");
    }
    // S5: its own tools, versioned as its id
    if (!r.tools) p.push("a release by reference carries its own tools: tools missing");
    else {
      if (r.tools.tgz !== `tools/${r.tools.package}-${r.tools.version}.tgz`) p.push(`tools.tgz ${JSON.stringify(r.tools.tgz)} is not tools/<package>-<version>.tgz`);
      if (m) {
        const want = `${r.lean?.version}-${m[2]}${m[3] ? `-r${m[3]}` : ""}`;
        if (r.tools.version !== want) p.push(`tools.version ${JSON.stringify(r.tools.version)} is not ${want}: <lean.version>-<kernel7>[-rN], as the id`);
      }
    }
    const tools = (Array.isArray(r.files) ? r.files : []).filter((f) => isRecutOwnPath(f?.path)).map((f) => f.path);
    if (tools.length !== 1 || tools[0] !== r.tools?.tgz) p.push(`a release by reference has exactly one file under tools/, tools.tgz — got ${tools.join(", ") || "none"}`);
    // S6: a runtime release by reference's lean-lib is its own build's lib/lean
    const lib = kind === "runtime" && Array.isArray(r.packs) ? r.packs.find((k) => k?.id === "lean-lib") : undefined;
    if (lib) {
      const kernel = String(r.kernel?.commit);
      const bad = [];
      if (lib.lean?.compiler !== r.kernel?.commit) bad.push(`lean.compiler ${lib.lean?.compiler} is not kernel.commit ${r.kernel?.commit}`);
      if (lib.lean?.gitRevision !== kernel.slice(0, 12)) bad.push(`lean.gitRevision ${JSON.stringify(lib.lean?.gitRevision)} is not ${kernel.slice(0, 12)}`);
      const release = `lean-lib-${r.lean?.version}-${r.runtime?.buildId}`;
      if (lib.release !== release) bad.push(`release ${JSON.stringify(lib.release)} is not ${release}`);
      if (bad.length) p.push(`packs[lean-lib]: ${bad.join("; ")}: a runtime release by reference's lean-lib is its own build's lib/lean`);
    }
  }
  for (const k of Array.isArray(r.packs) ? r.packs : []) {
    closed(`packs[${k?.id}]`, k, ["id", "manifest", "release", "modules", "rawBytes", "rawSha256", "roots", "lean", "mathlib", "note"]);
    closed(`packs[${k?.id}].lean`, k?.lean, ["version", "compiler", "gitRevision"]);
    closed(`packs[${k?.id}].mathlib`, k?.mathlib, ["commit", "tag"]);
    if (k?.mathlib !== undefined && !/^[0-9a-f]{40}$/.test(k.mathlib?.commit ?? "")) p.push(`packs[${k?.id}].mathlib.commit is not a 40-hex commit`);
  }
  for (const f of Array.isArray(r.files) ? r.files : []) closed(`files[${f?.path}]`, f, ["path", "bytes", "sha256"]);
  // files[]
  const files = Array.isArray(r.files) ? r.files : [];
  if (!Array.isArray(r.files) || !files.length) p.push("files[] missing or empty");
  const byPath = new Map();
  const basenames = new Map();
  // lower-cased path → the first two distinct paths that fold to it, in the order listed: enough
  // to name the first earlier path a later one collides with, in one lookup (linear in files[])
  const byFolded = new Map();
  let prev = "";
  for (const f of files) {
    if (!isReleasePath(f?.path)) { p.push(`files[]: ${JSON.stringify(f?.path)} is not a safe release path`); continue; }
    if (!isInt(f.bytes) || !isSha256Hex(f.sha256)) p.push(`files[]: ${f.path} needs bytes and a 64-hex sha256`);
    if (byPath.has(f.path)) p.push(`files[]: ${f.path} listed twice`);
    // case-insensitive file systems (macOS, Windows) would fold two such paths into one file
    const lower = f.path.toLowerCase();
    const earlier = byFolded.get(lower);
    const folded = earlier?.find((q) => q !== f.path);
    if (folded) p.push(`files[]: ${f.path} and ${folded} differ only in letter case`);
    if (!earlier) byFolded.set(lower, [f.path]);
    else if (earlier.length < 2 && !earlier.includes(f.path)) earlier.push(f.path);
    if (f.path <= prev) p.push(`files[]: not sorted at ${f.path}`);
    prev = f.path;
    byPath.set(f.path, f);
    const b = f.path.split("/").at(-1);
    if (["release.json", "sha256sums"].includes(b.toLowerCase())) p.push(`files[]: ${f.path} uses a reserved name`);
    if (basenames.has(b.toLowerCase())) p.push(`files[]: ${f.path} and ${basenames.get(b.toLowerCase())} share a basename (the GitHub release is flat)`);
    basenames.set(b.toLowerCase(), f.path);
  }
  const listed = (what, path, dir) => {
    if (!byPath.has(path)) p.push(`${what} ${JSON.stringify(path)} is not one of files[]`);
    else if (dir && !path.startsWith(`${dir}/`)) p.push(`${what} ${path} is not under ${dir}/`);
  };
  if (rt.manifest !== "runtime/runtime-manifest.json") p.push(`runtime.manifest must be runtime/runtime-manifest.json, got ${JSON.stringify(rt.manifest)}`);
  listed("runtime.manifest", rt.manifest);
  if (!Array.isArray(rt.bin ?? [])) p.push("runtime.bin is not an array");
  // fetch writes the extras beside lean.js / lean.wasm and its own package.json: none may be
  // one of those, in any letter case (macOS and Windows file systems fold case)
  const RESERVED = ["lean.js", "lean.wasm", "package.json"];
  const binNames = new Set();
  for (const e of Array.isArray(rt.bin) ? rt.bin : []) {
    const lower = String(e?.name).toLowerCase();
    if (!SAFE_SEGMENT.test(e?.name ?? "") || RESERVED.includes(lower) || binNames.has(lower)) { p.push(`runtime.bin name ${JSON.stringify(e?.name)} is not a safe, unreserved, unique file name`); continue; }
    binNames.add(lower);
    if (e.path !== `runtime/bin/${e.name}`) p.push(`runtime.bin ${e.name}: path must be runtime/bin/${e.name}`);
    const f = byPath.get(e.path);
    if (!f || f.bytes !== e.bytes || f.sha256 !== e.sha256) p.push(`runtime.bin ${e.name} does not match its files[] entry`);
  }
  const binPaths = new Set((Array.isArray(rt.bin) ? rt.bin : []).map((e) => e?.path));
  const unrecorded = [...byPath.keys()].filter((q) => q.startsWith("runtime/bin/") && !binPaths.has(q));
  if (unrecorded.length) p.push(`runtime/bin files missing from runtime.bin: ${unrecorded.join(", ")}`);
  const ids = new Set();
  if (!Array.isArray(r.packs ?? [])) p.push("packs is not an array");
  for (const k of Array.isArray(r.packs) ? r.packs : []) {
    if (!SAFE_SEGMENT.test(k?.id ?? "") || ids.has(k.id)) { p.push(`packs[]: id ${JSON.stringify(k?.id)} missing, unsafe or repeated`); continue; }
    ids.add(k.id);
    if (k.manifest !== `profiles/${k.id}.manifest.json`) p.push(`packs[${k.id}].manifest must be profiles/${k.id}.manifest.json`);
    listed(`packs[${k.id}].manifest`, k.manifest);
    if (k.lean?.version !== r.lean?.version) p.push(`packs[${k.id}] is for Lean ${k.lean?.version}, the release is Lean ${r.lean?.version} (pairing rule)`);
    if (!HEX40.test(k.lean?.compiler ?? "")) p.push(`packs[${k.id}].lean.compiler is not a 40-hex commit`);
    if (!isSha256Hex(k.rawSha256) || !isInt(k.rawBytes, 1) || !isInt(k.modules, 1)) p.push(`packs[${k.id}] needs rawSha256, rawBytes and modules`);
  }
  if (r.native64) { listed("native64.tar", r.native64.tar, "native64"); if (!HEX40.test(r.native64.commit ?? "")) p.push("native64.commit is not a 40-hex commit"); }
  if (r.tools) listed("tools.tgz", r.tools.tgz, "tools");
  for (const [k, v] of Object.entries(r.modules ?? {})) listed(`modules.${k}`, v, "lists");
  return p;
}
