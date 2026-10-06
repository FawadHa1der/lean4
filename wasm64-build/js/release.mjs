#!/usr/bin/env node
// Write release.json (lean4-wasm64.release/v1) and SHA256SUMS for a staged
// release directory in the served layout (formats/release.md):
//
//   <dir>/runtime/runtime-manifest.json + runtime-manifest.<buildId>.json + chunks/ + bin/<extras>
//   <dir>/profiles/<pack>.manifest.json + its transport parts
//   <dir>/native64/native64.tar.gz      <dir>/lists/*      <dir>/tools/lean4-wasm64-<version>.tgz
//
//   release.mjs --release <dir> --config <release-config.json>
//
// Everything derivable is derived from the directory (runtime identity, pack
// identities and module counts, the file list); the config carries the rest
// (formats/release.md, "release config"). Refuses — writes nothing — when a
// pairing rule or an identity check fails: the release is the contract every
// consumer pins, so a wrong record must not exist.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyCliContract } from "./cli-args.mjs";
import {
  RELEASE_SCHEMA, ARTIFACT_MANIFEST_FORMAT, checkRuntimeManifest, parsePatchId, sha256File,
} from "./artifact-id.mjs";
import {
  CHUNK_URL, PART_URL, RELEASE_ID, SAFE_SEGMENT, canonicalRelease, checkReleaseRecord, expectedReleaseId,
  serializeRelease, servedPath, sha256sums,
} from "./release-record.mjs";

applyCliContract({
  tool: "release",
  usage: "release.mjs --release <dir> --config <release-config.json>",
  flags: { release: 1, config: 1 },
  required: [["release"], ["config"]],
  passthrough: null,
  help: [
    "usage: release.mjs --release <dir> --config <release-config.json>",
    "Write release.json + SHA256SUMS for a staged release directory; refuses on any failed identity or pairing check.",
    "run as: lean4-wasm64 release   (or: node release.mjs)",
    "",
    "flags:",
    "  --release <dir>    the staged release directory (served layout) [required]",
    "  --config <file>    release config JSON (formats/release.md) [required]",
    "  -h, --help         print this help and exit 0",
    "",
    "exit codes: 0 written, 1 refused (reasons printed), 2 usage",
  ].join("\n"),
});
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const dir = path.resolve(arg("release"));
const config = JSON.parse(fs.readFileSync(path.resolve(arg("config")), "utf8"));
const refusals = [];
const refuse = (msg) => refusals.push(msg);
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const strip = (d) => (typeof d === "string" && d.startsWith("sha256:") ? d.slice(7) : d);
const HEX40 = /^[0-9a-f]{40}$/;

// ---------- config ----------
for (const k of ["upstreamTag", "kernelCommit", "kernelPatch", "gate", "packs", "native64", "docker", "mathlib", "tools"]) {
  if (config[k] === undefined) refuse(`config.${k} missing`);
}
if (!HEX40.test(config.kernelCommit ?? "")) refuse(`config.kernelCommit is not a 40-hex commit`);
try { parsePatchId(config.kernelPatch); } catch (e) { refuse(e.message); }
const id = config.id ?? (config.kernelCommit ? expectedReleaseId(config.upstreamTag, config.kernelCommit, config.recut) : "");
const idMatch = RELEASE_ID.exec(id);
if (!idMatch) refuse(`release id ${JSON.stringify(id)} is not lean-<tag>-<kernel7>[-rN]`);
else if (idMatch[1] !== config.upstreamTag || idMatch[2] !== config.kernelCommit.slice(0, 7)) refuse(`release id ${id} does not name tag ${config.upstreamTag} and kernel ${config.kernelCommit?.slice(0, 7)}`);

// ---------- runtime ----------
const manifestRel = "runtime/runtime-manifest.json";
const manifestPath = path.join(dir, manifestRel);
let runtime = null;
if (!fs.existsSync(manifestPath)) refuse(`${manifestRel} missing`);
else {
  runtime = readJson(manifestPath);
  for (const p of checkRuntimeManifest(runtime)) refuse(`runtime manifest: ${p}`);
  const perBuild = path.join(dir, "runtime", `runtime-manifest.${runtime.buildId}.json`);
  if (!fs.existsSync(perBuild) || !fs.readFileSync(perBuild).equals(fs.readFileSync(manifestPath))) {
    refuse(`runtime/runtime-manifest.${runtime.buildId}.json missing or not a byte copy`);
  }
  if (config.leanVersion && config.leanVersion !== runtime.leanVersion) refuse(`config leanVersion ${config.leanVersion} ≠ runtime leanVersion ${runtime.leanVersion}`);
  if (config.gate?.commit !== config.kernelCommit) refuse(`gate.commit ${config.gate?.commit} ≠ kernelCommit ${config.kernelCommit} (the gate must have run on the released build)`);
  if (config.gate?.wasmSha256 !== runtime.files?.["lean.wasm"]?.sha256) refuse("gate.wasmSha256 ≠ the runtime's lean.wasm sha256");
  // site-absolute under the mount the sites map (HOSTING.md): never a scheme, host, R2 key or bare name
  for (const [n, f] of Object.entries(runtime.files ?? {})) {
    for (const c of f.chunks ?? []) if (!CHUNK_URL.test(c.url ?? "")) refuse(`runtime manifest ${n}: chunk url ${c.url} is not /runtime/chunks/<name>`);
  }
}
const binExtras = [];
const binDir = path.join(dir, "runtime", "bin");
if (fs.existsSync(binDir)) {
  for (const name of fs.readdirSync(binDir).sort()) {
    if (["lean.js", "lean.wasm"].includes(name.toLowerCase())) { refuse(`runtime/bin/${name}: the pair ships as chunks, not as files`); continue; }
    if (name.toLowerCase() === "package.json") { refuse("runtime/bin/package.json: fetch writes its own (the CommonJS pin); do not ship one"); continue; }
    if (!SAFE_SEGMENT.test(name)) { refuse(`runtime/bin/${name}: not a safe file name`); continue; }
    const p = path.join(binDir, name);
    if (!fs.lstatSync(p).isFile()) { refuse(`runtime/bin/${name}: not a regular file`); continue; }
    binExtras.push({ name, path: `runtime/bin/${name}`, bytes: fs.statSync(p).size, sha256: await sha256File(p) });
  }
}

// ---------- packs ----------
const packs = [];
for (const want of config.packs ?? []) {
  const mrel = `profiles/${want.id}.manifest.json`;
  const mpath = path.join(dir, mrel);
  if (!fs.existsSync(mpath)) { refuse(`${mrel} missing`); continue; }
  const m = readJson(mpath);
  if (m.format !== ARTIFACT_MANIFEST_FORMAT || m.version !== 1) refuse(`${mrel}: format ${m.format} v${m.version}`);
  const c = m.content ?? {};
  // what browser loaders check before using a pack (QED64 profiles.ts): refuse here, not in their hands
  if (m.digest !== `sha256:${createHash("sha256").update(JSON.stringify(c)).digest("hex")}`) refuse(`${mrel}: manifest digest is not sha256 of its content`);
  const tparts = c.pack?.transport?.parts ?? [];
  if (c.pack?.transport?.encoding !== "gzip") refuse(`${mrel}: transport encoding ${c.pack?.transport?.encoding} is not gzip`);
  if (tparts.reduce((n, q) => n + q.byteLength, 0) !== c.pack?.transport?.byteLength) refuse(`${mrel}: transport parts do not sum to transport.byteLength`);
  if (runtime && c.lean?.version !== runtime.leanVersion) refuse(`${want.id}: packed for Lean ${c.lean?.version}, runtime is Lean ${runtime.leanVersion} (pairing rule)`);
  if (!HEX40.test(want.compiler ?? "")) refuse(`${want.id}: compiler must be the 40-hex commit whose compiler wrote the oleans`);
  for (const part of c.pack?.transport?.parts ?? []) {
    if (!PART_URL.test(part.url ?? "")) { refuse(`${want.id}: part url ${part.url} is not /profiles/<name> (pack it with --url-prefix /profiles/)`); continue; }
    // as a browser resolves it: site-absolute (/profiles/…) or a bare name beside the manifest
    let prel;
    try { prel = servedPath(part.url, mrel); } catch (e) { refuse(`${want.id}: ${e.message}`); continue; }
    if (!prel.startsWith("profiles/")) refuse(`${want.id}: transport part ${part.url} resolves to ${prel}, outside profiles/`);
    else if (!fs.existsSync(path.join(dir, prel))) refuse(`${want.id}: transport part ${prel} missing`);
  }
  packs.push({
    id: want.id,
    manifest: mrel,
    release: c.release,
    modules: Object.keys(c.modules ?? {}).length,
    rawBytes: c.pack?.byteLength,
    rawSha256: strip(c.pack?.digest),
    roots: c.roots ?? [],
    lean: { version: c.lean?.version, compiler: want.compiler, gitRevision: c.lean?.gitRevision },
    ...(want.mathlib ? { mathlib: want.mathlib } : {}),
    ...(want.note ? { note: want.note } : {}),
  });
}

// ---------- the rest: present files ----------
for (const [k, rel] of [["native64.tar", config.native64?.tar], ["tools.tgz", config.tools?.tgz]]) {
  if (rel && !fs.existsSync(path.join(dir, rel))) refuse(`${k}: ${rel} missing`);
}
for (const rel of Object.values(config.modules ?? {})) if (!fs.existsSync(path.join(dir, rel))) refuse(`module list ${rel} missing`);
if (config.native64 && !HEX40.test(config.native64.commit ?? "")) refuse("native64.commit must be a 40-hex commit");

if (refusals.length) {
  console.error(`release: REFUSED — ${refusals.length} problem(s):\n  ${refusals.join("\n  ")}`);
  process.exit(1);
}

// ---------- files[] ----------
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(d, e.name);
    const relPath = path.relative(dir, p).split(path.sep).join("/");
    // the publish commands upload regular files with safe names: anything else would be a listed, unpublished file
    if (!SAFE_SEGMENT.test(e.name)) { refuse(`${relPath}: dotfiles and unsafe names are not release files`); continue; }
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.isFile()) { refuse(`${relPath}: not a regular file (a symlink, fifo or socket is never uploaded)`); continue; }
    if (relPath === "release.json" || relPath === "SHA256SUMS") continue;
    files.push({ path: relPath, bytes: fs.statSync(p).size });
  }
})(dir);
// GitHub release assets are flat (one name space): every basename must be unique.
const seen = new Map();
for (const f of files) {
  const b = path.posix.basename(f.path);
  if (seen.has(b)) refuse(`two files share the basename ${b} (${seen.get(b)}, ${f.path}): the flat GitHub layout needs unique names`);
  seen.set(b, f.path);
}
for (const b of ["release.json", "SHA256SUMS"]) if (seen.has(b)) refuse(`a staged file is named ${b}`);
// nothing stale: every chunk and every profiles/ file must be named by the runtime manifest or a configured pack
const referenced = new Set(packs.map((p) => p.manifest));
for (const f of Object.values(runtime.files)) for (const c of f.chunks) referenced.add(servedPath(c.url, manifestRel));
for (const p of packs) {
  for (const part of readJson(path.join(dir, p.manifest)).content.pack.transport.parts) referenced.add(servedPath(part.url, p.manifest));
}
for (const f of files) {
  if ((f.path.startsWith("runtime/chunks/") || f.path.startsWith("profiles/")) && !referenced.has(f.path)) {
    refuse(`${f.path} is named by no manifest (a stale chunk or part, or a pack missing from the config)`);
  }
}
if (refusals.length) {
  console.error(`release: REFUSED — ${refusals.length} problem(s):\n  ${refusals.join("\n  ")}`);
  process.exit(1);
}
for (const f of files) f.sha256 = await sha256File(path.join(dir, f.path));

const record = canonicalRelease({
  schema: RELEASE_SCHEMA,
  id,
  lean: { version: runtime.leanVersion, upstreamTag: config.upstreamTag },
  kernel: {
    repo: config.kernelRepo ?? "https://github.com/FawadHa1der/lean4",
    branch: config.kernelBranch ?? "qed64-wasm64",
    commit: config.kernelCommit,
    patch: config.kernelPatch,
  },
  gate: { passed: true, commit: config.gate.commit, wasmSha256: config.gate.wasmSha256, checks: config.gate.checks ?? null },
  runtime: {
    buildId: runtime.buildId,
    manifest: manifestRel,
    target: runtime.target,
    sourceRevision: runtime.sourceRevision,
    files: Object.fromEntries(Object.entries(runtime.files).map(([n, f]) => [n, { bytes: f.bytes, sha256: f.sha256, chunks: f.chunks.length }])),
    bin: binExtras,
  },
  packs,
  native64: config.native64,
  docker: config.docker,
  mathlib: config.mathlib,
  modules: config.modules ?? {},
  hosting: config.hosting ?? null,
  tools: config.tools,
  notes: config.notes ?? [],
  files,
});
const recordProblems = checkReleaseRecord(record);
if (recordProblems.length) {
  console.error(`release: REFUSED — the record would break its own rules:\n  ${recordProblems.join("\n  ")}`);
  process.exit(1);
}
fs.writeFileSync(path.join(dir, "release.json"), serializeRelease(record));
const recordSha = await sha256File(path.join(dir, "release.json"));
fs.writeFileSync(path.join(dir, "SHA256SUMS"), sha256sums([...files, { path: "release.json", sha256: recordSha }]));
console.log(`release ${id}: ${files.length} files, runtime ${runtime.buildId}, ${packs.length} packs → ${path.join(dir, "release.json")} (${record.digest.slice(0, 23)}…)`);
