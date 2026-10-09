// A re-cut by reference, the record layer (release-record.mjs; formats/release.md, "Re-cut by
// reference"): the structure rules checkReleaseRecord adds for `base`, and checkRecutBase, the
// comparison with the base's record. Pure: the committed records under ../../releases are the
// fixtures, and a -r3 is synthesized from e1a79c1.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RECUT_OWN_DIRS, RECUT_SAME_KEYS, RELEASE_DIGEST, RELEASE_KEY_ORDER, canonicalRelease, checkRecutBase, checkReleaseRecord,
  firstCutOf, isRecutOwnPath,
} from "../release-record.mjs";
import * as olderReader from "./fixtures/release-record-r2/release-record.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const releasesDir = path.join(here, "..", "..", "releases");
const committed = fs.readdirSync(releasesDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(releasesDir, f), "utf8")));
const byId = (id) => structuredClone(committed.find((r) => r.id === id));
const BASE = byId("lean-v4.34.0-e1a79c1");
const resign = (r) => { const { digest: _d, ...rest } = r; return canonicalRelease(rest); };

/** A re-cut by reference of `base`: its files outside tools/, one new tgz, the base pinned. */
function recutOf(base, { n = 3, edit = (x) => x } = {}) {
  const { digest: _d, ...rest } = structuredClone(base);
  const version = `${base.tools.version.replace(/-r\d+$/, "")}-r${n}`;
  const tgz = `tools/${base.tools.package}-${version}.tgz`;
  const files = base.files.filter((f) => !isRecutOwnPath(f.path)).concat([{ path: tgz, bytes: 83_000, sha256: "a".repeat(64) }])
    .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return canonicalRelease(edit({
    ...rest, id: `${base.id}-r${n}`, base: { id: base.id, digest: base.digest },
    gate: { ...base.gate, checks: (base.gate.checks ?? 0) + 1 },
    tools: { ...base.tools, version, tgz, commit: "b".repeat(40) },
    notes: ["the re-cut's own note", ...(base.notes ?? [])], files,
  }));
}

test("committed records: valid, digests unchanged now that `base` is in the key order", () => {
  assert.ok(committed.length >= 4);
  for (const r of committed) {
    assert.deepEqual(checkReleaseRecord(r), [], r.id);
    assert.equal(resign(r).digest, r.digest, r.id);
    assert.equal(r.base, undefined, r.id);
  }
  assert.deepEqual(RELEASE_KEY_ORDER.slice(0, 3), ["schema", "id", "base"]);
  for (const a of [RELEASE_KEY_ORDER, RECUT_OWN_DIRS, RECUT_SAME_KEYS]) assert.ok(Object.isFrozen(a));
});

test("firstCutOf / isRecutOwnPath / RELEASE_DIGEST", () => {
  assert.equal(firstCutOf("lean-v4.34.0-e1a79c1-r3"), "lean-v4.34.0-e1a79c1");
  assert.equal(firstCutOf("lean-v4.34.0-rc1-e1a79c1-r12"), "lean-v4.34.0-rc1-e1a79c1");
  for (const x of ["lean-v4.34.0-e1a79c1", "lean-v4.34.0-e1a79c1-r1", "nope", undefined, 3]) assert.equal(firstCutOf(x), null, String(x));
  assert.equal(isRecutOwnPath("tools/x.tgz"), true);
  for (const x of ["toolsx/y", "runtime/x", "tools", undefined, 7]) assert.equal(isRecutOwnPath(x), false, String(x));
  assert.ok(RELEASE_DIGEST.test(BASE.digest));
  assert.ok(!RELEASE_DIGEST.test(BASE.digest.toUpperCase().replace("SHA256", "sha256")));
});

test("a -r3 synthesized from e1a79c1 passes both checks: 139 files, one of its own", () => {
  const r = recutOf(BASE);
  assert.deepEqual(checkReleaseRecord(r), []);
  assert.deepEqual(checkRecutBase(r, BASE), []);
  assert.deepEqual(Object.keys(r).slice(0, 4), ["schema", "id", "base", "lean"]);
  assert.equal(r.files.length, BASE.files.length);
  assert.deepEqual(r.files.filter((f) => isRecutOwnPath(f.path)).map((f) => f.path), ["tools/lean4-wasm64-4.34.0-e1a79c1-r3.tgz"]);
});

test("structure (S1-S5): each malformed base is refused by name, with no other record", () => {
  const cases = [
    ["base null", (r) => ({ ...r, base: null }), /base is not an object/],
    ["base an array", (r) => ({ ...r, base: [] }), /base is not an object/],
    ["an extra key", (r) => ({ ...r, base: { ...r.base, url: "x" } }), /base: unknown keys url/],
    ["base on a first cut", (r) => ({ ...r, id: BASE.id, tools: BASE.tools, files: BASE.files }), /only a re-cut .* names a base/],
    ["base.id of another kernel", (r) => ({ ...r, base: { ...r.base, id: "lean-v4.34.0-41ec565" } }), /is not lean-v4.34.0-e1a79c1: a re-cut by reference names its first cut/],
    ["base.id naming an -r2", (r) => ({ ...r, base: { ...r.base, id: "lean-v4.34.0-e1a79c1-r2" } }), /names its first cut/],
    ["an upper-case digest", (r) => ({ ...r, base: { ...r.base, digest: r.base.digest.replace(/[a-f]/g, (c) => c.toUpperCase()) } }), /base.digest is not sha256/],
    ["a short digest", (r) => ({ ...r, base: { ...r.base, digest: "sha256:abc" } }), /base.digest is not sha256/],
    ["no tools", (r) => { const { tools: _t, ...x } = r; return { ...x, files: r.files.filter((f) => !isRecutOwnPath(f.path)) }; }, /tools missing/],
    ["a second tools/ file", (r) => ({ ...r, files: [...r.files, { path: "tools/extra.tgz", bytes: 1, sha256: "c".repeat(64) }].sort((a, b) => (a.path < b.path ? -1 : 1)) }), /exactly one file under tools\/, tools.tgz — got/],
    ["tools.tgz not named for the version", (r) => ({ ...r, tools: { ...r.tools, tgz: "tools/other.tgz" }, files: r.files.map((f) => (isRecutOwnPath(f.path) ? { ...f, path: "tools/other.tgz" } : f)) }), /is not tools\/<package>-<version>.tgz/],
    ["a version without -rN", (r) => { const tgz = "tools/lean4-wasm64-4.34.0-e1a79c1.tgz"; return { ...r, tools: { ...r.tools, version: "4.34.0-e1a79c1", tgz }, files: r.files.map((f) => (isRecutOwnPath(f.path) ? { ...f, path: tgz } : f)) }; }, /does not end in -r3/],
  ];
  for (const [label, edit, re] of cases) {
    const r = recutOf(BASE, { edit });
    const p = checkReleaseRecord(r);
    assert.ok(p.some((q) => re.test(q)), `${label}: ${JSON.stringify(p)}`);
  }
});

test("checkRecutBase: one refusal per family; gate.checks, notes and tools may differ", () => {
  const ok = recutOf(BASE);
  const refused = (r, b, re, label) => { const p = checkRecutBase(r, b); assert.ok(p.some((q) => re.test(q)), `${label}: ${JSON.stringify(p)}`); };
  // the real drift: the staged -r2 (a by-value re-cut) differs from e1a79c1 only in a pack note
  const r2 = byId("lean-v4.34.0-e1a79c1-r2");
  const { digest: _d, ...r2rest } = r2;
  const r2ref = canonicalRelease({ ...r2rest, base: { id: BASE.id, digest: BASE.digest } });
  assert.deepEqual(checkReleaseRecord(r2ref), []);
  assert.deepEqual(checkRecutBase(r2ref, BASE), ["packs differs from the base's (a re-cut by reference changes tools/ only)"]);
  refused(recutOf(BASE, { edit: (r) => ({ ...r, runtime: { ...r.runtime, target: "other" } }) }), BASE, /^runtime differs/, "runtime");
  refused(recutOf(BASE, { edit: (r) => ({ ...r, hosting: Object.fromEntries(Object.entries(r.hosting).reverse()) }) }), BASE, /^hosting differs/, "hosting key order");
  refused(recutOf(BASE, { edit: (r) => ({ ...r, notes: r.notes }) }), { ...BASE, gate: { ...BASE.gate, commit: "f".repeat(40) } }, /the base's release.json/, "a base re-edited without re-signing");
  const g = resign({ ...structuredClone(BASE), kernel: { ...BASE.kernel, commit: "f".repeat(40) }, gate: { ...BASE.gate, commit: "f".repeat(40) } });
  refused(recutOf(BASE), g, /digest is .*, the record pins/, "a re-signed base");
  const one = ok.files.findIndex((f) => !isRecutOwnPath(f.path));
  refused(recutOf(BASE, { edit: (r) => ({ ...r, files: r.files.map((f, i) => (i === one ? { ...f, bytes: f.bytes + 1 } : f)) }) }), BASE, /is not the base's bytes/, "bytes");
  refused(recutOf(BASE, { edit: (r) => ({ ...r, files: r.files.map((f, i) => (i === one ? { ...f, sha256: "d".repeat(64) } : f)) }) }), BASE, /is not the base's bytes/, "sha256");
  refused(recutOf(BASE, { edit: (r) => ({ ...r, files: r.files.filter((_, i) => i !== one) }) }), BASE, /the base's .* is missing/, "a missing base file");
  refused(recutOf(BASE, { edit: (r) => ({ ...r, files: [...r.files, { path: "lists/zz-extra.txt", bytes: 1, sha256: "e".repeat(64) }].sort((a, b) => (a.path < b.path ? -1 : 1)) }) }), BASE, /lists\/zz-extra.txt is not a file of the base/, "an extra file");
  refused(ok, { ...BASE, id: "lean-v4.34.0-41ec565" }, /the base's release.json is "lean-v4.34.0-41ec565"/, "another id");
  refused(recutOf(BASE, { edit: (r) => ({ ...r, tools: { ...r.tools, package: "other" } }) }), BASE, /tools.package "other" is not the base's/, "package");
  const sameVersion = recutOf(BASE, { edit: (r) => ({ ...r, tools: { ...r.tools, version: BASE.tools.version } }) });
  refused(sameVersion, BASE, /tools.version .* is the base's/, "version");
  refused(ok, null, /not an object/, "no base record");
  assert.deepEqual(checkRecutBase(BASE, BASE), ["release.json names no base"]);
  // allowed to differ
  assert.notEqual(ok.gate.checks, BASE.gate.checks);
  assert.notDeepEqual(ok.notes, BASE.notes);
  assert.notDeepEqual(ok.tools, BASE.tools);
  assert.deepEqual(checkRecutBase(ok, BASE), []);
});

test("older readers fail closed: -r2's own checker refuses `base` (unknown key)", () => {
  const r = recutOf(BASE);
  const p = olderReader.checkReleaseRecord(r);
  assert.ok(p.some((q) => /unknown keys: base/.test(q)), JSON.stringify(p));
  for (const old of committed) assert.deepEqual(olderReader.checkReleaseRecord(old), [], old.id); // and nothing else changed for it
});
