#!/usr/bin/env node
// Reconstruct an on-disk olean tree from a profile's verified transport parts.
//
// Streams the gzip parts (verifying each SHA-256), inflates to the raw pack in
// memory, then writes every WORKERFS entry as a real file. Used by the
// snapshot-baking pipeline, which needs Lean's library as a filesystem.
//
// Usage: node unpack.mjs --manifest <file> --out <dir> [--slim]
// (--help; flags: cli-args.mjs)
//
// --slim leaves out the *.olean.private facets: the slim tree QED64's bakes
// run on (its bump-chain did rsync --exclude='*.olean.private'). A bake on a
// full tree gives a ~2.5x snapshot whose overlays do not fit the stock ones.

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { applyCliContract } from "./cli-args.mjs";

// Flags follow the shared contract (cli-args.mjs): --help/-h exits 0 before any side effect,
// a missing required flag exits 2, an unknown flag is a warning, --flag=value works.
{
  const spec = {"tool":"unpack","usage":"unpack.mjs --manifest <file> --out <dir> [--slim]","flags":{"manifest":1,"out":1,"slim":0},"required":[["manifest"],["out"]],"passthrough":null,"passthroughRequired":false};
  spec.help = [
    "usage: unpack.mjs --manifest <file> --out <dir> [--slim]",
    "Reconstruct an on-disk olean tree from a profile's verified transport parts (each part and the raw pack sha256-checked), for the Node-side bakes.",
    "run as: lean4-wasm64 unpack   (or: node unpack.mjs)",
    "",
    "flags:",
    "  --manifest <file>  a profile manifest; its parts are read from the same directory by basename [required]",
    "  --out <dir>        the tree to write (files are added or overwritten, never deleted) [required]",
    "  --slim             do not write *.olean.private facets: the slim tree QED64 bakes on (every part and the raw pack are still verified; a private facet already in --out stays, so use a fresh dir)",
    "  -h, --help         print this help and exit 0, before any side effect",
    "",
    "exit codes:",
    "  0  unpacked",
    "  1  a part, the raw pack or a path failed verification (or the manifest is unreadable)",
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
const manifestPath = path.resolve(arg("manifest", ""));
const outDir = path.resolve(arg("out", ""));
const slim = process.argv.includes("--slim");
if (!manifestPath || !outDir) {
  console.error("usage: unpack.mjs --manifest <file> --out <dir>");
  process.exit(2);
}
const sha256 = (b) => {
  const h = createHash("sha256");
  const STEP = 1 << 30;
  for (let at = 0; at < b.length; at += STEP) h.update(b.subarray(at, Math.min(at + STEP, b.length)));
  return h.digest("hex");
};
const strip = (d) => (d.startsWith("sha256:") ? d.slice(7) : d);

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const { pack, workerfs, release } = manifest.content;
const dir = path.dirname(manifestPath);

const pieces = [];
for (const part of pack.transport.parts) {
  const file = path.join(dir, path.basename(new URL(part.url, "https://x/").pathname));
  const bytes = fs.readFileSync(file);
  if (bytes.length !== part.byteLength || sha256(bytes) !== strip(part.digest)) {
    console.error(`FAIL: transport part ${part.url} failed verification`);
    process.exit(1);
  }
  pieces.push(bytes);
}
const raw = gunzipSync(Buffer.concat(pieces));
if (raw.length !== pack.byteLength || sha256(raw) !== strip(pack.digest)) {
  console.error("FAIL: raw pack failed verification");
  process.exit(1);
}

let files = 0;
let bytes = 0;
let skipped = 0;
for (const entry of workerfs.metadata.files) {
  const rel = entry.filename.replace(/^\//, "");
  const target = path.join(outDir, rel);
  if (!target.startsWith(outDir + path.sep)) {
    console.error(`FAIL: path escape in ${entry.filename}`);
    process.exit(1);
  }
  if (slim && entry.filename.endsWith(".olean.private")) { skipped += 1; continue; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, raw.subarray(entry.start, entry.end));
  files += 1;
  bytes += entry.end - entry.start;
}
console.log(`${release}: unpacked ${files} files, ${(bytes / 1e9).toFixed(2)} GB → ${outDir}${slim ? ` (--slim: ${skipped} *.olean.private left out)` : ""}`);
