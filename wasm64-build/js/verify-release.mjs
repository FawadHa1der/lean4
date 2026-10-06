#!/usr/bin/env node
// Verify a lean4-wasm64 release directory (served layout, formats/release.md):
// recompute every digest a consumer trusts, and check the pairing rules.
//
//   verify-release.mjs --release <dir> [--deep] [--skip-packs] [--json <out>]
//
//   release.json  checkReleaseRecord: schema, canonical keys, self-digest, the id rule, the gate
//                 binding, safe paths, every named path one of files[]
//   SHA256SUMS    every file present with that digest; every file listed; same set as release.json files[]
//   runtime       runtime/v1 structure + the build-id rule, every chunk, both whole-file digests,
//                 the build id RECOMPUTED from lean.wasm's bytes, the per-build manifest copy,
//                 gate.wasmSha256 === lean.wasm's sha256
//   packs         manifest format + own digest, packs[] fields = the manifest's, part URLs under
//                 /profiles/, every transport part + the transport digest, streamed inflate → raw
//                 length + digest, WORKERFS ranges in bounds and exactly one per artifact, pack
//                 lean.version === runtime leanVersion; --deep: every artifact's digest, hashed as it streams past
//
// Streams everything: the essential pack is 3.5 GB raw and is never held in memory.
// Exit 0 = RELEASE VERIFIED, 1 = a check failed, 2 = usage.
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { applyCliContract } from "./cli-args.mjs";
import {
  RELEASE_SCHEMA, ARTIFACT_MANIFEST_FORMAT, checkRuntimeManifest, buildIdFromSha256,
  isSha256Hex, sha256File,
} from "./artifact-id.mjs";
import { CHUNK_URL, PART_URL, checkReleaseRecord, serializeRelease, servedPath, sha256sums } from "./release-record.mjs";

applyCliContract({
  tool: "verify-release",
  usage: "verify-release.mjs --release <dir> [--deep] [--skip-packs] [--json <out>]",
  flags: { release: 1, deep: 0, "skip-packs": 0, json: 1 },
  required: [["release"]],
  passthrough: null,
  help: [
    "usage: verify-release.mjs --release <dir> [--deep] [--skip-packs] [--json <out>]",
    "Recompute every digest of a lean4-wasm64 release directory and check its pairing rules.",
    "run as: lean4-wasm64 verify   (or: node verify-release.mjs)",
    "",
    "flags:",
    "  --release <dir>   the release directory (served layout: release.json at its root) [required]",
    "  --deep            also verify every per-artifact digest inside each pack (streams the raw packs)",
    "  --skip-packs      runtime and records only (fast)",
    "  --json <out>      also write the check results as JSON",
    "  -h, --help        print this help and exit 0",
    "",
    "exit codes: 0 verified, 1 a check failed, 2 usage",
  ].join("\n"),
});
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const dir = path.resolve(arg("release"));
const deep = flag("deep");

const results = [];
const check = (ok, label) => {
  results.push({ ok: !!ok, label });
  console.log(`${ok ? " ok " : "FAIL"}  ${label}`);
};
const strip = (d) => (typeof d === "string" && d.startsWith("sha256:") ? d.slice(7) : d);
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// ---------- release.json ----------
const recordPath = path.join(dir, "release.json");
if (!fs.existsSync(recordPath)) { console.error(`verify-release: ${recordPath} not found`); process.exit(1); }
const record = readJson(recordPath);
check(record.schema === RELEASE_SCHEMA, `release.json schema ${record.schema}`);
check(fs.readFileSync(recordPath, "utf8") === serializeRelease(record), "release.json is in canonical form (JSON.stringify(record, null, 2) + newline)");
const recordProblems = checkReleaseRecord(record);
check(recordProblems.length === 0, `release.json: id ${record.id}, kernel ${String(record.kernel?.commit).slice(0, 10)} patch ${record.kernel?.patch}, digest ${String(record.digest).slice(0, 23)}… — structure, id rule, gate binding, paths${recordProblems.length ? ` — ${recordProblems.join("; ")}` : ""}`);
if (recordProblems.length) {
  // a malformed record cannot be walked safely: report it, check nothing it names (early, so process.exit is safe)
  if (arg("json")) fs.writeFileSync(path.resolve(arg("json")), JSON.stringify({ release: record.id, deep, failures: results.filter((r) => !r.ok).length, results }, null, 2));
  console.log(`\nRELEASE FAILED (malformed release.json) ${record.id}`);
  process.exit(1);
}

// ---------- SHA256SUMS ↔ files[] ↔ disk ----------
const sumsPath = path.join(dir, "SHA256SUMS");
const sums = new Map();
if (fs.existsSync(sumsPath)) {
  for (const line of fs.readFileSync(sumsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) { check(false, `SHA256SUMS line malformed: ${line.slice(0, 80)}`); continue; }
    if (sums.has(m[2])) check(false, `SHA256SUMS lists ${m[2]} twice`);
    sums.set(m[2], m[1]);
  }
} else check(false, "SHA256SUMS present");
const listed = new Map((record.files ?? []).map((f) => [f.path, f]));
const onDisk = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else onDisk.push(path.relative(dir, p).split(path.sep).join("/"));
  }
})(dir);
const expectedOnDisk = new Set([...listed.keys(), "release.json", "SHA256SUMS"]);
// strict: anything else here would be uploaded with the release by the publish commands
const unlisted = onDisk.filter((p) => !expectedOnDisk.has(p));
const absent = [...listed.keys()].filter((p) => !fs.existsSync(path.join(dir, p)));
check(unlisted.length === 0, `every file is listed in release.json${unlisted.length ? ` — unlisted: ${unlisted.slice(0, 5).join(", ")}` : ""}`);
check(absent.length === 0, `every listed file is present${absent.length ? ` — missing: ${absent.slice(0, 5).join(", ")}` : ""}`);
// the whole file must be the canonical text (sorted, one line per file, no blanks): what `sha256sum --strict -c` accepts
if (fs.existsSync(sumsPath)) {
  const canonical = sha256sums([...(record.files ?? []), { path: "release.json", sha256: await sha256File(recordPath) }]);
  check(fs.readFileSync(sumsPath, "utf8") === canonical, "SHA256SUMS is exactly the canonical text for files[] + release.json");
}
const notRegular = [...listed.keys()].filter((p) => fs.existsSync(path.join(dir, p)) && !fs.lstatSync(path.join(dir, p)).isFile());
check(notRegular.length === 0, `every listed file is a regular file (a symlink is never uploaded)${notRegular.length ? ` — not: ${notRegular.slice(0, 5).join(", ")}` : ""}`);
const sumsMismatch = [...listed.values()].filter((f) => sums.get(f.path) !== f.sha256).map((f) => f.path);
check(sumsMismatch.length === 0 && sums.get("release.json") !== undefined && sums.size === listed.size + 1,
  `SHA256SUMS = release.json files[] + release.json${sumsMismatch.length ? ` — differ: ${sumsMismatch.slice(0, 5).join(", ")}` : ""}`);
let bad = [];
for (const [p, f] of listed) {
  const file = path.join(dir, p);
  if (!fs.existsSync(file)) continue;
  const st = fs.statSync(file);
  if (st.size !== f.bytes) { bad.push(`${p} (size)`); continue; }
  if ((await sha256File(file)) !== f.sha256) bad.push(p);
}
check(bad.length === 0, `${listed.size} files match their sha256 and size${bad.length ? ` — bad: ${bad.slice(0, 5).join(", ")}` : ""}`);
if (sums.has("release.json")) check(sums.get("release.json") === (await sha256File(recordPath)), "SHA256SUMS digest of release.json");

// ---------- runtime ----------
const rt = record.runtime ?? {};
const manifestPath = path.join(dir, servedPath(rt.manifest ?? "runtime/runtime-manifest.json"));
let runtime = null;
if (!fs.existsSync(manifestPath)) check(false, `runtime manifest ${rt.manifest} present`);
else {
  runtime = readJson(manifestPath);
  const problems = checkRuntimeManifest(runtime);
  check(problems.length === 0, `runtime manifest is runtime/v1 and obeys the build-id rule${problems.length ? ` — ${problems.join("; ")}` : ""}`);
  check(runtime.buildId === rt.buildId && runtime.leanVersion === record.lean?.version
    && runtime.target === rt.target && runtime.sourceRevision === rt.sourceRevision,
    `release.json runtime ${rt.buildId} / Lean ${record.lean?.version} / target / sourceRevision = the manifest's`);
  for (const [name, file] of Object.entries(runtime.files ?? {})) {
    const recorded = rt.files?.[name];
    check(recorded && recorded.bytes === file.bytes && recorded.sha256 === file.sha256 && recorded.chunks === file.chunks?.length,
      `${name}: release.json runtime.files = the manifest's (${file.bytes} bytes, ${file.chunks?.length} chunks)`);
    const badUrls = (file.chunks ?? []).filter((c) => !CHUNK_URL.test(c.url ?? "")).map((c) => c.url);
    check(badUrls.length === 0, `${name}: chunk URLs are /runtime/chunks/<name>${badUrls.length ? ` — not: ${badUrls.slice(0, 3).join(", ")}` : ""}`);
    const whole = createHash("sha256");
    let bytes = 0;
    let chunksOk = true;
    for (const c of file.chunks ?? []) {
      // chunk URLs are site-absolute (/runtime/chunks/…): resolve them inside the release
      const p = path.join(dir, servedPath(c.url, rt.manifest));
      if (!fs.existsSync(p)) { chunksOk = false; continue; }
      const data = fs.readFileSync(p);
      if (data.length !== c.bytes || sha256(data) !== c.sha256) chunksOk = false;
      whole.update(data);
      bytes += data.length;
    }
    const wholeHex = whole.digest("hex");
    check(chunksOk, `${name}: ${file.chunks?.length ?? 0} chunks`);
    check(bytes === file.bytes && wholeHex === file.sha256, `${name}: whole-file digest`);
    if (name === "lean.wasm") {
      check(buildIdFromSha256(wholeHex) === runtime.buildId, `build id RECOMPUTED from lean.wasm = ${runtime.buildId}`);
      check(record.gate?.passed === true && record.gate?.wasmSha256 === wholeHex, "gate passed on exactly this lean.wasm");
    }
  }
  const perBuild = path.join(path.dirname(manifestPath), `runtime-manifest.${runtime.buildId}.json`);
  check(fs.existsSync(perBuild) && fs.readFileSync(perBuild).equals(fs.readFileSync(manifestPath)),
    `runtime-manifest.${runtime.buildId}.json is a byte copy of runtime-manifest.json`);
  for (const extra of rt.bin ?? []) {
    const p = path.join(dir, servedPath(extra.path));
    check(fs.existsSync(p) && isSha256Hex(extra.sha256) && (await sha256File(p)) === extra.sha256, `runtime bin/${extra.name}`);
  }
}

// ---------- packs ----------
async function verifyPack(entry) {
  const mpath = path.join(dir, servedPath(entry.manifest));
  if (!fs.existsSync(mpath)) { check(false, `${entry.id}: manifest ${entry.manifest} present`); return; }
  const manifest = readJson(mpath);
  const content = manifest.content ?? {};
  const pack = content.pack ?? {};
  check(manifest.format === ARTIFACT_MANIFEST_FORMAT && manifest.version === 1, `${entry.id}: ${manifest.format} v${manifest.version}`);
  check(content.lean?.version === runtime?.leanVersion,
    `${entry.id}: packed for Lean ${content.lean?.version}, runtime is Lean ${runtime?.leanVersion} (pairing rule)`);
  check(manifest.digest === `sha256:${sha256(Buffer.from(JSON.stringify(content)))}`, `${entry.id}: manifest digest = sha256 of its content`);
  check(Object.keys(content.modules ?? {}).length === entry.modules, `${entry.id}: ${entry.modules} modules as recorded`);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check(strip(pack.digest) === entry.rawSha256 && pack.byteLength === entry.rawBytes && content.release === entry.release
    && same(content.roots ?? [], entry.roots ?? []) && content.lean?.gitRevision === entry.lean?.gitRevision,
    `${entry.id}: release.json rawSha256/rawBytes/release/roots/gitRevision = the manifest's`);
  const parts = pack.transport?.parts ?? [];
  const badParts = parts.filter((q) => !PART_URL.test(q.url ?? "")).map((q) => q.url);
  check(pack.transport?.encoding === "gzip" && parts.length > 0 && badParts.length === 0
    && pack.transport.byteLength === parts.reduce((n, q) => n + q.byteLength, 0),
    `${entry.id}: gzip transport, ${parts.length} parts under /profiles/, lengths sum to ${pack.transport?.byteLength}${badParts.length ? ` — bad URLs: ${badParts.slice(0, 3).join(", ")}` : ""}`);
  if (flag("skip-packs")) return;

  const files = [...(content.workerfs?.metadata?.files ?? [])].sort((a, b) => a.start - b.start);
  const inBounds = files.every((f, i) => Number.isSafeInteger(f.start) && Number.isSafeInteger(f.end) && f.start >= 0 && f.end >= f.start
    && f.end <= pack.byteLength && (i === 0 || f.start >= files[i - 1].end));
  check(inBounds, `${entry.id}: ${files.length} WORKERFS ranges in bounds, none overlapping`);
  const expect = new Map();
  const claimedTwice = [];
  for (const mod of Object.values(content.modules ?? {})) {
    for (const ref of Object.values(mod.artifacts ?? {})) {
      if (expect.has(`/${ref.filename}`)) claimedTwice.push(ref.filename);
      expect.set(`/${ref.filename}`, ref);
    }
  }
  check(claimedTwice.length === 0, `${entry.id}: no file is claimed by two artifacts${claimedTwice.length ? ` — ${claimedTwice.slice(0, 3).join(", ")}` : ""}`);
  // every artifact is mounted exactly once, and nothing else is
  const seenRange = new Map();
  for (const f of files) seenRange.set(f.filename, (seenRange.get(f.filename) ?? 0) + 1);
  const unmounted = [...expect.keys()].filter((n) => seenRange.get(n) !== 1);
  const foreign = [...seenRange.keys()].filter((n) => !expect.has(n));
  check(unmounted.length === 0 && foreign.length === 0 && files.length === expect.size,
    `${entry.id}: each of ${expect.size} artifacts has exactly one WORKERFS range${unmounted.length || foreign.length ? ` — ${[...unmounted, ...foreign].slice(0, 3).join(", ")}` : ""}`);

  const raw = createHash("sha256");
  let pos = 0;
  let k = 0;
  let current = null;
  let artifactsOk = true;
  let artifactsChecked = 0;
  const gunzip = createGunzip();
  gunzip.on("data", (d) => {
    raw.update(d);
    if (deep) {
      const end = pos + d.length;
      while (k < files.length) {
        const f = files[k];
        if (f.start >= end) break;
        if (!current) current = { f, h: createHash("sha256"), n: 0 };
        const from = Math.max(f.start, pos);
        const to = Math.min(f.end, end);
        if (to > from) { current.h.update(d.subarray(from - pos, to - pos)); current.n += to - from; }
        if (f.end <= end) {
          const ref = expect.get(f.filename);
          if (ref) {
            artifactsChecked += 1;
            if (current.n !== ref.byteLength || current.h.digest("hex") !== strip(ref.digest)) {
              artifactsOk = false;
              console.log(`FAIL  ${entry.id}: artifact ${f.filename}`);
            }
          }
          current = null;
          k += 1;
        } else break;
      }
    }
    pos += d.length;
  });
  let partsOk = true;
  const transport = createHash("sha256");
  const feed = (async function* () {
    for (const part of parts) {
      // site-absolute (/profiles/…) or a bare name beside the manifest: both as a browser resolves them
      const p = path.join(dir, servedPath(part.url, entry.manifest));
      const data = fs.existsSync(p) ? fs.readFileSync(p) : null;
      if (!data || data.length !== part.byteLength || sha256(data) !== strip(part.digest)) {
        partsOk = false;
        throw new Error(`transport part ${part.url} missing or failed verification`);
      }
      transport.update(data);
      yield data;
    }
  })();
  try {
    await pipeline(feed, gunzip);
    check(partsOk && transport.digest("hex") === strip(pack.transport.digest), `${entry.id}: ${parts.length} transport parts and the transport digest`);
    check(pos === pack.byteLength, `${entry.id}: raw pack length ${pack.byteLength}`);
    check(raw.digest("hex") === strip(pack.digest), `${entry.id}: raw pack digest`);
    if (deep) check(artifactsOk && artifactsChecked === expect.size, `${entry.id}: ${artifactsChecked}/${expect.size} artifact digests`);
  } catch (e) {
    check(false, `${entry.id}: ${e.message}`);
  }
}
for (const entry of record.packs ?? []) await verifyPack(entry);

// ---------- nothing stale: every chunk and every profiles/ file is named by a manifest ----------
{
  const referenced = new Set();
  const named = (url, from) => { try { referenced.add(servedPath(url, from)); } catch { /* reported above */ } };
  const rtRel = rt.manifest ?? "runtime/runtime-manifest.json";
  if (runtime) for (const f of Object.values(runtime.files ?? {})) for (const c of f.chunks ?? []) named(c.url, rtRel);
  for (const entry of record.packs ?? []) {
    named(entry.manifest);
    const mp = path.join(dir, servedPath(entry.manifest));
    if (fs.existsSync(mp)) for (const part of readJson(mp).content?.pack?.transport?.parts ?? []) named(part.url, entry.manifest);
  }
  const stray = [...listed.keys()].filter((p) => (p.startsWith("runtime/chunks/") || p.startsWith("profiles/")) && !referenced.has(p));
  check(stray.length === 0, `every runtime chunk and profiles/ file is named by a manifest${stray.length ? ` — stray: ${stray.slice(0, 5).join(", ")}` : ""}`);
}

const failures = results.filter((r) => !r.ok).length;
if (arg("json")) fs.writeFileSync(path.resolve(arg("json")), JSON.stringify({ release: record.id, deep, failures, results }, null, 2));
console.log(failures === 0 ? `\nRELEASE VERIFIED ${record.id}` : `\nRELEASE FAILED (${failures}) ${record.id}`);
// exitCode, not process.exit(): see fetch-release.mjs (Node 26.3 shutdown deadlock after heavy JIT work)
process.exitCode = failures === 0 ? 0 : 1;
