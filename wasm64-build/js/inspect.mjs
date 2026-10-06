#!/usr/bin/env node
// Inspect and verify a pack against its manifest.
//
// Checks: manifest schema, transport part digests + lengths, gzip inflation to
// the declared raw byte length, raw-pack digest, every WORKERFS range in
// bounds, one range per filename and no two overlapping (the browser loader
// refuses both), and with --deep every per-artifact digest, each artifact
// mapped by exactly one range.
//
// Streams: each part is verified, then fed to the inflater; the raw pack is
// hashed as it streams past and --deep hashes every artifact's range as it
// goes by. The essential pack is 3.5 GB raw: Node refuses a hash update() over
// 2 GiB and gunzipSync cannot produce it, so nothing pack-sized is held.
//
// Usage: node inspect.mjs <manifest.json> [--pack <file>] [--deep]
// (--help; flags: cli-args.mjs)

import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { applyCliContract } from "./cli-args.mjs";

// Flags follow the shared contract (cli-args.mjs): --help/-h exits 0 before any side effect,
// a missing required flag exits 2, an unknown flag is a warning, --flag=value works.
// The contract reads flags only, so the positional manifest becomes --manifest <file> first.
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--pack" || argv[i] === "--manifest") { i += 1; continue; }
    if (!argv[i].startsWith("-")) { process.argv.splice(2 + i, 1, "--manifest", argv[i]); break; }
  }
  const spec = {"tool":"inspect","usage":"inspect.mjs <manifest.json> [--pack <file>] [--deep]","flags":{"manifest":1,"pack":1,"deep":0},"required":[["manifest"]],"passthrough":null,"passthroughRequired":false};
  spec.help = [
    "usage: inspect.mjs <manifest.json> [--pack <file>] [--deep]",
    "Inspect and verify a pack against its manifest: every transport part (byteLength + sha256), the streamed inflate to the raw pack's length and digest, the WORKERFS ranges (in bounds, one per filename, none overlapping); --deep also every artifact's digest.",
    "run as: lean4-wasm64 inspect   (or: node inspect.mjs)",
    "",
    "flags:",
    "  <manifest.json>   a pack manifest (or --manifest <file>); its parts are read from the same directory by basename [required]",
    "  --pack <file>     hash this raw pack file instead of inflating the parts (the parts are still verified)",
    "  --deep            also verify every per-artifact digest; each module artifact must have exactly one WORKERFS range",
    "  -h, --help        print this help and exit 0, before any side effect",
    "",
    "exit codes:",
    "  0  PASS",
    "  1  a check failed (or the manifest is unreadable or not a browser64.artifact-manifest)",
    "  2  usage",
    "",
    "Contract: formats/README.md (lean4-wasm64)",
  ].join("\n");
  applyCliContract(spec);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const manifestPath = arg("manifest", null);
const explicitPack = arg("pack", null);
const deep = process.argv.includes("--deep");

const sha256 = (b) => createHash("sha256").update(b).digest("hex"); // parts only: ≤ 16 MiB each
const strip = (d) => (typeof d === "string" && d.startsWith("sha256:") ? d.slice(7) : d);

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (e) {
  console.error(`FAIL: manifest ${manifestPath}: ${e.message}`);
  process.exit(1);
}
if (manifest.format !== "browser64.artifact-manifest") {
  console.error(`FAIL: unknown manifest format ${manifest.format}`);
  process.exit(1);
}
const content = manifest.content;
const dir = path.dirname(manifestPath);
const files = content.workerfs?.metadata?.files ?? [];
const parts = content.pack.transport?.parts ?? [];
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? " ok " : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
};
// what browser loaders check before using a pack (QED64 profiles.ts): the manifest's own
// digest, the transport encoding, the parts' lengths and the whole transport's digest
check(manifest.digest === `sha256:${sha256(Buffer.from(JSON.stringify(content)))}`, "manifest digest = sha256 of its content");
check(content.pack.transport?.encoding === "gzip", `transport encoding ${content.pack.transport?.encoding}`);
check(parts.reduce((n, q) => n + q.byteLength, 0) === content.pack.transport?.byteLength, `transport parts sum to ${content.pack.transport?.byteLength} bytes`);
const transportHash = createHash("sha256");
const inBounds = (f) => Number.isSafeInteger(f.start) && Number.isSafeInteger(f.end) && f.start >= 0 && f.end >= f.start && f.end <= content.pack.byteLength;
const byFilename = new Map();
for (const f of files) byFilename.set(f.filename, [...(byFilename.get(f.filename) ?? []), f]);

// The raw stream's consumer: the whole-pack hash, and with --deep each
// artifact range hashed as its bytes pass. Only ranges an artifact can be
// judged by are hashed: in bounds, and the only range of their filename.
const artifactFiles = new Set();
for (const mod of Object.values(content.modules ?? {})) for (const ref of Object.values(mod.artifacts ?? {})) artifactFiles.add(`/${ref.filename}`);
const ranges = deep
  ? files.filter((f) => inBounds(f) && artifactFiles.has(f.filename) && byFilename.get(f.filename).length === 1).sort((a, b) => a.start - b.start)
  : [];
const rawHash = createHash("sha256");
const hashed = new Map(); // range → { n, hex }
const active = [];
let pos = 0;
let next = 0;
const settle = (end) => {
  for (let j = 0; j < active.length; ) {
    const a = active[j];
    if (a.f.end <= end) { hashed.set(a.f, { n: a.n, hex: a.h.digest("hex") }); active.splice(j, 1); } else j += 1;
  }
};
function take(d) {
  rawHash.update(d);
  const end = pos + d.length;
  while (next < ranges.length && ranges[next].start < end) active.push({ f: ranges[next++], h: createHash("sha256"), n: 0 });
  for (const a of active) {
    const from = Math.max(a.f.start, pos);
    const to = Math.min(a.f.end, end);
    if (to > from) { a.h.update(d.subarray(from - pos, to - pos)); a.n += to - from; }
  }
  settle(end);
  pos = end;
}
const sink = async (source) => { for await (const d of source) take(d); };

// 1. Transport parts: each verified before it is fed on
let partsOk = true;
let cursor = 0;
function verifyPart(part) {
  const file = path.join(dir, path.basename(new URL(part.url, "https://x/").pathname));
  if (!fs.existsSync(file)) {
    check(false, `transport part present: ${part.url}`);
    partsOk = false;
    return null;
  }
  // never read a file that is not the part's size: a part is ≤ 16 MiB, a wrong file can be anything
  const size = fs.statSync(file).size;
  let bytes = null;
  if (size === part.byteLength) {
    try { bytes = fs.readFileSync(file); } catch { /* reported as a failed part */ }
  }
  const ok = bytes !== null && sha256(bytes) === strip(part.digest);
  check(ok, `part ${path.basename(file)} (${size} bytes)`);
  if (!ok) partsOk = false;
  if (ok) transportHash.update(bytes); // parts are verified in order
  return ok ? bytes : null;
}
async function* verifiedParts() {
  while (cursor < parts.length) {
    const bytes = verifyPart(parts[cursor++]);
    if (bytes && partsOk) yield bytes; // after a bad part the rest are still checked, never inflated
  }
}

// 2. Inflate (or read --pack) + raw digest, streamed
let streamed = false;
if (explicitPack) {
  while (cursor < parts.length) verifyPart(parts[cursor++]);
  try {
    await pipeline(fs.createReadStream(explicitPack, { highWaterMark: 1 << 20 }), sink);
    streamed = true;
  } catch (e) {
    check(false, `raw pack reconstructible — ${e.message}`);
  }
} else {
  try {
    await pipeline(verifiedParts(), createGunzip(), sink);
    streamed = partsOk;
  } catch (e) {
    while (cursor < parts.length) verifyPart(parts[cursor++]);
    if (partsOk) check(false, `raw pack inflates — ${e.message}`);
  }
  if (!partsOk) check(false, "raw pack reconstructible");
}
if (partsOk && cursor === parts.length) check(transportHash.digest("hex") === strip(content.pack.transport?.digest ?? ""), "transport digest");
if (streamed) {
  while (next < ranges.length && ranges[next].start <= pos) active.push({ f: ranges[next++], h: createHash("sha256"), n: 0 });
  settle(pos); // zero-length ranges at the very end start in no chunk
  check(pos === content.pack.byteLength, `raw pack byteLength = ${content.pack.byteLength}${pos === content.pack.byteLength ? "" : ` (got ${pos})`}`);
  check(rawHash.digest("hex") === strip(content.pack.digest), `raw pack digest = ${content.pack.digest.slice(0, 23)}…`);
}

// 3. WORKERFS ranges: in bounds, one per filename, none overlapping
let rangesOk = true;
for (const f of files) {
  if (!inBounds(f)) {
    rangesOk = false;
    check(false, `range ${f.filename}`);
  }
}
for (const [filename, list] of byFilename) {
  if (list.length > 1) {
    rangesOk = false;
    check(false, `range ${filename} listed ${list.length} times`);
  }
}
let prev = null;
for (const f of files.filter((f) => inBounds(f) && f.end > f.start).sort((a, b) => a.start - b.start)) {
  if (prev && f.start < prev.end) {
    rangesOk = false;
    check(false, `range ${f.filename} overlaps ${prev.filename}`);
  }
  if (!prev || f.end > prev.end) prev = f;
}
check(rangesOk, `${files.length} WORKERFS ranges in bounds, one per filename, none overlapping`);

// 4. Per-artifact digests (deep): every module artifact by exactly one range of its own
if (deep && streamed) {
  let deepOk = true;
  let checked = 0;
  let total = 0;
  const claimed = new Map();
  for (const mod of Object.values(content.modules ?? {})) {
    for (const ref of Object.values(mod.artifacts ?? {})) claimed.set(`/${ref.filename}`, (claimed.get(`/${ref.filename}`) ?? 0) + 1);
  }
  for (const [name, mod] of Object.entries(content.modules ?? {})) {
    for (const [facet, ref] of Object.entries(mod.artifacts ?? {})) {
      total += 1;
      const filename = `/${ref.filename}`;
      const list = byFilename.get(filename) ?? [];
      const fail = (why) => { deepOk = false; check(false, `artifact ${name}.${facet}${why ? ` — ${why}` : ""}`); };
      if (list.length !== 1) { fail(list.length ? `${list.length} WORKERFS ranges for ${filename}` : `no WORKERFS range for ${filename}`); continue; }
      if (claimed.get(filename) > 1) { fail(`${filename} is claimed by ${claimed.get(filename)} artifacts`); continue; }
      const got = hashed.get(list[0]);
      if (!got) { fail(inBounds(list[0]) ? `range of ${filename} ends past the raw pack` : `range of ${filename} out of bounds`); continue; }
      checked += 1;
      if (got.n !== ref.byteLength || got.hex !== strip(ref.digest)) fail("");
    }
  }
  check(deepOk, `${checked === total ? checked : `${checked}/${total}`} artifact digests verified`);
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
// exitCode, not process.exit(): see fetch-release.mjs (shutdown deadlock after heavy JIT work)
process.exitCode = failures === 0 ? 0 : 1;
