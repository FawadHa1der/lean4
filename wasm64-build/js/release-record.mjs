// The lean4-wasm64.release/v1 record: canonical form and self-digest
// (formats/release.md). Shared by release.mjs (writer), verify-release.mjs and
// fetch-release.mjs (readers). Node built-ins only.
//
// Canonical form: the keys in RELEASE_KEY_ORDER, in that order, `digest` last;
// JSON.stringify(record, null, 2) + "\n". The digest is
// "sha256:" + sha256(JSON.stringify(record without `digest`, null, 2)), so a
// reader recomputes it from the parsed object (JSON.parse keeps key order).
import { createHash } from "node:crypto";
import { RELEASE_SCHEMA, buildIdFromSha256, isBuildId, isSha256Hex, parsePatchId } from "./artifact-id.mjs";

export const RELEASE_KEY_ORDER = Object.freeze([
  "schema", "id", "base", "lean", "kernel", "gate", "runtime", "packs", "native64",
  "docker", "mathlib", "modules", "hosting", "tools", "notes", "files", "digest",
]);

/** Release ids: lean-<upstream tag>-<kernel commit, 7 hex>[-r<N>] (N ≥ 2: a tools-only re-cut). */
export const RELEASE_ID = /^lean-(v\d+\.\d+\.\d+(?:-rc\d+)?)-([0-9a-f]{7})(?:-r([2-9]|[1-9]\d+))?$/;
/** A record digest, as `--digest` and `base.digest` spell it. */
export const RELEASE_DIGEST = /^sha256:[0-9a-f]{64}$/;
/** The first cut a re-cut id belongs to (lean-v4.34.0-e1a79c1-r3 → lean-v4.34.0-e1a79c1); null for a first cut or a non-id. */
export const firstCutOf = (id) => {
  const m = RELEASE_ID.exec(typeof id === "string" ? id : "");
  return m?.[3] ? `lean-${m[1]}-${m[2]}` : null;
};

// ---------- a re-cut by reference (formats/release.md, "Re-cut by reference") ----------
/** The only directory a re-cut by reference changes; every other file is its base's. */
export const RECUT_OWN_DIRS = Object.freeze(["tools"]);
export const isRecutOwnPath = (p) => typeof p === "string" && RECUT_OWN_DIRS.some((d) => p.startsWith(`${d}/`));
/** Record fields a re-cut by reference has from its base, compared as JSON text (key order included). */
export const RECUT_SAME_KEYS = Object.freeze(["schema", "lean", "kernel", "runtime", "packs", "native64", "docker", "mathlib", "modules", "hosting"]);
/** gate fields that are the base's: the gate ran on the same binary (`checks` is the new tools' count). */
export const RECUT_SAME_GATE_KEYS = Object.freeze(["passed", "commit", "wasmSha256"]);

/**
 * The by-reference rule (formats/release.md, "Equality with the base"), given the base's
 * release.json: the base passes checkReleaseRecord, is exactly the release `base` pins (id and
 * digest) and names no base of its own; RECUT_SAME_KEYS and the gate's binding equal the base's;
 * tools.package is the base's and tools.version is not; and the files outside RECUT_OWN_DIRS are
 * exactly the base's (path, bytes, sha256: none missing, none extra). Returns the problems (empty
 * = the rule holds). Pure: the caller reads the base's record from wherever the base is.
 */
export function checkRecutBase(r, b) {
  if (!r?.base) return ["release.json names no base"];
  if (!b || typeof b !== "object" || Array.isArray(b)) return ["the base's release.json is not an object"];
  const p = checkReleaseRecord(b).map((q) => `the base's release.json: ${q}`);
  if (b.id !== r.base.id) p.push(`the base's release.json is ${JSON.stringify(b.id)}, the record names ${r.base.id}`);
  if (b.digest !== r.base.digest) p.push(`the base's release.json digest is ${b.digest}, the record pins ${r.base.digest}`);
  if (b.base !== undefined) p.push(`the base ${b.id} is itself a re-cut by reference (of ${b.base?.id}): a base is a first cut`);
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  for (const k of RECUT_SAME_KEYS) if (!same(r[k], b[k])) p.push(`${k} differs from the base's (a re-cut by reference changes ${RECUT_OWN_DIRS.join(", ")}/ only)`);
  for (const k of RECUT_SAME_GATE_KEYS) if (!same(r.gate?.[k], b.gate?.[k])) p.push(`gate.${k} differs from the base's`);
  if (r.tools?.package !== b.tools?.package) p.push(`tools.package ${JSON.stringify(r.tools?.package)} is not the base's ${JSON.stringify(b.tools?.package)}`);
  if (r.tools?.version === b.tools?.version) p.push(`tools.version ${r.tools?.version} is the base's: a re-cut ships other tools`);
  const theirs = new Map((Array.isArray(b.files) ? b.files : []).filter((f) => !isRecutOwnPath(f?.path)).map((f) => [f.path, f]));
  for (const f of Array.isArray(r.files) ? r.files : []) {
    if (isRecutOwnPath(f?.path)) continue;
    const g = theirs.get(f?.path);
    if (!g) p.push(`files[]: ${f?.path} is not a file of the base`);
    else if (g.bytes !== f.bytes || g.sha256 !== f.sha256) p.push(`files[]: ${f.path} is not the base's bytes`);
    theirs.delete(f?.path);
  }
  for (const q of theirs.keys()) p.push(`files[]: the base's ${q} is missing`);
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
 * names is one of its files, and, for a re-cut by reference, the structure of
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
  // a re-cut by reference: its structure here, needing no other record (rules S1-S5); the
  // comparison with the base is checkRecutBase
  if (r.base !== undefined) {
    if (!r.base || typeof r.base !== "object" || Array.isArray(r.base)) p.push("base is not an object {id, digest}");
    else {
      closed("base", r.base, ["id", "digest"]);
      const first = firstCutOf(r.id);
      if (!first) p.push(`base: only a re-cut (lean-<tag>-<kernel7>-rN) names a base, ${JSON.stringify(r.id)} is not one`);
      else if (r.base.id !== first) p.push(`base.id ${JSON.stringify(r.base.id)} is not ${first}: a re-cut by reference names its first cut`);
      if (!RELEASE_DIGEST.test(r.base.digest ?? "")) p.push("base.digest is not sha256:<64 lowercase hex>");
    }
    if (!r.tools) p.push("a re-cut by reference carries tools: tools missing");
    else {
      const recut = RELEASE_ID.exec(r.id ?? "")?.[3];
      if (r.tools.tgz !== `tools/${r.tools.package}-${r.tools.version}.tgz`) p.push(`tools.tgz ${JSON.stringify(r.tools.tgz)} is not tools/<package>-<version>.tgz`);
      if (recut && !String(r.tools.version ?? "").endsWith(`-r${recut}`)) p.push(`tools.version ${JSON.stringify(r.tools.version)} does not end in -r${recut}, the re-cut's number`);
    }
    const own = (Array.isArray(r.files) ? r.files : []).filter((f) => isRecutOwnPath(f?.path)).map((f) => f.path);
    if (own.length !== 1 || own[0] !== r.tools?.tgz) p.push(`a re-cut by reference has exactly one file under tools/, tools.tgz — got ${own.join(", ") || "none"}`);
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
  let prev = "";
  for (const f of files) {
    if (!isReleasePath(f?.path)) { p.push(`files[]: ${JSON.stringify(f?.path)} is not a safe release path`); continue; }
    if (!isInt(f.bytes) || !isSha256Hex(f.sha256)) p.push(`files[]: ${f.path} needs bytes and a 64-hex sha256`);
    if (byPath.has(f.path)) p.push(`files[]: ${f.path} listed twice`);
    // case-insensitive file systems (macOS, Windows) would fold two such paths into one file
    const folded = [...byPath.keys()].find((q) => q !== f.path && q.toLowerCase() === f.path.toLowerCase());
    if (folded) p.push(`files[]: ${f.path} and ${folded} differ only in letter case`);
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
  const unrecorded = [...byPath.keys()].filter((q) => q.startsWith("runtime/bin/") && !(Array.isArray(rt.bin) && rt.bin.some((e) => e?.path === q)));
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
