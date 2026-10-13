// The decisions of wasm64-build/publish-release.mjs (the owner's publish step): which release a
// tag maps to, how assets are reconciled with the staged files, how R2 is judged, and how a release
// by reference (a tools re-cut, a runtime release) is split from its base. Pure functions (and main's usage errors, which stop before
// any command): no gh, git, rclone or network here. The steps themselves — preflight's checks
// before any write, the dry run, the real publish — run end to end against fakes in
// publish-sandbox.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  repoSlug, chooseRelease, relisted, RELIST_WAITS_MS, planAssets, contentTypeOf, checkR2Listing, releaseBody,
  splitFiles, r2Lists, r2Passes, checkBaseAssets, checkR2Copy, fetchPlan, main,
} from "../../publish-release.mjs";
import { canonicalRelease, checkRecutBase, checkReleaseRecord, isRecutOwnPath, serializeRelease } from "../release-record.mjs";
import { runtimeRecutOf } from "./runtime-recut-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "releases", "lean-v4.34.0-e1a79c1.json"), "utf8"));
const BASE_TEXT = serializeRelease(BASE);
/** A re-cut by reference of e1a79c1 (-r3): its files outside tools/, one new tgz, the base pinned. */
const RECUT = (() => {
  const { digest: _d, ...rest } = structuredClone(BASE);
  const version = `${BASE.tools.version}-r3`;
  const tgz = `tools/${BASE.tools.package}-${version}.tgz`;
  const files = BASE.files.filter((f) => !isRecutOwnPath(f.path)).concat([{ path: tgz, bytes: 83_000, sha256: "a".repeat(64) }])
    .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return canonicalRelease({ ...rest, id: `${BASE.id}-r3`, base: { id: BASE.id, digest: BASE.digest },
    tools: { ...BASE.tools, version, tgz, commit: "b".repeat(40) }, notes: ["the re-cut's own note", ...BASE.notes], files });
})();
const SHARED = RECUT.files.filter((f) => !isRecutOwnPath(f.path));
/** A runtime release by reference of e1a79c1 (lean-v4.34.0-64d6ebb): its own runtime/, lean-lib and tools. */
const RUNTIME = runtimeRecutOf(BASE);
const RT_OWN = (p) => p.startsWith("runtime/") || p.startsWith("profiles/lean-lib.") || p.startsWith("tools/");

test("repoSlug takes a github.com repository URL", () => {
  assert.equal(repoSlug("https://github.com/FawadHa1der/lean4"), "FawadHa1der/lean4");
  assert.equal(repoSlug("https://github.com/FawadHa1der/lean4.git"), "FawadHa1der/lean4");
  assert.equal(repoSlug("https://github.com/FawadHa1der/lean4/"), "FawadHa1der/lean4");
  assert.equal(repoSlug("https://gitlab.com/a/b"), null);
  assert.equal(repoSlug(undefined), null);
});

test("chooseRelease: none → create, one → use, more → stop naming the stray empty draft", () => {
  assert.deepEqual(chooseRelease([{ tag_name: "other" }], "t", "o/r"), { action: "create" });
  const one = { id: 1, tag_name: "t", draft: true, assets: [] };
  assert.deepEqual(chooseRelease([one, { tag_name: "x" }], "t", "o/r"), { action: "use", release: one });
  const c = chooseRelease([{ id: 7, tag_name: "t", draft: false, assets: [{}, {}] }, { id: 9, tag_name: "t", draft: true, assets: [] }], "t", "o/r");
  assert.equal(c.action, "stop");
  assert.match(c.reason, /2 releases exist for tag t/);
  assert.match(c.reason, /id 9: draft, 0 assets {3}— remove: gh api -X DELETE repos\/o\/r\/releases\/9/);
  assert.doesNotMatch(c.reason, /releases\/7/, "a published release is never offered for deletion");
});

test("relisted: re-reads GitHub's lagging listing until it settles, then gives up with the last read", async () => {
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  const lists = [[], [], [{ id: 3, tag_name: "t", draft: true }]]; // the draft shows up on the third read
  let reads = 0;
  const read = () => chooseRelease(lists[Math.min(reads++, lists.length - 1)], "t", "o/r");
  const c = await relisted(read, (x) => x.action !== "create", RELIST_WAITS_MS, sleep);
  assert.equal(c.action, "use");
  assert.equal(reads, 3);
  assert.deepEqual(slept, RELIST_WAITS_MS.slice(0, 2));
  // listed at once: no wait; never listed: every wait, then the last read
  slept.length = 0;
  assert.equal((await relisted(() => 1, (x) => x === 1, RELIST_WAITS_MS, sleep)), 1);
  assert.deepEqual(slept, []);
  assert.deepEqual(await relisted(() => ({ action: "create" }), (x) => x.action !== "create", RELIST_WAITS_MS, sleep), { action: "create" });
  assert.deepEqual(slept, RELIST_WAITS_MS);
  assert.equal(RELIST_WAITS_MS.reduce((a, b) => a + b, 0), 30000, "the Stop messages say 30 s");
});

const L = (name, size, sha256) => ({ name, size, sha256 });
const A = (id, name, size, digest, state = "uploaded") => ({ id, name, size, state, digest });
const H = (c) => c.repeat(64);

test("planAssets: matching assets are kept; missing ones are uploaded", () => {
  const local = [L("a", 3, H("a")), L("b", 4, H("b"))];
  assert.deepEqual(planAssets(local, [A(1, "a", 3, `sha256:${H("a")}`)], true),
    { upload: ["b"], remove: [], unverified: [], stop: null });
  assert.deepEqual(planAssets(local, [A(1, "a", 3, `sha256:${H("a")}`), A(2, "b", 4, `sha256:${H("b")}`)], false),
    { upload: [], remove: [], unverified: [], stop: null });
});

test("planAssets on a draft: an interrupted, short or different asset is removed and re-uploaded", () => {
  const local = [L("a", 3, H("a")), L("b", 4, H("b")), L("c", 5, H("c"))];
  const p = planAssets(local, [A(1, "a", 3, null, "starter"), A(2, "b", 3, `sha256:${H("b")}`), A(3, "c", 5, `sha256:${H("d")}`)], true);
  assert.equal(p.stop, null);
  assert.deepEqual(p.remove.map((r) => [r.id, r.name]), [[1, "a"], [2, "b"], [3, "c"]]);
  assert.match(p.remove[0].why, /state starter/);
  assert.match(p.remove[1].why, /size 3 ≠ 4/);
  assert.match(p.remove[2].why, /digest/);
  assert.deepEqual(p.upload, ["a", "b", "c"]);
});

test("planAssets on a PUBLISHED release never replaces bytes: a difference stops", () => {
  const p = planAssets([L("a", 3, H("a"))], [A(1, "a", 3, `sha256:${H("e")}`)], false);
  assert.match(p.stop, /PUBLISHED release has assets that differ/);
  assert.deepEqual(p.remove, []);
  assert.deepEqual(p.upload, []);
});

test("planAssets on a PUBLISHED release: an interrupted upload (no bytes) is replaced, a real difference still stops", () => {
  const p = planAssets([L("a", 3, H("a")), L("b", 4, H("b"))], [A(1, "a", 0, null, "starter"), A(2, "b", 4, `sha256:${H("b")}`)], false);
  assert.equal(p.stop, null);
  assert.deepEqual(p.remove.map((r) => [r.id, r.name]), [[1, "a"]]);
  assert.match(p.remove[0].why, /interrupted upload \(state starter, no bytes\)/);
  assert.deepEqual(p.upload, ["a"]);
  const q = planAssets([L("a", 3, H("a")), L("b", 4, H("b"))], [A(1, "a", 0, null, "starter"), A(2, "b", 4, `sha256:${H("c")}`)], false);
  assert.match(q.stop, /PUBLISHED release has assets that differ/);
  assert.match(q.stop, /b: digest/);
  assert.doesNotMatch(q.stop, /\ba: /, "the byte-less asset is not reported as a difference");
});

test("planAssets: an asset the staged release lacks stops, draft or not", () => {
  for (const draft of [true, false]) {
    const p = planAssets([L("a", 3, H("a"))], [A(1, "a", 3, `sha256:${H("a")}`), A(2, "zzz", 1, null)], draft);
    assert.match(p.stop, /assets the staged release does not: zzz/);
  }
});

test("planAssets: an uploaded asset GitHub has no digest for is left to be hashed from a download", () => {
  const p = planAssets([L("a", 3, H("a"))], [A(1, "a", 3, null)], false);
  assert.deepEqual(p, { upload: [], remove: [], unverified: ["a"], stop: null });
});

test("contentTypeOf follows HOSTING.md", () => {
  assert.equal(contentTypeOf("release.json"), "application/json");
  assert.equal(contentTypeOf("SHA256SUMS"), "application/json");
  assert.equal(contentTypeOf("profiles/lean-core.manifest.json"), "application/json");
  assert.equal(contentTypeOf("runtime/chunks/lean.wasm.0123.part-000"), "application/octet-stream");
  assert.equal(contentTypeOf("native64/native64.tar.gz"), "application/octet-stream");
});

test("checkR2Listing: complete → no problems; missing, size, type and extra objects are each named", () => {
  const local = [{ rel: "release.json", size: 10 }, { rel: "runtime/chunks/x.part-000", size: 5 }];
  const good = [{ Path: "release.json", Size: 10, MimeType: "application/json" }, { Path: "runtime/chunks/x.part-000", Size: 5, MimeType: "application/octet-stream" }];
  assert.deepEqual(checkR2Listing(local, good), []);
  const bad = checkR2Listing(local, [{ Path: "release.json", Size: 9, MimeType: "application/octet-stream" }, { Path: "stray", Size: 1, MimeType: "x" }]);
  assert.ok(bad.includes("missing on R2: runtime/chunks/x.part-000"));
  assert.ok(bad.some((p) => /release\.json: size 9 on R2, 10 staged/.test(p)));
  assert.ok(bad.some((p) => /release\.json: content type application\/octet-stream on R2, application\/json expected/.test(p)));
  assert.ok(bad.includes("on R2 but not staged: stray"));
});

test("releaseBody: the pin line, then the record's notes", () => {
  const body = releaseBody({ id: "lean-v4.34.0-abcdef0", digest: `sha256:${H("f")}`, notes: ["one", "two"] });
  assert.match(body, /^Toolchain release lean-v4\.34\.0-abcdef0\. Pin: --id lean-v4\.34\.0-abcdef0 --digest sha256:f{64}\. Contents and digests: release\.json\n\n- one\n- two\n$/);
  assert.equal(releaseBody({ id: "i", digest: "d" }), "Toolchain release i. Pin: --id i --digest d. Contents and digests: release.json\n");
});

// ---------- a release by reference (js/formats/release.md, "Release by reference") ----------

test("the fixtures: a -r3 of e1a79c1 by reference and the runtime release by reference 64d6ebb pass both record checks", () => {
  assert.deepEqual(checkReleaseRecord(RECUT), []);
  assert.deepEqual(checkRecutBase(RECUT, BASE), []);
  assert.equal(SHARED.length, 138);
  assert.deepEqual(checkReleaseRecord(RUNTIME), []);
  assert.deepEqual(checkRecutBase(RUNTIME, BASE), []);
});

test("splitFiles: a full record owns every file; a re-cut by reference owns tools/ alone (+ release.json, SHA256SUMS)", () => {
  const full = splitFiles(BASE);
  assert.deepEqual(full.own, ["release.json", "SHA256SUMS", ...BASE.files.map((f) => f.path)]);
  assert.deepEqual(full.shared, []);
  const r = splitFiles(RECUT);
  assert.deepEqual(r.own, ["release.json", "SHA256SUMS", "tools/lean4-wasm64-4.34.0-e1a79c1-r3.tgz"]);
  assert.deepEqual(r.shared, SHARED.map((f) => f.path));
  assert.equal(r.shared.length, 138);
  assert.ok(r.shared.every((p) => !p.startsWith("tools/")));
  assert.deepEqual(splitFiles({ id: "i" }), { own: ["release.json", "SHA256SUMS"], shared: [] });
});

test("splitFiles: a runtime release by reference owns runtime/, profiles/lean-lib.* and tools/ (+ release.json, SHA256SUMS)", () => {
  const r = splitFiles(RUNTIME);
  const paths = RUNTIME.files.map((f) => f.path);
  assert.deepEqual(r.own, ["release.json", "SHA256SUMS", ...paths.filter(RT_OWN)]);
  assert.deepEqual(r.shared, paths.filter((p) => !RT_OWN(p)));
  assert.equal(r.own.length, 2 + 48);
  assert.equal(r.shared.length, 89);
  assert.ok(r.shared.includes("profiles/lean-core.manifest.json") && !r.shared.some((p) => p.startsWith("profiles/lean-lib.")));
});

test("r2Lists: the shared paths split by content type, and the own ones (but release.json and SHA256SUMS) — a tools re-cut and a runtime release by reference", () => {
  const t = r2Lists(RECUT);
  assert.equal(t.objects.length, 130);
  assert.equal(t.manifests.length, 8);
  assert.deepEqual(t.ownObjects, ["tools/lean4-wasm64-4.34.0-e1a79c1-r3.tgz"]);
  assert.deepEqual(t.ownManifests, []);
  assert.ok(t.objects.every((p) => contentTypeOf(p) === "application/octet-stream"));
  assert.ok(t.manifests.every((p) => contentTypeOf(p) === "application/json"));
  assert.ok(t.manifests.includes("runtime/runtime-manifest.json") && t.manifests.includes("lists/essential-selection.json"));
  assert.ok(t.objects.includes("native64/native64.tar.gz"));
  assert.ok(![...t.objects, ...t.manifests].some((p) => p.startsWith("tools/")));
  const r = r2Lists(RUNTIME);
  assert.equal(r.objects.length, 84);
  assert.equal(r.manifests.length, 5);
  assert.deepEqual(r.ownManifests, ["profiles/lean-lib.manifest.json", "runtime/runtime-manifest.json", `runtime/runtime-manifest.${RUNTIME.runtime.buildId}.json`]);
  assert.equal(r.ownObjects.length, 48 - 3);
  assert.ok(r.ownObjects.includes("runtime/bin/leanmake") && r.ownObjects.includes(RUNTIME.tools.tgz));
  assert.ok(![...r.objects, ...r.manifests].some(RT_OWN), "nothing it owns is copied from the base");
  assert.ok(![...r.ownObjects, ...r.ownManifests].some((p) => p === "release.json" || p === "SHA256SUMS"));
  assert.deepEqual([...r.objects, ...r.manifests, ...r.ownObjects, ...r.ownManifests].sort(), RUNTIME.files.map((f) => f.path).sort());
});

// the three passes of a release dir, exactly as HOSTING.md prints them
const COMMON = ["--immutable", "--s3-no-check-bucket", "--checksum"];
const THREE = (rel, dest) => [
  ["copy", rel, dest, ...COMMON, "--filter", "- *.json", "--filter", "- SHA256SUMS",
    "--header-upload", "Content-Type: application/octet-stream", "--transfers", "4", "--s3-chunk-size", "64M"],
  ["copy", rel, dest, ...COMMON, "--filter", "- /release.json", "--filter", "+ *.json", "--filter", "+ /SHA256SUMS",
    "--filter", "- *", "--header-upload", "Content-Type: application/json"],
  ["copy", rel, dest, ...COMMON, "--filter", "+ /release.json", "--filter", "- *", "--header-upload", "Content-Type: application/json"],
];

test("r2Passes: a full record, or --r2-source local, gives today's three passes", () => {
  assert.deepEqual(r2Passes({ rel: "/s/rel", dest: "r:b/p/id/" }), THREE("/s/rel", "r:b/p/id/"));
  assert.deepEqual(r2Passes({ rel: "/s/rel", dest: "r:b/p/id-r3/", basePrefix: "r:b/p/id/", objectsList: "/t/o", manifestsList: "/t/m", source: "local" }),
    THREE("/s/rel", "r:b/p/id-r3/"));
});

test("r2Passes: a tools re-cut by reference copies the shared files server-side, then its own files, release.json last", () => {
  const p = r2Passes({ rel: "/s/rel", dest: "r:b/p/id-r3/", basePrefix: "r:b/p/id/", objectsList: "/t/shared.objects", manifestsList: "/t/shared.manifests", ownObjectsList: "/t/own.objects" });
  assert.equal(p.length, 5);
  for (const a of p) {
    assert.equal(a[0], "copy");
    assert.equal(a[2], "r:b/p/id-r3/");
    for (const f of COMMON) assert.ok(a.includes(f), `${f} in ${a.join(" ")}`);
    assert.ok(!a.includes("sync") && !a.includes("copyto"));
  }
  // 1-2: from the base's prefix, by list, keeping each object's metadata (no -M, no --header-upload)
  assert.deepEqual(p[0], ["copy", "r:b/p/id/", "r:b/p/id-r3/", ...COMMON, "--files-from-raw", "/t/shared.objects", "--transfers", "8"]);
  assert.deepEqual(p[1], ["copy", "r:b/p/id/", "r:b/p/id-r3/", ...COMMON, "--files-from-raw", "/t/shared.manifests"]);
  for (const a of p.slice(0, 2)) assert.ok(!a.includes("-M") && !a.includes("--metadata") && !a.includes("--header-upload") && !a.includes("--filter"));
  // 3: its own objects from the staged dir, by list; 4-5: SHA256SUMS, then release.json alone
  assert.deepEqual(p[2], ["copy", "/s/rel", "r:b/p/id-r3/", ...COMMON, "--files-from-raw", "/t/own.objects", "--header-upload", "Content-Type: application/octet-stream", "--transfers", "4", "--s3-chunk-size", "64M"]);
  assert.deepEqual(p.slice(3).map((a) => [a[1], a.slice(a.indexOf("--filter")).join(" ")]), [
    ["/s/rel", "--filter + /SHA256SUMS --filter - * --header-upload Content-Type: application/json"],
    ["/s/rel", "--filter + /release.json --filter - * --header-upload Content-Type: application/json"],
  ]);
});

test("r2Passes: a runtime release by reference: shared objects and manifests server-side, its own objects, then its own manifests, SHA256SUMS, release.json last", () => {
  const p = r2Passes({ rel: "/s/rel", dest: "r:b/p/rt/", basePrefix: "r:b/p/id/", objectsList: "/t/shared.objects", manifestsList: "/t/shared.manifests",
    ownObjectsList: "/t/own.objects", ownManifestsList: "/t/own.manifests" });
  assert.equal(p.length, 6);
  assert.deepEqual(p.map((a) => a[1]), ["r:b/p/id/", "r:b/p/id/", "/s/rel", "/s/rel", "/s/rel", "/s/rel"]);
  assert.deepEqual(p.map((a) => a[a.indexOf("--files-from-raw") + 1] ?? null).slice(0, 4), ["/t/shared.objects", "/t/shared.manifests", "/t/own.objects", "/t/own.manifests"]);
  assert.deepEqual(p.slice(2, 4).map((a) => a[a.indexOf("--header-upload") + 1]), ["Content-Type: application/octet-stream", "Content-Type: application/json"]);
  assert.ok(p[4].includes("+ /SHA256SUMS") && p[5].includes("+ /release.json"), "release.json last");
  for (const a of p) assert.ok(a.includes("--immutable") && a[2] === "r:b/p/rt/");
});

const sha = (t) => createHash("sha256").update(t).digest("hex");
/** The base's GitHub release as published: every base file flat, its release.json and SHA256SUMS. */
function baseAssets() {
  let id = 1;
  return [...BASE.files.map((f) => A(id++, path.posix.basename(f.path), f.bytes, `sha256:${f.sha256}`)),
    A(id++, "release.json", Buffer.byteLength(BASE_TEXT), `sha256:${sha(BASE_TEXT)}`), A(id++, "SHA256SUMS", 9000, `sha256:${H("9")}`)];
}
const PUBLISHED = { id: 77, tag_name: BASE.id, draft: false };

test("checkBaseAssets: the published base release holds every shared file and its record → no problems", () => {
  assert.deepEqual(checkBaseAssets(SHARED, PUBLISHED, baseAssets(), BASE_TEXT), { problems: [], unverified: [] });
});

test("checkBaseAssets: no release, a draft, missing / interrupted / short / different assets and another record are each named", () => {
  assert.deepEqual(checkBaseAssets(SHARED, null, [], BASE_TEXT).problems, ["the base has no GitHub release"]);
  assert.match(checkBaseAssets(SHARED, { ...PUBLISHED, draft: true }, baseAssets(), BASE_TEXT).problems.join("\n"), /is a draft: publish the base first/);
  const edit = (name, change) => baseAssets().flatMap((a) => (a.name !== name ? [a] : change(a) ?? []));
  const one = (assets, text = BASE_TEXT) => checkBaseAssets(SHARED, PUBLISHED, assets, text).problems;
  assert.deepEqual(one(edit("native64.tar.gz", () => null)), ["missing: native64.tar.gz"]);
  assert.deepEqual(one(edit("native64.tar.gz", (a) => ({ ...a, state: "starter", size: 0, digest: null }))), ["native64.tar.gz: interrupted upload (state starter, no bytes)"]);
  assert.match(one(edit("native64.tar.gz", (a) => ({ ...a, size: a.size - 1 }))).join(), /^native64\.tar\.gz: size 821257945 ≠ 821257946$/);
  assert.match(one(edit("native64.tar.gz", (a) => ({ ...a, digest: `sha256:${H("e")}` }))).join(), /^native64\.tar\.gz: digest sha256:eeeeeeeeeeee… ≠ sha256:/);
  // the record GitHub serves is not the one at the base's tag
  const other = BASE_TEXT.replace("\n}\n", "\n}\n\n");
  assert.match(one(baseAssets(), other).join(), /release\.json: size .* ≠/);
  assert.match(one(edit("release.json", (a) => ({ ...a, digest: `sha256:${H("d")}` }))).join(), /release\.json: digest .* \(not the record at the base's tag\)/);
  // the base's own tools tgz and SHA256SUMS are not this re-cut's concern: extra assets are fine
  assert.deepEqual(one(edit("SHA256SUMS", () => null)), []);
});

test("checkBaseAssets: an asset GitHub has no digest for is unverified (hash a download), not a pass and not a problem", () => {
  const assets = baseAssets().map((a) => (a.name === "native64.tar.gz" || a.name === "release.json" ? { ...a, digest: null } : a));
  const r = checkBaseAssets(SHARED, PUBLISHED, assets, BASE_TEXT);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.unverified, [
    { name: "native64.tar.gz", sha256: BASE.files.find((f) => f.path === "native64/native64.tar.gz").sha256 },
    { name: "release.json", sha256: sha(BASE_TEXT) },
  ]);
});

test("planAssets with a re-cut's own files only: a shared asset on its release stops; a draft's stop lists the removals", () => {
  const own = [L("release.json", 9, H("1")), L("SHA256SUMS", 8, H("2")), L("lean4-wasm64-4.34.0-e1a79c1-r3.tgz", 7, H("3"))];
  const assets = [A(11, "release.json", 9, `sha256:${H("1")}`), A(12, "native64.tar.gz", 821257946, `sha256:${H("4")}`), A(13, "lean.wasm.x.part-000", 5, null)];
  const draft = planAssets(own, assets, true, "o/r");
  assert.match(draft.stop, /^the release has assets the staged release does not: native64\.tar\.gz, lean\.wasm\.x\.part-000\n/);
  assert.match(draft.stop, /\n {2}gh api -X DELETE repos\/o\/r\/releases\/assets\/12 {3}# native64\.tar\.gz\n {2}gh api -X DELETE repos\/o\/r\/releases\/assets\/13 {3}# lean\.wasm\.x\.part-000$/);
  assert.doesNotMatch(draft.stop, /assets\/11/, "an own asset is never offered for removal");
  assert.deepEqual([draft.upload, draft.remove], [[], []]);
  const published = planAssets(own, assets, false, "o/r");
  assert.match(published.stop, /assets the staged release does not: native64\.tar\.gz/);
  assert.doesNotMatch(published.stop, /DELETE/, "nothing of a published release is offered for removal");
});

/** rclone check's -vv log: each "=" file's debug line ("OK", or "OK - could not check hash"), then the NOTICE summary. */
function checkLog(ok, noHash = [], { count = noHash.length } = {}) {
  return [
    "2026/10/08 20:00:00 DEBUG : rclone: Version \"v1.71.0\" starting with parameters [\"rclone\" \"check\"]",
    ...ok.map((p) => `2026/10/08 20:00:01 DEBUG : ${p}: OK`),
    ...noHash.map((p) => `2026/10/08 20:00:01 DEBUG : ${p}: OK - could not check hash`),
    "2026/10/08 20:00:02 NOTICE: S3 bucket b path p/id-r3: 0 differences found",
    ...(count ? [`2026/10/08 20:00:02 NOTICE: S3 bucket b path p/id-r3: ${count} hashes could not be checked`] : []),
    `2026/10/08 20:00:02 NOTICE: S3 bucket b path p/id-r3: ${ok.length + noHash.length} matching files`,
  ].join("\n");
}

test("checkR2Copy: every shared path \"=\" with its compared MD5 logged → no problems", () => {
  const shared = ["a/x", "b/y"];
  assert.deepEqual(checkR2Copy("= a/x\n= b/y\n", checkLog(shared), shared), { problems: [], unhashed: [] });
});

test("checkR2Copy: +, -, * and ! lines, a stray =, a missing path and an unreadable line are each named", () => {
  const shared = ["a/x", "b/y", "c/z", "d/w", "e/v"];
  const { problems } = checkR2Copy("= a/x\n+ b/y\n- f/u\n* c/z\n! d/w\n= g/t\nwhat\n", checkLog(["a/x", "g/t"]), shared);
  assert.deepEqual(problems, [
    "b/y: missing on R2", "f/u: on R2 only", "c/z: differs from the staged file", "d/w: could not be read or hashed",
    "g/t: checked, but not a shared file", "unexpected rclone check line: what", "e/v: not in the rclone check output",
  ]);
  assert.match(checkR2Copy("", "", ["a/x"]).problems.join(), /a\/x: not in the rclone check output/);
});

test("checkR2Copy: an \"=\" passes only with its logged comparison — no log (or another format) is a problem", () => {
  const shared = ["a/x", "b/y"];
  for (const log of ["", "NOTICE: 2 matching files", checkLog(["a/x"]), '{"level":"debug","msg":"OK","object":"b/y"}']) {
    const r = checkR2Copy("= a/x\n= b/y\n", log, shared);
    assert.equal(r.problems.length, 1, log);
    assert.match(r.problems[0], /^rclone's log shows no hash comparison for [12] "=" file\(s\): (a\/x, )?b\/y$/);
  }
});

test("checkR2Copy: \"N hashes could not be checked\" is no pass — the objects its log names are hashed, an unnamed one is a problem", () => {
  const shared = ["native64/native64.tar.gz", "runtime/chunks/x.part-000", "lists/e.txt"];
  const combined = shared.map((p) => `= ${p}`).join("\n");
  assert.deepEqual(checkR2Copy(combined, checkLog(shared.slice(2), shared.slice(0, 2)), shared), { problems: [], unhashed: shared.slice(0, 2) });
  // the count says 2, the log names 1 (and shows the other as compared): the two cannot be told apart
  const partial = checkR2Copy(combined, checkLog(shared.slice(1), shared.slice(0, 1), { count: 2 }), shared);
  assert.deepEqual(partial.problems, ["rclone could not check 2 hash(es) and its log names 1: the others cannot be told apart"]);
  assert.deepEqual(partial.unhashed, shared.slice(0, 1));
});

test("releaseBody: a release by reference says where its other files are, between the pin and the notes", () => {
  const body = releaseBody(RECUT);
  const [pin, ref, notes, ...rest] = body.split("\n\n");
  assert.match(pin, /^Toolchain release lean-v4\.34\.0-e1a79c1-r3\. Pin: --id lean-v4\.34\.0-e1a79c1-r3 --digest sha256:[0-9a-f]{64}\./);
  assert.equal(ref, `Release by reference of ${BASE.id} (${BASE.digest}): this release's assets are its own files (tools/: 1 file), `
    + `release.json and SHA256SUMS; every other file release.json lists is an asset of ${BASE.id} (lean4-wasm64 fetch takes them from there).`);
  assert.equal(notes, `${RECUT.notes.map((n) => `- ${n}`).join("\n")}\n`);
  assert.deepEqual(rest, []);
  assert.equal(releaseBody(RUNTIME).split("\n\n")[1], `Release by reference of ${BASE.id} (${BASE.digest}): this release's assets are its own files `
    + `(runtime/, profiles/lean-lib.* and tools/: 48 files), release.json and SHA256SUMS; every other file release.json lists is an asset of ${BASE.id} `
    + "(lean4-wasm64 fetch takes them from there).");
  assert.doesNotMatch(releaseBody(BASE), /by reference/);
});

test("fetchPlan: auto / full / runtime / none, on a full record and on both kinds by reference", () => {
  const cases = [
    ["auto", BASE, { only: null, deep: true }], ["auto", RECUT, { only: "runtime,lists,tools", deep: false }], ["auto", RUNTIME, { only: "runtime,lists,tools", deep: false }],
    ["full", BASE, { only: null, deep: true }], ["full", RECUT, { only: null, deep: true }], ["full", RUNTIME, { only: null, deep: true }],
    ["runtime", BASE, { only: "runtime", deep: false }], ["runtime", RECUT, { only: "runtime,lists,tools", deep: false }], ["runtime", RUNTIME, { only: "runtime,lists,tools", deep: false }],
    ["none", BASE, null], ["none", RECUT, null], ["none", RUNTIME, null],
  ];
  for (const [mode, record, want] of cases) assert.deepEqual(fetchPlan(record, mode), want, `${mode} on ${record.id}`);
  assert.throws(() => fetchPlan(BASE, "some"), /auto \| full \| runtime \| none/);
});

test("the new flags: bad values and --r2-quick with --r2-full are usage errors (exit 2), before anything runs", async () => {
  const err = console.error;
  const said = [];
  console.error = (s) => said.push(s);
  try {
    assert.equal(await main([RECUT.id, "--fetch-check", "deep"]), 2);
    assert.equal(await main([RECUT.id, "--r2-source", "mirror"]), 2);
    assert.equal(await main([RECUT.id, "--r2-quick", "--r2-full"]), 2);
    assert.equal(await main([RECUT.id, "--r2-source"]), 2);
  } finally { console.error = err; }
  assert.deepEqual(said, [
    "publish-release: --fetch-check: auto | full | runtime | none", "publish-release: --r2-source: base | local",
    "publish-release: --r2-quick and --r2-full exclude each other", "publish-release: --r2-source needs a value",
  ]);
});
