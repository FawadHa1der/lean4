// The decisions of wasm64-build/publish-release.mjs (the owner's publish step): which release a
// tag maps to, how assets are reconciled with the staged files, how R2 is judged. Pure functions:
// no gh, git, rclone or network here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repoSlug, chooseRelease, planAssets, contentTypeOf, checkR2Listing, releaseBody } from "../../publish-release.mjs";

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
