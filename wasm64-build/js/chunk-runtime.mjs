#!/usr/bin/env node
// Chunk a built lean.js + lean.wasm pair into the served runtime layout:
// ≤16 MiB sha256-addressed parts under <out>/chunks, plus runtime-manifest.json
// (org.lean-browser64.runtime/v1, formats/runtime-manifest.md) and the same
// manifest as runtime-manifest.<buildId>.json.
//
//   chunk-runtime.mjs --bin <dir> --out <dir> --lean-version <x.y.z> --revision <string>
//                     [--url-prefix /runtime/chunks/] [--part-bytes 16777216]
//                     [--initial-memory 134217728] [--maximum-memory 17179869184]
//
// Every input is a flag; nothing defaults into a repository. --lean-version is
// what packs pair against (pack lean.version === runtime leanVersion) and has
// no default. --revision is free text recorded as sourceRevision, by convention
// "qed64-wasm64@<kernel commit> (upstream <tag>[, note])". The memory limits
// must match the build's EMSCRIPTEN_INITIAL_MEMORY / EMSCRIPTEN_MAXIMUM_MEMORY
// (docker-wasm64/configure-qed64.sh); the defaults are those values.
//
// Additive: content-addressed chunk names never collide across builds, so an
// existing <out>/chunks is left as it is. Output is byte-identical to the
// chunker QED64 used up to 2026-10 (pipeline/toolchain/chunk-runtime.mjs) for
// the same inputs — the first release was checked against the served bytes.
import fs from "node:fs";
import path from "node:path";
import { buildIdFromSha256, checkRuntimeManifest, sha256Hex, RUNTIME_MANIFEST_SCHEMA } from "./artifact-id.mjs";
import { applyCliContract } from "./cli-args.mjs";

// Flags follow the shared contract (cli-args.mjs): --help/-h exits 0 before any side effect,
// a missing required flag exits 2, an unknown flag is a warning (a typo such as --url-prefx
// would otherwise silently keep the default URLs), --flag=value works.
const USAGE = "usage: chunk-runtime.mjs --bin <dir> --out <dir> --lean-version <x.y.z> --revision <string> [--url-prefix /runtime/chunks/] [--part-bytes n] [--initial-memory n] [--maximum-memory n]";
applyCliContract({
  tool: "chunk-runtime",
  usage: USAGE.slice("usage: ".length),
  flags: { bin: 1, out: 1, "lean-version": 1, revision: 1, "url-prefix": 1, "part-bytes": 1, "initial-memory": 1, "maximum-memory": 1 },
  required: [["bin"], ["out"], ["lean-version"], ["revision"]],
  passthrough: null,
  help: USAGE,
});
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const binDir = path.resolve(arg("bin"));
const outDir = path.resolve(arg("out"));
const leanVersion = arg("lean-version");
const revision = arg("revision");
const urlPrefix = arg("url-prefix", "/runtime/chunks/");
const PART = Number(arg("part-bytes", String(16 * 1024 * 1024)));
const initialBytes = Number(arg("initial-memory", "134217728"));
const maximumBytes = Number(arg("maximum-memory", "17179869184"));
for (const [k, v] of [["part-bytes", PART], ["initial-memory", initialBytes], ["maximum-memory", maximumBytes]]) {
  if (!Number.isSafeInteger(v) || v <= 0) { console.error(`chunk-runtime: --${k} must be a positive integer`); process.exit(2); }
}
if (!urlPrefix.endsWith("/")) { console.error("chunk-runtime: --url-prefix must end with /"); process.exit(2); }

let wasmBytes;
try {
  wasmBytes = fs.readFileSync(path.join(binDir, "lean.wasm"));
} catch (e) {
  console.error(`chunk-runtime: ${e.message}`); process.exit(1);
}
const buildId = buildIdFromSha256(sha256Hex(wasmBytes));
fs.mkdirSync(path.join(outDir, "chunks"), { recursive: true });

function chunkFile(name) {
  const bytes = name === "lean.wasm" ? wasmBytes : fs.readFileSync(path.join(binDir, name));
  const whole = sha256Hex(bytes);
  const chunks = [];
  for (let at = 0; at < bytes.length; at += PART) {
    const piece = bytes.subarray(at, Math.min(at + PART, bytes.length));
    const digest = sha256Hex(piece);
    const file = `${name}.${digest.slice(0, 20)}.part-${String(chunks.length).padStart(3, "0")}`;
    fs.writeFileSync(path.join(outDir, "chunks", file), piece);
    chunks.push({ url: `${urlPrefix}${file}`, bytes: piece.length, sha256: digest });
  }
  console.log(`${name}: ${bytes.length} bytes, ${chunks.length} chunks, sha256:${whole.slice(0, 16)}…`);
  return { bytes: bytes.length, sha256: whole, chunks };
}

// Key order is part of the format (formats/runtime-manifest.md): readers may
// compare manifests byte for byte.
const manifest = {
  schema: RUNTIME_MANIFEST_SCHEMA,
  buildId,
  leanVersion,
  sourceRevision: revision,
  target: "wasm64-unknown-emscripten",
  pointerBits: 64,
  memory: { initialBytes, maximumBytes, shared: true },
  files: {
    "lean.js": chunkFile("lean.js"),
    "lean.wasm": chunkFile("lean.wasm"),
  },
};
const problems = checkRuntimeManifest(manifest);
if (problems.length) { console.error(`chunk-runtime: produced an invalid manifest:\n  ${problems.join("\n  ")}`); process.exit(1); }
const text = JSON.stringify(manifest, null, 2);
fs.writeFileSync(path.join(outDir, "runtime-manifest.json"), text);
fs.writeFileSync(path.join(outDir, `runtime-manifest.${buildId}.json`), text);
console.log(`runtime ${buildId} → ${outDir}`);
