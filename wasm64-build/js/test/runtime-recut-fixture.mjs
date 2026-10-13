// A runtime release by reference synthesized from a committed first cut, as a record only (no
// bytes): the patch 0040 build lean-v4.34.0-64d6ebb of lean-v4.34.0-e1a79c1 (formats/release.md,
// "Release by reference"). Its own runtime/ (one lean.js chunk, seven lean.wasm chunks, the two
// manifests, bin/leanmake), its own lean-lib (its manifest and parts, the entry bound to its kernel
// and build id: S6) and tools; every other file and field the base's. Not a test file: the tests
// that need the record import it (runtime-recut, stage-by-reference, publish-release).
import { createHash } from "node:crypto";
import { buildIdFromSha256 } from "../artifact-id.mjs";
import { canonicalRelease, isOwnPath } from "../release-record.mjs";

const h = (s) => createHash("sha256").update(s).digest("hex");
/** The 0040 kernel commit and a lean.wasm sha256 whose build id is the 0040 build's. */
export const K0040 = "64d6ebb7b4f587e2df014106b2707b54846f6433";
export const WASM0040 = `086ef19b1135d43b${h("lean.wasm of the 0040 build").slice(16)}`;
const byPath = (x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0);

/**
 * The runtime release by reference of `base` built at `kernel` (lean.wasm `wasmSha256`, patch
 * `patch`): lean-<tag>-<kernel7>, base pinned, gate bound, tools <version>-<kernel7>. `edit` sees
 * the fields before they are signed.
 */
export function runtimeRecutOf(base, { edit = (x) => x, kernel = K0040, wasmSha256 = WASM0040, patch = "0040" } = {}) {
  const { digest: _d, ...rest } = structuredClone(base);
  const k7 = kernel.slice(0, 7);
  const id = `lean-${base.lean.upstreamTag}-${k7}`;
  const buildId = buildIdFromSha256(wasmSha256);
  const version = `${base.lean.version}-${k7}`;
  const tgz = `tools/${base.tools.package}-${version}.tgz`;
  const js = { bytes: 120_000, sha256: h(`lean.js of ${kernel}`), chunks: 1 };
  const wasm = { bytes: 110_000_000, sha256: wasmSha256, chunks: 7 };
  const chunk = (n, f, i, bytes) => ({ path: `runtime/chunks/${n}.${h(`${n} ${f.sha256} ${i}`).slice(0, 20)}.part-${String(i).padStart(3, "0")}`, bytes, sha256: h(`${n} chunk ${i} of ${f.sha256}`) });
  const manifest = { bytes: 1900, sha256: h(`runtime manifest of ${buildId}`) };
  const leanmake = { path: "runtime/bin/leanmake", bytes: 839, sha256: h(`leanmake of ${kernel}`) };
  const runtimeFiles = [
    chunk("lean.js", js, 0, js.bytes),
    ...Array.from({ length: 7 }, (_, i) => chunk("lean.wasm", wasm, i, i < 6 ? 16_777_216 : wasm.bytes - 6 * 16_777_216)),
    { path: "runtime/runtime-manifest.json", ...manifest }, { path: `runtime/runtime-manifest.${buildId}.json`, ...manifest }, leanmake,
  ];
  const libFiles = [{ path: "profiles/lean-lib.manifest.json", bytes: 5_900_000, sha256: h(`lean-lib manifest of ${kernel}`) },
    ...Array.from({ length: 35 }, (_, i) => ({ path: `profiles/lean-lib.pack.gzip.${h(`lean-lib part ${i} of ${kernel}`).slice(0, 20)}.part-${String(i).padStart(3, "0")}`, bytes: 16_777_216, sha256: h(`lean-lib part ${i} of ${kernel}`) }))];
  const tools = { path: tgz, bytes: 77_000, sha256: h(`tools ${version}`) };
  const probe = { id, base: { id: base.id } };
  const files = [...base.files.filter((f) => !isOwnPath(probe, f.path)), ...runtimeFiles, ...libFiles, tools].sort(byPath);
  const lib = (p) => ({ ...p, release: `lean-lib-${base.lean.version}-${buildId}`, rawBytes: 2_100_000_000, rawSha256: h(`lean-lib raw of ${kernel}`),
    lean: { version: base.lean.version, compiler: kernel, gitRevision: kernel.slice(0, 12) } });
  return canonicalRelease(edit({
    ...rest, id, base: { id: base.id, digest: base.digest },
    kernel: { ...base.kernel, commit: kernel, patch },
    gate: { passed: true, commit: kernel, wasmSha256, checks: 56 },
    runtime: { ...base.runtime, buildId, sourceRevision: `qed64-wasm64@${kernel.slice(0, 10)} (upstream ${base.lean.upstreamTag})`,
      files: { "lean.js": js, "lean.wasm": wasm }, bin: [{ name: "leanmake", ...leanmake }] },
    packs: base.packs.map((p) => (p.id === "lean-lib" ? lib(p) : p)),
    tools: { ...base.tools, version, tgz, commit: "b".repeat(40) },
    notes: ["the runtime release's own note", `Notes of ${base.id} (the base, ${base.digest}) follow verbatim.`, ...(base.notes ?? [])],
    files,
  }));
}
