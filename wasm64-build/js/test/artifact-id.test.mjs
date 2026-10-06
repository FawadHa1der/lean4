import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildIdFromSha256, runtimeBuildId, buildIdOfArtifact, checkRuntimeManifest,
  parsePatchId, comparePatchIds, latestPatchId, sha256Hex, sha256File, isSha256Hex,
} from "../artifact-id.mjs";

const made = [];
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

test("build id is wasm64- + the first 16 hex digits of sha256(lean.wasm)", () => {
  const bytes = Buffer.from("not really wasm");
  const sha = sha256Hex(bytes);
  assert.equal(runtimeBuildId(bytes), `wasm64-${sha.slice(0, 16)}`);
  // the served runtime: sha256 recorded in its manifest
  assert.equal(buildIdFromSha256("3ab1c6a9da03bc29d0b29a81fe03673f2b2341b55f51c893525766b99dde1f17"), "wasm64-3ab1c6a9da03bc29");
});

test("only 64 lowercase hex digits count as a sha256", () => {
  assert.equal(isSha256Hex("a".repeat(64)), true);
  assert.equal(isSha256Hex("A".repeat(64)), false);
  assert.equal(isSha256Hex("a".repeat(63)), false);
  assert.throws(() => buildIdFromSha256("ABC"));
});

test("buildIdOfArtifact and sha256File agree with the in-memory hash", async () => {
  const dir = mkdtemp("l4w-id-");
  fs.mkdirSync(path.join(dir, "bin"));
  const bytes = Buffer.alloc(3 << 20, 7);
  fs.writeFileSync(path.join(dir, "bin", "lean.wasm"), bytes);
  assert.equal(await sha256File(path.join(dir, "bin", "lean.wasm")), sha256Hex(bytes));
  assert.equal(await buildIdOfArtifact(dir), runtimeBuildId(bytes));
  await assert.rejects(buildIdOfArtifact(path.join(dir, "nope")));
});

function manifest(overrides = {}) {
  const sha = "3ab1c6a9da03bc29d0b29a81fe03673f2b2341b55f51c893525766b99dde1f17";
  const js = "b".repeat(64);
  return {
    schema: "org.lean-browser64.runtime/v1", buildId: "wasm64-3ab1c6a9da03bc29", leanVersion: "4.34.0",
    files: {
      "lean.js": { bytes: 10, sha256: js, chunks: [{ url: "chunks/a", bytes: 10, sha256: js }] },
      "lean.wasm": { bytes: 30, sha256: sha, chunks: [{ url: "chunks/b", bytes: 20, sha256: "c".repeat(64) }, { url: "chunks/c", bytes: 10, sha256: "d".repeat(64) }] },
    },
    ...overrides,
  };
}

test("a consistent runtime manifest passes", () => {
  assert.deepEqual(checkRuntimeManifest(manifest()), []);
});

test("the build-id invariant is enforced", () => {
  const p = checkRuntimeManifest(manifest({ buildId: "wasm64-0000000000000000" }));
  assert.ok(p.some((x) => x.includes("is not \"wasm64-\" + files")), p.join("; "));
});

test("uppercase or short digests and chunk-sum mismatches are refused", () => {
  const m = manifest();
  m.files["lean.wasm"].sha256 = m.files["lean.wasm"].sha256.toUpperCase();
  assert.ok(checkRuntimeManifest(m).some((x) => x.includes("lowercase")));
  const m2 = manifest();
  m2.files["lean.js"].bytes = 11;
  assert.ok(checkRuntimeManifest(m2).some((x) => x.includes("chunks sum")));
  assert.ok(checkRuntimeManifest(manifest({ schema: "x" })).some((x) => x.includes("schema")));
});

test("patch ids order by (number, suffix)", () => {
  assert.deepEqual(parsePatchId("0035b"), [35, "b"]);
  assert.ok(comparePatchIds("0034", "0035") < 0);
  assert.ok(comparePatchIds("0035", "0035b") < 0);
  assert.ok(comparePatchIds("0035b", "0035a") > 0);
  assert.ok(comparePatchIds("0036", "0035b") > 0);
  assert.equal(comparePatchIds("0035b", "0035b"), 0);
  assert.throws(() => parsePatchId("35b"));
  assert.throws(() => parsePatchId("0035B"));
});

test("latestPatchId is the newest documented patch (not a build's patch id: that is patchIdOf)", () => {
  const md = "# x\n## 0030 — a\ntext\n## Upstream import: v4.34.0\n## 0034 — b\n## 0035 — c\n## 0035b — d (a8817d01f9)\n";
  assert.equal(latestPatchId(md), "0035b");
  assert.throws(() => latestPatchId("## Notes\n"));
});

test("the fork's own PATCHES.md currently ends at 0035b", () => {
  const md = fs.readFileSync(new URL("../../PATCHES.md", import.meta.url), "utf8");
  assert.ok(comparePatchIds(latestPatchId(md), "0035b") >= 0);
});

test("a commit's patch id is the last PATCHES.md heading whose commit it contains", async () => {
  const { patchHeadings, patchIdOf } = await import("../artifact-id.mjs");
  const md = "## Notes\n## 0030 — a (2d75ec14cf)\n## 0034 — a (df1362243c)\ntext\n## 0035 — b (6b3a491f76)\n## 0035b — c (a8817d01f9)\n";
  assert.deepEqual(patchHeadings(md).map((h) => h.id), ["0030", "0034", "0035", "0035b"]);
  const contains = (set) => (c) => set.includes(c);
  assert.equal(patchIdOf(md, contains(["df1362243c", "6b3a491f76", "a8817d01f9"])), "0035b");
  assert.equal(patchIdOf(md, contains(["df1362243c", "6b3a491f76"])), "0035", "the code commit of 0035, before 0035b");
  assert.throws(() => patchIdOf(md, contains([])), /no '## NNNN … \(<commit>\)' heading/);
  // a heading that names no commit (or two) is an error, never a silent fallback to an older id
  assert.throws(() => patchIdOf(md + "## 0036 — d\n", contains(["a8817d01f9"])), /0036 name no single/);
  assert.throws(() => patchIdOf(md + "## 0036 — d (aaaaaaa, bbbbbbb)\n", contains(["a8817d01f9"])), /0036 name no single/);
});

test("the served runtime's commit a8817d01f9 is patch 0035b, read from PATCHES.md at the line's tip", { skip: !hasHistory() && "no git history (shallow CI checkout)" }, async () => {
  const { patchIdOf } = await import("../artifact-id.mjs");
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const git = (...a) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" });
  const md = fs.readFileSync(path.join(repo, "wasm64-build", "PATCHES.md"), "utf8");
  const inside = (C) => (c) => git("merge-base", "--is-ancestor", c, C).status === 0;
  assert.equal(patchIdOf(md, inside("a8817d01f9")), "0035b");
  assert.equal(patchIdOf(md, inside("8d91aadcda")), "0033", "the v4.34.0 import build carries 0030-0033");
});
function hasHistory() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  return spawnSync("git", ["-C", repo, "cat-file", "-e", "a8817d01f9^{commit}"]).status === 0;
}
