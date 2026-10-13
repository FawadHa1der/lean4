// A runtime release by reference (formats/release.md, "Release by reference"): a first cut of its
// own kernel commit whose base is a first cut of the same tag and another kernel. It owns runtime/,
// profiles/lean-lib.* and tools/; every other file and field is its base's. First the record layer,
// pure, on lean-v4.34.0-64d6ebb synthesized from the committed e1a79c1 (runtime-recut-fixture.mjs):
// the structure rules S2-S6, the equality rules E1-E4 walked as the spec states them, and the older
// readers that fail closed. Then end to end and offline: a small synthetic first cut (chunk → pack
// → release), a runtime release by reference of it written by release.mjs --base from the config
// stage-release.sh writes (recutConfig), then fetch from flat copies and verify.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIdFromSha256 } from "../artifact-id.mjs";
import { byReferenceKind, canonicalRelease, checkRecutBase, checkReleaseRecord, isOwnPath, serializeRelease } from "../release-record.mjs";
import * as r2Reader from "./fixtures/release-record-r2/release-record.mjs";
import * as r3Reader from "./fixtures/release-record-r3/release-record.mjs";
import { K0040, runtimeRecutOf } from "./runtime-recut-fixture.mjs";
import { recutConfig } from "../../stage-by-reference.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");
const releasesDir = path.join(pkg, "..", "releases");
const committed = fs.readdirSync(releasesDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(releasesDir, f), "utf8")));
const E1 = structuredClone(committed.find((r) => r.id === "lean-v4.34.0-e1a79c1"));
const RT = runtimeRecutOf(E1);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const spec = fs.readFileSync(path.join(pkg, "formats", "release.md"), "utf8");
/** The backticked names of the spec line that starts with `lead` (up to its first " (": its parentheticals are prose). */
const specLine = (lead) => {
  const line = new RegExp(`\\n *- ${esc(lead)}: (.*)\\n`).exec(spec)?.[1] ?? "";
  return [...line.split(" (")[0].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
};

// ---------- the record ----------

test("lean-v4.34.0-64d6ebb synthesized from e1a79c1: the runtime kind, both checks pass, 89 shared files, 48 own", () => {
  assert.equal(RT.id, "lean-v4.34.0-64d6ebb");
  assert.equal(byReferenceKind(RT), "runtime");
  assert.deepEqual(checkReleaseRecord(RT), []);
  assert.deepEqual(checkRecutBase(RT, E1), []);
  assert.deepEqual(Object.keys(RT).slice(0, 4), ["schema", "id", "base", "lean"]);
  const shared = RT.files.filter((f) => !isOwnPath(RT, f.path));
  assert.equal(shared.length, 89);
  assert.equal(RT.files.length - shared.length, 48);
  assert.ok(shared.every((f) => !/^(runtime|tools)\//.test(f.path) && !f.path.startsWith("profiles/lean-lib.")));
  assert.equal(RT.runtime.buildId, "wasm64-086ef19b1135d43b");
  assert.deepEqual(RT.packs.find((p) => p.id === "lean-lib").lean, { version: "4.34.0", compiler: K0040, gitRevision: K0040.slice(0, 12) });
});

test("structure (S2-S6): each malformed runtime release by reference is refused by its message, with no other record", () => {
  const tgzOf = (r, version) => { const tgz = `tools/${r.tools.package}-${version}.tgz`; return { ...r, tools: { ...r.tools, version, tgz }, files: r.files.map((f) => (f.path.startsWith("tools/") ? { ...f, path: tgz } : f)).sort((a, b) => (a.path < b.path ? -1 : 1)) }; };
  const lib = (r, edit) => ({ ...r, packs: r.packs.map((p) => (p.id === "lean-lib" ? edit(p) : p)) });
  const cases = [
    ["base.id an -r3", (r) => ({ ...r, base: { ...r.base, id: `${E1.id}-r3` } }), /^base\.id "lean-v4\.34\.0-e1a79c1-r3" is not a first cut of v4\.34\.0 \(lean-v4\.34\.0-<kernel7>\): a release by reference names a first cut of its tag$/],
    ["base.id of another tag", (r) => ({ ...r, base: { ...r.base, id: "lean-v4.33.0-e1a79c1" } }), /^base\.id "lean-v4\.33\.0-e1a79c1" is not a first cut of v4\.34\.0 /],
    ["base.id = id", (r) => ({ ...r, base: { ...r.base, id: r.id } }), /^base\.id is lean-v4\.34\.0-64d6ebb itself: a runtime release by reference names a first cut of another kernel commit$/],
    ["an -r5 id with a base of another kernel", (r) => tgzOf({ ...r, id: `${r.id}-r5` }, "4.34.0-64d6ebb-r5"), /^base\.id lean-v4\.34\.0-e1a79c1 is not lean-v4\.34\.0-64d6ebb: an -rN release by reference is a tools re-cut of its first cut$/],
    ["lean-lib compiled by the base's kernel", (r) => lib(r, (p) => ({ ...p, lean: { ...p.lean, compiler: E1.kernel.commit } })), new RegExp(`^packs\\[lean-lib\\]: lean\\.compiler ${E1.kernel.commit} is not kernel\\.commit ${K0040}: a runtime release by reference's lean-lib is its own build's lib/lean$`)],
    ["lean-lib's gitRevision", (r) => lib(r, (p) => ({ ...p, lean: { ...p.lean, gitRevision: "e1a79c1ce9f8" } })), /^packs\[lean-lib\]: lean\.gitRevision "e1a79c1ce9f8" is not 64d6ebb7b4f5: /],
    ["lean-lib's release naming the base's build id", (r) => lib(r, (p) => ({ ...p, release: E1.packs.find((q) => q.id === "lean-lib").release })), /^packs\[lean-lib\]: release "lean-lib-4\.34\.0-wasm64-f69cca24d0878a58" is not lean-lib-4\.34\.0-wasm64-086ef19b1135d43b: /],
    ["tools.version with an -rN", (r) => tgzOf(r, "4.34.0-64d6ebb-r2"), /^tools\.version "4\.34\.0-64d6ebb-r2" is not 4\.34\.0-64d6ebb: <lean\.version>-<kernel7>\[-rN\], as the id$/],
    ["two tools files", (r) => ({ ...r, files: [...r.files, { path: "tools/extra.tgz", bytes: 1, sha256: "c".repeat(64) }].sort((a, b) => (a.path < b.path ? -1 : 1)) }), /^a release by reference has exactly one file under tools\/, tools\.tgz — got /],
    ["no tools", (r) => { const { tools: _t, ...x } = r; return { ...x, files: r.files.filter((f) => !f.path.startsWith("tools/")) }; }, /^a release by reference carries its own tools: tools missing$/],
  ];
  for (const [label, edit, re] of cases) {
    const p = checkReleaseRecord(runtimeRecutOf(E1, { edit }));
    assert.ok(p.some((q) => re.test(q)), `${label}: ${JSON.stringify(p)}`);
  }
  // all three lean-lib parts at once: one message naming each
  const all = checkReleaseRecord(runtimeRecutOf(E1, { edit: (r) => lib(r, () => E1.packs.find((q) => q.id === "lean-lib")) }));
  assert.equal(all.filter((q) => q.startsWith("packs[lean-lib]: ")).length, 1);
  assert.match(all.find((q) => q.startsWith("packs[lean-lib]: ")), /lean\.compiler .*; lean\.gitRevision .*; release /);
});

test("E2: each shared field of the spec's runtime line, changed alone or dropped and re-signed, is refused by exactly its own name", () => {
  // as formats/release.md states it: the test walks the spec, so a field dropped from the code (or the spec) fails here
  const SHARED = ["schema", "lean", "native64", "docker", "mathlib", "modules", "hosting", "kernel.repo", "kernel.branch", "runtime.target", "packs"];
  assert.deepEqual(specLine("a runtime release by reference"), SHARED, "formats/release.md, equality rule E2 (a runtime release by reference)");
  const edits = {
    schema: (r) => ({ ...r, schema: "lean4-wasm64.release/v2" }),
    lean: (r) => ({ ...r, lean: { ...r.lean, version: "4.34.1" } }),
    native64: (r) => ({ ...r, native64: { ...r.native64, os: "darwin" } }),
    docker: (r) => ({ ...r, docker: { ...r.docker, imageId: `sha256:${"0".repeat(64)}` } }),
    mathlib: (r) => ({ ...r, mathlib: { ...r.mathlib, tag: "v4.34.1" } }),
    modules: (r) => ({ ...r, modules: { ...r.modules, more: "lists/essential-modules.txt" } }),
    hosting: (r) => ({ ...r, hosting: { ...r.hosting, layout: "flat" } }),
    "kernel.repo": (r) => ({ ...r, kernel: { ...r.kernel, repo: "https://github.com/other/lean4" } }),
    "kernel.branch": (r) => ({ ...r, kernel: { ...r.kernel, branch: "other" } }),
    "runtime.target": (r) => ({ ...r, runtime: { ...r.runtime, target: "wasm64-other" } }),
    // a shared pack's entry (lean-core's note), and the pack order
    packs: (r) => ({ ...r, packs: r.packs.map((k) => (k.id === "lean-core" ? { ...k, note: "re-packed" } : k)) }),
  };
  const drops = {
    "kernel.repo": (r) => { const { repo: _x, ...kernel } = r.kernel; return { ...r, kernel }; },
    "kernel.branch": (r) => { const { branch: _x, ...kernel } = r.kernel; return { ...r, kernel }; },
    "runtime.target": (r) => { const { target: _x, ...runtime } = r.runtime; return { ...r, runtime }; },
  };
  assert.deepEqual(Object.keys(edits), SHARED);
  for (const k of SHARED) {
    const why = [`${k} differs from the base's`];
    assert.deepEqual(checkRecutBase(runtimeRecutOf(E1, { edit: edits[k] }), E1), why, `${k} changed`);
    const drop = drops[k] ?? ((r) => { const { [k]: _gone, ...rest } = r; return rest; });
    assert.deepEqual(checkRecutBase(runtimeRecutOf(E1, { edit: drop }), E1), why, `${k} dropped`);
  }
  // the pack order is part of packs; the lean-lib entry is compared by id alone
  assert.deepEqual(checkRecutBase(runtimeRecutOf(E1, { edit: (r) => ({ ...r, packs: [...r.packs].reverse() }) }), E1), ["packs differs from the base's"]);
  assert.deepEqual(checkRecutBase(runtimeRecutOf(E1, { edit: (r) => ({ ...r, packs: r.packs.map((k) => (k.id === "lean-lib" ? { ...k, note: "its own" } : k)) }) }), E1), []);
});

test("may differ: each field of the spec's runtime line, changed (binding rules kept) and re-signed, passes both checks", () => {
  const MAY = ["id", "base", "kernel.commit", "kernel.patch", "gate", "runtime.buildId", "runtime.sourceRevision", "runtime.files", "runtime.bin",
    "packs[lean-lib]", "tools.version", "tools.tgz", "tools.commit", "notes", "files[]", "digest"];
  assert.deepEqual(specLine("in a runtime release by reference"), MAY, "formats/release.md, what a runtime release by reference may change");
  const other = "64d6ebc7b4f587e2df014106b2707b54846f6434"; // another kernel commit: the id, gate, lean-lib and tools follow it
  const otherWasm = `086ef19b1135d43c${"9".repeat(48)}`;
  const leanmake = (r) => { const sha256 = "7".repeat(64); return { ...r, runtime: { ...r.runtime, bin: [{ ...r.runtime.bin[0], sha256 }] }, files: r.files.map((f) => (f.path === "runtime/bin/leanmake" ? { ...f, sha256 } : f)) }; };
  const variants = {
    // id and base: the id follows the kernel commit; base is the pin itself (any other is another base: the E-rules' business)
    id: () => runtimeRecutOf(E1, { kernel: other }),
    base: () => RT,
    "kernel.commit": () => runtimeRecutOf(E1, { kernel: other }),
    "kernel.patch": () => runtimeRecutOf(E1, { patch: "0039b" }),
    gate: () => runtimeRecutOf(E1, { edit: (r) => ({ ...r, gate: { ...r.gate, checks: 57 } }) }),
    "runtime.buildId": () => runtimeRecutOf(E1, { wasmSha256: otherWasm }),
    "runtime.sourceRevision": () => runtimeRecutOf(E1, { edit: (r) => ({ ...r, runtime: { ...r.runtime, sourceRevision: "another build of it" } }) }),
    "runtime.files": () => runtimeRecutOf(E1, { wasmSha256: otherWasm }),
    "runtime.bin": () => runtimeRecutOf(E1, { edit: leanmake }),
    "packs[lean-lib]": () => runtimeRecutOf(E1, { edit: (r) => ({ ...r, packs: r.packs.map((k) => (k.id === "lean-lib" ? { ...k, modules: k.modules + 1, rawBytes: 7 } : k)) }) }),
    "tools.version": () => runtimeRecutOf(E1, { kernel: other }),
    "tools.tgz": () => runtimeRecutOf(E1, { kernel: other }),
    "tools.commit": () => runtimeRecutOf(E1, { edit: (r) => ({ ...r, tools: { ...r.tools, commit: "c".repeat(40) } }) }),
    notes: () => runtimeRecutOf(E1, { edit: (r) => ({ ...r, notes: [] }) }),
    "files[]": () => runtimeRecutOf(E1, { edit: leanmake }),
    digest: () => RT,
  };
  assert.deepEqual(Object.keys(variants), MAY);
  const at = (r, k) => (k === "files[]" ? r.files : k === "packs[lean-lib]" ? r.packs.find((p) => p.id === "lean-lib") : k.split(".").reduce((o, x) => o?.[x], r));
  for (const k of MAY) {
    const r = variants[k]();
    assert.deepEqual(checkReleaseRecord(r), [], `${k}: the record's own rules`);
    assert.deepEqual(checkRecutBase(r, E1), [], `${k}: the equality rules`);
    assert.notEqual(JSON.stringify(at(r, k)), JSON.stringify(at(E1, k)), `${k} differs from the base's`);
  }
});

test("E3/E4: the base's runtime, an earlier patch, another package, the base's tools version, a shared file's bytes, a missing and an extra file are refused", () => {
  const refused = (r, re, label) => { const p = checkRecutBase(r, E1); assert.ok(p.some((q) => re.test(q)), `${label}: ${JSON.stringify(p)}`); };
  // the base's own lean.wasm, re-signed with a gate and lean-lib bound to it: a tools re-cut's job
  const same = runtimeRecutOf(E1, { wasmSha256: E1.gate.wasmSha256 });
  assert.deepEqual(checkReleaseRecord(same), []);
  assert.deepEqual(checkRecutBase(same, E1), [`runtime.buildId ${E1.runtime.buildId} is the base's: a runtime release by reference ships its own runtime (a tools re-cut, -rN, keeps the base's)`]);
  // a later build of the base's line: its patch id never precedes the base's (the base's own is fine: a kernel
  // commit with no PATCHES.md entry of its own); staging and publish check the ancestry with git
  assert.deepEqual(checkRecutBase(runtimeRecutOf(E1, { patch: "0030" }), E1), ["kernel.patch 0030 precedes the base's 0037: a runtime release by reference is a later build of the base's line"]);
  assert.deepEqual(checkRecutBase(runtimeRecutOf(E1, { patch: E1.kernel.patch }), E1), []);
  refused(runtimeRecutOf(E1, { edit: (r) => ({ ...r, tools: { ...r.tools, package: "other" } }) }), /^tools\.package "other" is not the base's "lean4-wasm64"$/, "package");
  refused(runtimeRecutOf(E1, { edit: (r) => ({ ...r, tools: { ...r.tools, version: E1.tools.version } }) }), /^tools\.version 4\.34\.0-e1a79c1 is the base's: a release by reference ships its own tools$/, "version");
  refused(runtimeRecutOf(E1, { edit: (r) => ({ ...r, files: r.files.map((f) => (f.path === "lists/extra-modules.txt" ? { ...f, bytes: f.bytes + 1 } : f)) }) }), /^files\[\]: lists\/extra-modules\.txt is not the base's bytes$/, "bytes");
  refused(runtimeRecutOf(E1, { edit: (r) => ({ ...r, files: r.files.map((f) => (f.path === "lists/extra-modules.txt" ? { ...f, sha256: "d".repeat(64) } : f)) }) }), /is not the base's bytes/, "sha256");
  refused(runtimeRecutOf(E1, { edit: (r) => ({ ...r, files: r.files.filter((f) => f.path !== "lists/extra-modules.txt") }) }), /^files\[\]: the base's lists\/extra-modules\.txt is missing$/, "missing");
  refused(runtimeRecutOf(E1, { edit: (r) => ({ ...r, files: [...r.files, { path: "lists/zz-extra.txt", bytes: 1, sha256: "e".repeat(64) }].sort((a, b) => (a.path < b.path ? -1 : 1)) }) }), /^files\[\]: lists\/zz-extra\.txt is not a file of the base$/, "extra");
});

test("E1: a runtime release by reference is no base — not of a tools re-cut, not of another runtime release", () => {
  const msg = `the base ${RT.id} names a base of its own (${E1.id}): a base names no base of its own`;
  // a tools re-cut of it (-r2)
  const { digest: _d, ...rest } = structuredClone(RT);
  const tgz = "tools/lean4-wasm64-4.34.0-64d6ebb-r2.tgz";
  const recut = canonicalRelease({ ...rest, id: `${RT.id}-r2`, base: { id: RT.id, digest: RT.digest }, tools: { ...RT.tools, version: "4.34.0-64d6ebb-r2", tgz },
    files: RT.files.map((f) => (f.path.startsWith("tools/") ? { ...f, path: tgz, sha256: "f".repeat(64) } : f)).sort((a, b) => (a.path < b.path ? -1 : 1)) });
  assert.equal(byReferenceKind(recut), "tools");
  assert.deepEqual(checkReleaseRecord(recut), []);
  assert.ok(checkRecutBase(recut, RT).includes(msg), JSON.stringify(checkRecutBase(recut, RT)));
  // another runtime release by reference of it
  const next = runtimeRecutOf(RT, { kernel: "64d6ebd7b4f587e2df014106b2707b54846f6435", wasmSha256: "1".repeat(64) });
  assert.equal(byReferenceKind(next), "runtime");
  assert.ok(checkRecutBase(next, RT).includes(msg), JSON.stringify(checkRecutBase(next, RT)));
});

test("older readers fail closed: the r3 reader refuses a runtime-kind base, the r2 reader any base; both accept every record without one", () => {
  const p = r3Reader.checkReleaseRecord(RT);
  assert.ok(p.includes(`base: only a re-cut (lean-<tag>-<kernel7>-rN) names a base, "${RT.id}" is not one`), JSON.stringify(p));
  for (const r of committed) assert.deepEqual(r3Reader.checkReleaseRecord(r), [], `the r3 reader on ${r.id}`);
  assert.ok(r2Reader.checkReleaseRecord(RT).includes("unknown keys: base"));
  // the current reader takes the committed tools re-cut as before
  for (const r of committed) assert.deepEqual(checkReleaseRecord(r), [], r.id);
});

// ---------- end to end: release.mjs --base, fetch, verify ----------

const made = [];
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const run = (script, args) => {
  const r = spawnSync(process.execPath, [path.join(pkg, script), ...args], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
  if (r.error) throw new Error(`${script} ${args.join(" ")}: ${r.error.message}\n${r.stdout}${r.stderr}`);
  return r;
};
const ok = (r, what) => assert.equal(r.status, 0, `${what}:\n${r.stdout}${r.stderr}`);
const KERNEL = "a8817d01f97227b1b04cc7d661b9e396f6ca8f34", K2 = "b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0";
const BASE_ID = "lean-v4.34.0-a8817d0", RT_ID = `lean-v4.34.0-${K2.slice(0, 7)}`;
const TOOLS_VERSION = `4.34.0-${K2.slice(0, 7)}`, TOOLS_TGZ = `lean4-wasm64-${TOOLS_VERSION}.tgz`;
const OWN_LABEL = "runtime/, profiles/lean-lib.* and tools/";

/** A bin dir (lean.js, lean.wasm of `seed`'s bytes) and a lib/lean tree (Init, Init.Prelude, of `fill`). */
function sources(root, name, seed, fill) {
  const bin = path.join(root, name, "bin"), lib = path.join(root, name, "lib");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "lean.js"), Buffer.alloc(2500, seed));
  fs.writeFileSync(path.join(bin, "lean.wasm"), Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7 + seed) % 251)));
  fs.mkdirSync(path.join(lib, "Init"), { recursive: true });
  fs.writeFileSync(path.join(lib, "Init.olean"), Buffer.alloc(300, fill));
  fs.writeFileSync(path.join(lib, "Init", "Prelude.olean"), Buffer.alloc(1200, fill + 1));
  return { bin, lib, wasmSha: sha(fs.readFileSync(path.join(bin, "lean.wasm"))) };
}
const chunk = (bin, rel, kernel) => ok(run("chunk-runtime.mjs", ["--bin", bin, "--out", path.join(rel, "runtime"), "--lean-version", "4.34.0",
  "--revision", `qed64-wasm64@${kernel.slice(0, 10)} (upstream v4.34.0)`, "--part-bytes", "1024"]), "chunk-runtime");
const leanLib = (lib, rel, kernel, wasmSha) => ok(run("pack.mjs", ["--lib", lib, "--id", "lean-lib", "--out", path.join(rel, "profiles"), "--lean-version", "4.34.0",
  "--mount", "/lib/lean", "--revision", kernel.slice(0, 12), "--release", `lean-lib-4.34.0-${buildIdFromSha256(wasmSha)}`, "--roots", "Init",
  "--url-prefix", "/profiles/", "--no-imports"]), "pack lean-lib");
const dropRaw = (rel) => { for (const f of fs.readdirSync(path.join(rel, "profiles"))) if (f.endsWith(".pack")) fs.rmSync(path.join(rel, "profiles", f)); };

let W = null;
/** The world, built once: <root>/served/<BASE_ID> (a first cut) and <root>/served/<RT_ID> (its runtime release by reference). */
function world() {
  if (W) return W;
  const root = mkdtemp("l4w-runtime-recut-");
  // the base: lean-core and lean-lib, native64, lists, tools
  const a = sources(root, "a", 1, 3);
  const base = path.join(root, "served", BASE_ID);
  chunk(a.bin, base, KERNEL);
  fs.mkdirSync(path.join(base, "runtime", "bin"));
  fs.writeFileSync(path.join(base, "runtime", "bin", "leanmake"), "#!/bin/sh\n# the base's\n");
  ok(run("pack.mjs", ["--lib", a.lib, "--id", "lean-core", "--out", path.join(base, "profiles"), "--lean-version", "4.34.0",
    "--revision", KERNEL, "--roots", "Init", "--url-prefix", "/profiles/", "--no-imports"]), "pack lean-core");
  leanLib(a.lib, base, KERNEL, a.wasmSha);
  dropRaw(base);
  fs.mkdirSync(path.join(base, "native64"));
  fs.writeFileSync(path.join(base, "native64", "native64.tar.gz"), "not really a tarball");
  fs.mkdirSync(path.join(base, "lists"));
  fs.writeFileSync(path.join(base, "lists", "essential-modules.txt"), "Init\n");
  fs.writeFileSync(path.join(base, "lists", "essential-selection.json"), "{}\n");
  fs.mkdirSync(path.join(base, "tools"));
  fs.writeFileSync(path.join(base, "tools", "lean4-wasm64-4.34.0-a8817d0.tgz"), "the first cut's tools");
  const config = {
    upstreamTag: "v4.34.0", kernelCommit: KERNEL, kernelPatch: "0035b", leanVersion: "4.34.0",
    gate: { commit: KERNEL, wasmSha256: a.wasmSha, checks: 33 },
    packs: [{ id: "lean-core", compiler: "8d91aadcda8a0b231e47c42d4ff4b9b8360563aa", note: "transport copied from served bytes, not re-packed" }, { id: "lean-lib", compiler: KERNEL }],
    native64: { commit: "857544b439aa51633344d638dacc03d304b9ea96", os: "linux", arch: "aarch64", tar: "native64/native64.tar.gz" },
    docker: { tag: "qed64-toolchain:emsdk-6.0.5", recipeCommit: "974ee228b0c368f1d74f55ed4794ef60c15de4c2" },
    mathlib: { commit: "5ed2965256430c3649e86755f9576b54eca72435", tag: "v4.34.0" },
    modules: { essential: "lists/essential-modules.txt" },
    hosting: { layout: "served", mount: { "/runtime/": "runtime/", "/profiles/": "profiles/" }, spec: "wasm64-build/js/formats/HOSTING.md" },
    tools: { package: "lean4-wasm64", version: "4.34.0-a8817d0", tgz: "tools/lean4-wasm64-4.34.0-a8817d0.tgz" },
    notes: ["the first cut's own note"],
  };
  fs.writeFileSync(path.join(root, "base-config.json"), JSON.stringify(config));
  ok(run("release.mjs", ["--release", base, "--config", path.join(root, "base-config.json")]), "release the base");
  const baseRecord = JSON.parse(fs.readFileSync(path.join(base, "release.json"), "utf8"));
  // the runtime release's own bytes: another runtime and another lib/lean
  const b = sources(root, "b", 9, 5);
  W = { root, base, baseRecord, a, b };
  return W;
}

/** A staged runtime release by reference in a fresh dir: the base's files outside tools/, then its own runtime, lean-lib and tools, and the config. */
function stageRuntime(w, edit = (c) => c) {
  const root = mkdtemp("l4w-runtime-stage-");
  const rel = path.join(root, RT_ID);
  for (const f of w.baseRecord.files.filter((x) => !x.path.startsWith("tools/"))) {
    fs.mkdirSync(path.dirname(path.join(rel, f.path)), { recursive: true });
    fs.copyFileSync(path.join(w.base, f.path), path.join(rel, f.path));
  }
  fs.rmSync(path.join(rel, "runtime"), { recursive: true });
  chunk(w.b.bin, rel, K2);
  fs.mkdirSync(path.join(rel, "runtime", "bin"));
  fs.writeFileSync(path.join(rel, "runtime", "bin", "leanmake"), "#!/bin/sh\n# the 0040 build's\n");
  for (const f of fs.readdirSync(path.join(rel, "profiles"))) if (f.startsWith("lean-lib.")) fs.rmSync(path.join(rel, "profiles", f));
  leanLib(w.b.lib, rel, K2, w.b.wasmSha);
  dropRaw(rel);
  fs.mkdirSync(path.join(rel, "tools"));
  fs.writeFileSync(path.join(rel, "tools", TOOLS_TGZ), "the runtime release's tools");
  const config = edit(recutConfig(w.baseRecord, { id: RT_ID, runtime: { kernelCommit: K2, kernelPatch: "0040", wasmSha256: w.b.wasmSha },
    checks: "4", version: TOOLS_VERSION, tgz: TOOLS_TGZ, commit: "c".repeat(40), notes: ["the runtime release's own note"] }));
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { root, rel, configPath, config };
}
const written = (rel) => ["release.json", "SHA256SUMS"].filter((n) => fs.existsSync(path.join(rel, n)));

let STAGED = null;
/** The runtime release, written once by release.mjs --base. */
function staged() {
  if (STAGED) return STAGED;
  const w = world();
  const s = stageRuntime(w);
  const r = run("release.mjs", ["--release", s.rel, "--config", s.configPath, "--base", w.base]);
  ok(r, "release.mjs --base");
  STAGED = { ...s, stdout: r.stdout, record: JSON.parse(fs.readFileSync(path.join(s.rel, "release.json"), "utf8")) };
  return STAGED;
}

/** GitHub-style flat dirs under <root>/<parent>: <base id>/ (every asset of the base) and <rt id>/ (only its own assets). */
function writeFlat(w, s, parent) {
  const fb = path.join(s.root, parent, BASE_ID), fr = path.join(s.root, parent, RT_ID);
  fs.mkdirSync(fb, { recursive: true });
  fs.mkdirSync(fr, { recursive: true });
  for (const f of w.baseRecord.files) fs.copyFileSync(path.join(w.base, f.path), path.join(fb, path.basename(f.path)));
  for (const n of ["release.json", "SHA256SUMS"]) fs.copyFileSync(path.join(w.base, n), path.join(fb, n));
  for (const f of s.record.files.filter((x) => isOwnPath(s.record, x.path))) fs.copyFileSync(path.join(s.rel, f.path), path.join(fr, path.basename(f.path)));
  for (const n of ["release.json", "SHA256SUMS"]) fs.copyFileSync(path.join(s.rel, n), path.join(fr, n));
  return { fb, fr };
}

test("(a) release.mjs --base writes a runtime release by reference: base after id, both checks pass, its own lean-lib bound to it", () => {
  const w = world();
  const s = staged();
  assert.match(s.stdout, new RegExp(`release ${RT_ID}: .*, a release by reference of ${BASE_ID} →`));
  const rec = s.record;
  assert.deepEqual(Object.keys(rec).slice(0, 4), ["schema", "id", "base", "lean"]);
  assert.deepEqual(rec.base, { id: BASE_ID, digest: w.baseRecord.digest });
  assert.equal(byReferenceKind(rec), "runtime");
  assert.deepEqual(checkReleaseRecord(rec), []);
  assert.deepEqual(checkRecutBase(rec, w.baseRecord), []);
  assert.equal(rec.kernel.commit, K2);
  assert.equal(rec.kernel.patch, "0040");
  assert.deepEqual(rec.gate, { passed: true, commit: K2, wasmSha256: w.b.wasmSha, checks: 4 });
  assert.equal(rec.runtime.buildId, buildIdFromSha256(w.b.wasmSha));
  assert.notEqual(rec.runtime.buildId, w.baseRecord.runtime.buildId);
  const lib = rec.packs.find((p) => p.id === "lean-lib");
  assert.deepEqual([lib.release, lib.lean.compiler, lib.lean.gitRevision], [`lean-lib-4.34.0-${rec.runtime.buildId}`, K2, K2.slice(0, 12)]);
  assert.deepEqual(rec.packs.find((p) => p.id === "lean-core"), w.baseRecord.packs.find((p) => p.id === "lean-core"));
  assert.deepEqual(rec.notes, ["the runtime release's own note", s.config.notes[1], ...w.baseRecord.notes]);
  assert.match(s.config.notes[1], new RegExp(`^Notes of ${BASE_ID} \\(the base, sha256:[0-9a-f]{64}\\) follow verbatim: `));
  // SHA256SUMS differs from the base's at release.json and its own files only
  const sums = (dir) => new Map(fs.readFileSync(path.join(dir, "SHA256SUMS"), "utf8").trim().split("\n").map((l) => l.split("  ").reverse()));
  const [mine, theirs] = [sums(s.rel), sums(w.base)];
  const differ = [...new Set([...mine.keys(), ...theirs.keys()])].filter((p) => mine.get(p) !== theirs.get(p));
  assert.ok(differ.includes("release.json"));
  assert.deepEqual(differ.filter((p) => p !== "release.json" && !isOwnPath(rec, p)), []);
  const r = run("verify-release.mjs", ["--release", s.rel, "--deep", "--base", w.base]);
  ok(r, "verify --deep --base");
  assert.match(r.stdout, new RegExp(`^ ok {3}release by reference of ${BASE_ID} .*: the base's record is the pinned one, and every file outside ${esc(OWN_LABEL)} and every shared field is the base's$`, "m"));
});

test("(a) release.mjs refuses, nothing written: config.base without --base, a --base of another digest, a re-packed shared lean-core", () => {
  const w = world();
  let s = stageRuntime(w);
  let r = run("release.mjs", ["--release", s.rel, "--config", s.configPath]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /config\.base names a base \(a release by reference\): pass --base/);
  assert.deepEqual(written(s.rel), []);
  // another digest: the base's record re-signed with another note
  const { digest: _d, ...fields } = w.baseRecord;
  const other = path.join(s.root, "other.json");
  fs.writeFileSync(other, serializeRelease(canonicalRelease({ ...fields, notes: ["another note"] })));
  r = run("release.mjs", ["--release", s.rel, "--config", s.configPath, "--base", other]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, new RegExp(`config\\.base pins ${BASE_ID} \\(${w.baseRecord.digest}\\)`));
  assert.deepEqual(written(s.rel), []);
  // lean-core re-packed (another gitRevision): its manifest is not the base's, so neither its entry nor its file is
  s = stageRuntime(w);
  ok(run("pack.mjs", ["--lib", w.a.lib, "--id", "lean-core", "--out", path.join(s.rel, "profiles"), "--lean-version", "4.34.0",
    "--revision", K2, "--roots", "Init", "--url-prefix", "/profiles/", "--no-imports"]), "re-pack lean-core");
  dropRaw(s.rel);
  r = run("release.mjs", ["--release", s.rel, "--config", s.configPath, "--base", w.base]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, new RegExp(`REFUSED — not a release by reference of ${BASE_ID}:`));
  assert.match(r.stderr, /packs differs from the base's/);
  assert.match(r.stderr, /files\[\]: profiles\/lean-core\.manifest\.json is not the base's bytes/);
  assert.deepEqual(written(s.rel), []);
});

test("(b) fetch from its flat release beside the flat base: own files from --from, the rest from the sibling; verify with and without --base", () => {
  const w = world();
  const s = staged();
  const { fb, fr } = writeFlat(w, s, "flat");
  const out = path.join(s.root, "got");
  let r = run("fetch-release.mjs", ["--from", fr, "--out", out, "--only", "all", "--id", RT_ID, "--digest", s.record.digest]);
  ok(r, "fetch --only all");
  assert.match(r.stdout, new RegExp(`flat layout from ${esc(fr)}; release by reference of ${BASE_ID} \\(sha256:[0-9a-f]{16}…\\), base checked, files outside ${esc(OWN_LABEL)} from ${esc(fb)}$`, "m"));
  for (const f of s.record.files) assert.ok(fs.existsSync(path.join(out, f.path)), f.path);
  assert.equal(fs.readFileSync(path.join(out, "SHA256SUMS"), "utf8"), fs.readFileSync(path.join(s.rel, "SHA256SUMS"), "utf8"));
  r = run("verify-release.mjs", ["--release", out, "--deep"]);
  ok(r, "verify --deep");
  assert.match(r.stdout, new RegExp(`^info {2}release by reference of ${BASE_ID} \\(sha256:[0-9a-f]{16}…\\): not compared with its base`, "m"));
  r = run("verify-release.mjs", ["--release", out, "--deep", "--base", fb]);
  ok(r, "verify --deep --base");
  assert.doesNotMatch(r.stdout, /^info /m);
});

test("(c) its own files alone need no base: --only runtime, and --only runtime-chunks,lean-lib,tools, from its flat release alone", () => {
  const w = world();
  const s = staged();
  const fr = writeFlat(w, s, "alone").fr;
  fs.rmSync(path.join(s.root, "alone", BASE_ID), { recursive: true }); // no base anywhere beside it
  let out = path.join(s.root, "rt");
  let r = run("fetch-release.mjs", ["--from", fr, "--out", out, "--only", "runtime", "--id", RT_ID, "--digest", s.record.digest]);
  ok(r, "fetch --only runtime");
  assert.match(r.stdout, new RegExp(`only ${esc(OWN_LABEL)} selected: base not compared \\(--base-from compares\\)`));
  assert.ok(fs.readFileSync(path.join(out, "bin", "lean.wasm")).equals(fs.readFileSync(path.join(w.b.bin, "lean.wasm"))), "its own lean.wasm, rebuilt");
  assert.equal(fs.readFileSync(path.join(out, "bin", "leanmake"), "utf8"), "#!/bin/sh\n# the 0040 build's\n");
  out = path.join(s.root, "own");
  r = run("fetch-release.mjs", ["--from", fr, "--out", out, "--only", "runtime-chunks,lean-lib,tools", "--id", RT_ID, "--digest", s.record.digest]);
  ok(r, "fetch --only runtime-chunks,lean-lib,tools");
  assert.match(r.stdout, /base not compared/);
  const got = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else got.push(path.relative(out, p).split(path.sep).join("/")); } })(out);
  assert.deepEqual(got.filter((p) => p !== "release.json").sort(), s.record.files.map((f) => f.path).filter((p) => isOwnPath(s.record, p)).sort());
});

test("(d) a shared pack from its flat release with no locatable base: refused, nothing written", () => {
  const w = world();
  const s = staged();
  const fr = writeFlat(w, s, "orphan").fr;
  fs.rmSync(path.join(s.root, "orphan", BASE_ID), { recursive: true });
  const out = path.join(s.root, "none");
  const r = run("fetch-release.mjs", ["--from", fr, "--out", out, "--only", "lean-core"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`${RT_ID} is a release by reference of ${BASE_ID}: cannot read the base's release\\.json from `));
  assert.equal(fs.existsSync(out), false);
  // and from a dir not named for it, the sibling cannot even be looked for
  const elsewhere = path.join(s.root, "orphan", "thin");
  fs.renameSync(fr, elsewhere);
  const r2 = run("fetch-release.mjs", ["--from", elsewhere, "--out", out, "--only", "lean-core"]);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, new RegExp(`every file outside ${esc(OWN_LABEL)} is the base's, and --from .* does not end in ${RT_ID}`));
  assert.equal(fs.existsSync(out), false);
});
