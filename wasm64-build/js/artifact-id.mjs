// Identity rules of the lean4-wasm64 artifacts, in one place (formats/README.md
// is the specification; this is its implementation). Node built-ins only.
//
//   runtime build id   "wasm64-" + sha256(lean.wasm)[0:16]       (lowercase hex)
//   runtime/v1 rule     manifest.buildId === "wasm64-" + files["lean.wasm"].sha256.slice(0, 16),
//                       files["lean.wasm"].sha256 being exactly 64 lowercase hex digits
//   patch id            NNNN + optional lowercase suffix ("0034" < "0035" < "0035b"),
//                       ordered by (number, suffix); the patch id of a kernel commit C is
//                       the last "## NNNN … (<commit>)" heading of wasm64-build/PATCHES.md
//                       (read at the release commit) whose commit C contains (patchIdOf)
//
// Snapshots are binary-paired to a runtime by build id: a snapshot index entry's
// `runtime` must equal the runtime manifest's `buildId`. Packs pair with a
// runtime by Lean version: pack `lean.version` === runtime `leanVersion`. The
// kernel commit is recorded everywhere and compared nowhere.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RUNTIME_MANIFEST_SCHEMA = "org.lean-browser64.runtime/v1";
export const ARTIFACT_MANIFEST_FORMAT = "browser64.artifact-manifest";
export const RELEASE_SCHEMA = "lean4-wasm64.release/v1";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const BUILD_ID = /^wasm64-[0-9a-f]{16}$/;
const PATCH_ID = /^(\d{4})([a-z]?)$/;

export const isSha256Hex = (s) => typeof s === "string" && SHA256_HEX.test(s);
export const isBuildId = (s) => typeof s === "string" && BUILD_ID.test(s);

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** sha256 of a file, streamed (packs are several GiB; Node refuses > 2 GiB in one update). */
export async function sha256File(file) {
  const h = createHash("sha256");
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 8 << 20 })) h.update(chunk);
  return h.digest("hex");
}

export function buildIdFromSha256(sha256) {
  if (!isSha256Hex(sha256)) throw new Error(`not a lowercase sha256 hex digest: ${JSON.stringify(sha256)}`);
  return `wasm64-${sha256.slice(0, 16)}`;
}

/** The runtime build id of lean.wasm bytes. */
export function runtimeBuildId(wasmBytes) {
  return buildIdFromSha256(sha256Hex(wasmBytes));
}

/** The runtime build id of an artifact directory (<dir>/bin/lean.wasm). */
export async function buildIdOfArtifact(dir) {
  const wasm = path.join(dir, "bin", "lean.wasm");
  if (!fs.existsSync(wasm)) throw new Error(`${wasm}: not found (an artifact dir holds bin/lean.js and bin/lean.wasm)`);
  return buildIdFromSha256(await sha256File(wasm));
}

/**
 * Structural check of an org.lean-browser64.runtime/v1 manifest, including the
 * build-id invariant. Pure string checks: it never hashes bytes (verify-release
 * does). Returns a list of problems; empty means valid.
 */
export function checkRuntimeManifest(m) {
  const problems = [];
  if (!m || typeof m !== "object") return ["manifest is not an object"];
  if (m.schema !== RUNTIME_MANIFEST_SCHEMA) problems.push(`schema is ${JSON.stringify(m.schema)}, expected ${RUNTIME_MANIFEST_SCHEMA}`);
  if (!isBuildId(m.buildId)) problems.push(`buildId ${JSON.stringify(m.buildId)} is not wasm64-<16 lowercase hex>`);
  if (typeof m.leanVersion !== "string" || !m.leanVersion) problems.push("leanVersion missing");
  const files = m.files;
  if (!files || typeof files !== "object") return [...problems, "files missing"];
  for (const name of ["lean.js", "lean.wasm"]) {
    const f = files[name];
    if (!f) { problems.push(`files["${name}"] missing`); continue; }
    if (!isSha256Hex(f.sha256)) problems.push(`files["${name}"].sha256 is not 64 lowercase hex digits`);
    if (!Number.isSafeInteger(f.bytes) || f.bytes <= 0) problems.push(`files["${name}"].bytes is not a positive integer`);
    if (!Array.isArray(f.chunks) || f.chunks.length === 0) { problems.push(`files["${name}"].chunks missing`); continue; }
    let total = 0;
    f.chunks.forEach((c, i) => {
      if (!c || typeof c.url !== "string") problems.push(`files["${name}"].chunks[${i}].url missing`);
      if (!isSha256Hex(c?.sha256)) problems.push(`files["${name}"].chunks[${i}].sha256 is not 64 lowercase hex digits`);
      if (!Number.isSafeInteger(c?.bytes) || c.bytes <= 0) problems.push(`files["${name}"].chunks[${i}].bytes invalid`);
      else total += c.bytes;
    });
    if (Number.isSafeInteger(f.bytes) && total !== f.bytes) problems.push(`files["${name}"]: chunks sum to ${total} bytes, file is ${f.bytes}`);
  }
  const wasm = files["lean.wasm"];
  if (wasm && isSha256Hex(wasm.sha256) && isBuildId(m.buildId) && m.buildId !== buildIdFromSha256(wasm.sha256)) {
    problems.push(`buildId ${m.buildId} is not "wasm64-" + files["lean.wasm"].sha256[0:16] (${buildIdFromSha256(wasm.sha256)})`);
  }
  return problems;
}

/** Parse a patch id ("0035", "0035b") into [number, suffix]; throws on anything else. */
export function parsePatchId(id) {
  const m = PATCH_ID.exec(String(id));
  if (!m) throw new Error(`not a patch id (NNNN + optional lowercase letter): ${JSON.stringify(id)}`);
  return [Number(m[1]), m[2]];
}

/** Order patch ids: negative if a < b, 0 if equal, positive if a > b. */
export function comparePatchIds(a, b) {
  const [na, sa] = parsePatchId(a);
  const [nb, sb] = parsePatchId(b);
  if (na !== nb) return na - nb;
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/**
 * The newest patch id PATCHES.md text documents: its last "## NNNN…" heading.
 * Not the patch id of any particular build — a release's kernel.patch comes from
 * patchIdOf, which asks which documented commits the build contains.
 */
export function latestPatchId(patchesMarkdown) {
  let last = null;
  for (const line of String(patchesMarkdown).split("\n")) {
    const m = /^## (\d{4}[a-z]?)\b/.exec(line);
    if (m) last = m[1];
  }
  if (last === null) throw new Error("no '## NNNN' patch heading found");
  return last;
}

/**
 * The patch headings of PATCHES.md, in file order: "## NNNN[x] — title (<7–40 hex>)".
 * `commit` is the one commit the heading's final parenthesis names, or null when it
 * names none (or more than one) — an entry the patch-id rule cannot place.
 */
export function patchHeadings(patchesMarkdown) {
  const out = [];
  for (const line of String(patchesMarkdown).split("\n")) {
    const h = /^## (\d{4}[a-z]?)\b/.exec(line);
    if (!h) continue;
    const c = /\(([0-9a-f]{7,40})\)\s*$/.exec(line);
    out.push({ id: h[1], commit: c ? c[1] : null, line });
  }
  return out;
}

/**
 * The patch id of a kernel commit C (formats/README.md rule 4): the last heading
 * of PATCHES.md whose named commit is C or an ancestor of C. Read PATCHES.md at
 * the release commit (or any commit of the line that already documents C's
 * patch): an entry is often written after its code, so PATCHES.md *at C* can
 * still lack C's own entry. `contains(commit)` answers "C contains commit" (e.g.
 * `git merge-base --is-ancestor <commit> C`). Throws — rather than return an
 * older id — when a heading names no single commit, and when none qualifies.
 */
export function patchIdOf(patchesMarkdown, contains) {
  const headings = patchHeadings(patchesMarkdown);
  const unplaced = headings.filter((h) => !h.commit).map((h) => h.id);
  if (unplaced.length) throw new Error(`PATCHES.md heading(s) ${unplaced.join(", ")} name no single "(<commit>)": the patch id of a build cannot be placed`);
  let found = null;
  for (const h of headings) if (contains(h.commit)) found = h;
  if (!found) throw new Error("no '## NNNN … (<commit>)' heading of PATCHES.md names a commit contained in this kernel commit");
  return found.id;
}
