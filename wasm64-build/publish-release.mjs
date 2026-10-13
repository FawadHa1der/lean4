#!/usr/bin/env node
// publish-release.mjs <id> — publish a STAGED lean4-wasm64 release, end to end, resumably.
//
//   node wasm64-build/publish-release.mjs lean-v4.34.0-e1a79c1 [options]
//   wasm64-build/import-release.sh publish lean-v4.34.0-e1a79c1 [options]
//
// What `stage-release.sh` leaves to the repository owner, as one command (RELEASE.md):
//   1. record   commit wasm64-build/releases/<id>.json ON THE LINE (HEAD must be the line branch)
//               and tag the commit that holds the record (annotated) — unless done; a tag origin
//               already has is fetched, never made again
//   2. push     the tag, and the line up to it: a fast-forward to commits the local line holds,
//               listed before the question (a re-cut cut from a branch off its base pushes its
//               tag alone) — unless origin has them
//   3. github   needs the tag on GitHub. ONE release for the tag: a draft is created (or the
//               existing one reused), every file uploaded by basename (skipping assets whose
//               SHA-256 already matches), every asset verified against the staged bytes, and only
//               then published (--verify-tag). A release by reference uploads its own files only
//               (a tools re-cut: tools/<tgz>; a runtime release by reference: also runtime/ and the
//               lean-lib pack; both: release.json, SHA256SUMS): the others are its base's assets
//   4. r2       needs the tag on GitHub. The served layout under <r2>/<id>/: objects, then
//               manifests + SHA256SUMS, then release.json last (js/formats/HOSTING.md), all with
//               `copy --immutable` (an object that differs is a stop, never overwritten); then every
//               name, size, content type and (unless --r2-quick) object SHA-256 is checked. A release
//               by reference gets a complete prefix too: its shared files are copied server-side
//               from <r2>/<base id>/, then its own files go up (objects, then manifests, by lists
//               derived from the record), release.json last; it is checked by the listing, its own
//               files' SHA-256 and an `rclone check` (MD5) of the shared files against the staged
//               dir (--r2-full: every object's SHA-256, as for a full release)
//   5. fetch    an anonymous `lean4-wasm64 fetch`, run with the staged tgz's own tools (the reader
//               this release ships, as preflight unpacked and checked it), of the published GitHub
//               release pinned by --id/--digest, then `verify --deep`; a release by reference: its
//               runtime, the lists (always the base's: the hop to its base's release) and its tools
//               (--fetch-check to change it)
// Before any step, whatever --only is (--dry-run too), the staged dir is verified, and so is the
// reader it ships: its tools tgz is unpacked, must be tools.package@tools.version, and its own
// `verify` must pass the staged dir (with --base for a release by reference).
// Every step first reads the current state and does only what is missing, so a re-run after an
// interruption (or after doing a step by hand) resumes. It never creates a second release for a
// tag, never replaces or deletes an asset of a PUBLISHED release that has bytes (an interrupted,
// byte-less upload is replaced on any release), never force-pushes (the push is --atomic), and
// stops with the command to fix things where a state is not one it produced. A re-cut (-rN) may
// be recorded on a branch cut from its base's record commit; then only its tag is pushed.
// A release by reference (release.json `base`, js/formats/release.md) is checked against its base
// before any step, whatever --only is: the base's record at its tag (canonical, checkRecutBase),
// its published GitHub release holding every shared file (size and digest) and that record, and
// (--r2-source base) its R2 prefix holding every shared object with the staged MD5 and that record.
//
// Options:
//   --release-dir <dir>   the staged release (default: ../wasm64-lean-kernel-release/<id> beside the repo)
//   --r2 <remote:path>    the R2 prefix (default: $LEAN4_WASM64_R2 or qed64-r2:qed64-artifacts/lean4-wasm64)
//   --only <steps>        a comma list of record,push,github,r2,fetch (default: all, in that order)
//   --r2-quick            check R2 by listing only (names, sizes, content types), not by hashing (a
//                         release by reference: nor by the MD5 check of its shared objects)
//   --r2-full             check R2 by every object's SHA-256 (a download; always so for a full release)
//   --r2-source <s>       a release by reference: base (default: copy the shared files server-side from
//                         the base's prefix) | local (upload them from the staged dir; the base's prefix
//                         is not read)
//   --fetch-check <m>     auto (default: full; runtime for a release by reference) | full (every file,
//                         ~3 GB, then verify --deep) | runtime (a release by reference: runtime,lists,tools)
//                         | none
//   --yes                 do not ask before pushing and publishing
//   --dry-run             read and check everything, print the commands it would run, change nothing
//                         (the temp files those commands name are kept)
//   -h, --help
// Exit codes: 0 every selected step done (PUBLISHED only when record, push, github and r2 all
// ran; --dry-run: the plan printed); 1 a check failed or a step stopped; 2 usage, a missing tool
// or an unusable environment (no gh login, no rclone remote, a shallow checkout).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RELEASE_ID, checkRecutBase, checkReleaseRecord, isOwnPath, ownLabel, releaseDigest, serializeRelease } from "./js/release-record.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const JS = path.join(HERE, "js");
const STEPS = ["record", "push", "github", "r2", "fetch"];
const UPLOAD_BATCH = 25;

// ---------- pure decisions (unit-tested: js/test/publish-release.test.mjs) ----------

/** "https://github.com/O/R" (or …/O/R.git) → "O/R"; null when it is not a github.com repo URL. */
export function repoSlug(url) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url ?? ""));
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The releases GitHub holds for one tag → what to do: {action: "create"} | {action: "use", release}
 * | {action: "stop", reason}. Two or more is never resolved automatically: the stray ones (usually
 * an empty draft from a repeated `gh release create`) are listed with the command that removes one.
 */
export function chooseRelease(releases, tag, slug) {
  const mine = releases.filter((r) => r.tag_name === tag);
  if (mine.length === 0) return { action: "create" };
  if (mine.length === 1) return { action: "use", release: mine[0] };
  const lines = mine.map((r) => `  id ${r.id}: ${r.draft ? "draft" : "published"}, ${r.assets?.length ?? 0} assets`
    + (r.draft && !(r.assets?.length) ? `   — remove: gh api -X DELETE repos/${slug}/releases/${r.id}` : ""));
  return { action: "stop", reason: `${mine.length} releases exist for tag ${tag}; keep one:\n${lines.join("\n")}` };
}

/** Waits between re-reads of GitHub's release listing: 30 s in all. */
export const RELIST_WAITS_MS = [1000, 2000, 4000, 8000, 15000];

/**
 * GitHub lists a release a few seconds after `gh release create` or `gh release edit` returns (the -r3
 * publish stopped on "the new draft is not listed" that way): `read()` again, after each of `waits`, until
 * `ok(value)`; the last value either way.
 */
export async function relisted(read, ok, waits = RELIST_WAITS_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  let value = read();
  for (const ms of waits) {
    if (ok(value)) break;
    await sleep(ms);
    value = read();
  }
  return value;
}

/**
 * Reconcile a release's assets with the staged files (flat, by basename).
 * local: [{name, size, sha256}]; assets: [{id, name, size, state, digest}] (GitHub's `digest` is
 * "sha256:<hex>", possibly null). Returns {upload: [names], remove: [{id, name, why}],
 * unverified: [names], stop: reason|null}. An asset that is not "uploaded" (an interrupted upload,
 * no bytes) is removed and re-uploaded on any release; one whose bytes differ only on a DRAFT — on a
 * published release that is a stop, as is any asset the staged release does not have (on a draft,
 * the stop lists the command that removes each: `slug` is the repository).
 */
export function planAssets(local, assets, isDraft, slug = "<owner>/<repo>") {
  const byName = new Map(assets.map((a) => [a.name, a]));
  const wanted = new Set(local.map((f) => f.name));
  const out = { upload: [], remove: [], unverified: [], stop: null };
  const extra = assets.filter((a) => !wanted.has(a.name));
  if (extra.length) {
    const names = extra.map((a) => a.name);
    out.stop = `the release has assets the staged release does not: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""}`
      + (isDraft ? `\n  the release is a draft: remove them, then re-run:\n${extra.map((a) => `  gh api -X DELETE repos/${slug}/releases/assets/${a.id}   # ${a.name}`).join("\n")}` : "");
    return out;
  }
  const bad = [];
  for (const f of local) {
    const a = byName.get(f.name);
    if (!a) { out.upload.push(f.name); continue; }
    // an interrupted upload ("starter" etc.) has no bytes anyone can download: replacing it changes nothing published
    const why = a.state !== "uploaded" ? `interrupted upload (state ${a.state}, no bytes)`
      : a.size !== f.size ? `size ${a.size} ≠ ${f.size}`
      : a.digest && a.digest !== `sha256:${f.sha256}` ? `digest ${String(a.digest).slice(0, 19)}… ≠ sha256:${f.sha256.slice(0, 12)}…`
      : null;
    if (why) bad.push({ id: a.id, name: f.name, why, bytes: a.state === "uploaded" });
    else if (!a.digest) out.unverified.push(f.name); // GitHub has no digest for it (yet): hash a download
  }
  const differing = bad.filter((b) => b.bytes);
  if (differing.length && !isDraft) {
    out.stop = `the PUBLISHED release has assets that differ from the staged bytes (never replaced automatically):\n`
      + differing.map((b) => `  ${b.name}: ${b.why}`).join("\n");
    return out;
  }
  for (const b of bad) { out.remove.push({ id: b.id, name: b.name, why: b.why }); out.upload.push(b.name); }
  return out;
}

/** The content type HOSTING.md serves a release path with. */
export const contentTypeOf = (rel) => (rel.endsWith(".json") || rel === "SHA256SUMS" ? "application/json" : "application/octet-stream");

/**
 * Compare an `rclone lsjson -R --files-only -M` listing with the staged files.
 * local: [{rel, size}]; listing: [{Path, Size, MimeType}]. Returns a list of problems ([] = good).
 */
export function checkR2Listing(local, listing) {
  const p = [];
  const remote = new Map(listing.map((o) => [o.Path, o]));
  for (const f of local) {
    const o = remote.get(f.rel);
    if (!o) { p.push(`missing on R2: ${f.rel}`); continue; }
    if (o.Size !== f.size) p.push(`${f.rel}: size ${o.Size} on R2, ${f.size} staged`);
    if (o.MimeType !== contentTypeOf(f.rel)) p.push(`${f.rel}: content type ${o.MimeType} on R2, ${contentTypeOf(f.rel)} expected`);
  }
  const names = new Set(local.map((f) => f.rel));
  for (const o of listing) if (!names.has(o.Path)) p.push(`on R2 but not staged: ${o.Path}`);
  return p;
}

/**
 * The GitHub release body: the pin, then (a release by reference) where its other files are, then
 * the record's notes.
 */
export function releaseBody(record) {
  const pin = `Toolchain release ${record.id}. Pin: --id ${record.id} --digest ${record.digest}. Contents and digests: release.json`;
  const n = splitFiles(record).own.filter((p) => p !== "release.json" && p !== "SHA256SUMS").length;
  const ref = record.base ? `Release by reference of ${record.base.id} (${record.base.digest}): this release's assets are its own files `
    + `(${ownLabel(record)}: ${n} file${n === 1 ? "" : "s"}), release.json and SHA256SUMS; every other file release.json lists is an asset of `
    + `${record.base.id} (lean4-wasm64 fetch takes them from there).` : "";
  const notes = (record.notes ?? []).map((n) => `- ${n}`).join("\n");
  return `${[pin, ref, notes].filter(Boolean).join("\n\n")}\n`;
}

// ---------- a release by reference (js/formats/release.md, "Release by reference") ----------

/**
 * The files this release's own GitHub release carries, and the ones it shares with its base — a
 * release by reference (release.json `base`): every file it does not own (isOwnPath: outside tools/
 * for a tools re-cut; outside runtime/, profiles/lean-lib.* and tools/ for a runtime release by
 * reference) is an asset of the base's release. Release-relative paths. A full record owns every
 * file. → {own: [paths], shared: [paths]}
 */
export function splitFiles(record) {
  const all = (record.files ?? []).map((f) => f.path);
  const own = record.base ? all.filter((p) => isOwnPath(record, p)) : all;
  return { own: ["release.json", "SHA256SUMS", ...own], shared: record.base ? all.filter((p) => !isOwnPath(record, p)) : [] };
}

/**
 * The R2 lists of a release by reference, each split by the content type HOSTING.md serves it with:
 * its shared paths (`objects`, `manifests`: a server-side copy keeps each object's), and its own
 * paths but release.json and SHA256SUMS (`ownObjects`, `ownManifests`: uploaded with that type).
 */
export function r2Lists(record) {
  const { own, shared } = splitFiles(record);
  const mine = own.filter((p) => p !== "release.json" && p !== "SHA256SUMS");
  const of = (paths, type) => paths.filter((p) => contentTypeOf(p) === type);
  return { objects: of(shared, "application/octet-stream"), manifests: of(shared, "application/json"),
    ownObjects: of(mine, "application/octet-stream"), ownManifests: of(mine, "application/json") };
}

/**
 * The rclone argv of each R2 pass, in order (HOSTING.md); every pass is `copy --immutable`, so an
 * object that differs is a stop, never overwritten. A full record, or `source` "local": the three
 * passes of a release dir — objects, then manifests + SHA256SUMS, then release.json. A release by
 * reference (`basePrefix`): the shared objects (`objectsList`), then the shared manifests
 * (`manifestsList`), copied server-side from the base's prefix (one remote: CopyObject; without -M
 * or --header-upload each object keeps its Content-Type), then its own objects (`ownObjectsList`)
 * and its own manifests (`ownManifestsList`, when it has any) from the staged dir, then SHA256SUMS
 * and release.json, last. Never the base's release.json or SHA256SUMS, nor a file it owns.
 */
export function r2Passes({ rel, dest, basePrefix = null, objectsList, manifestsList, ownObjectsList, ownManifestsList = null, source = "base" }) {
  const common = ["--immutable", "--s3-no-check-bucket", "--checksum"];
  const only = (filter, type) => ["copy", rel, dest, ...common, "--filter", filter, "--filter", "- *", "--header-upload", `Content-Type: ${type}`];
  if (!basePrefix || source === "local") return [
    ["copy", rel, dest, ...common, "--filter", "- *.json", "--filter", "- SHA256SUMS",
      "--header-upload", "Content-Type: application/octet-stream", "--transfers", "4", "--s3-chunk-size", "64M"],
    ["copy", rel, dest, ...common, "--filter", "- /release.json", "--filter", "+ *.json", "--filter", "+ /SHA256SUMS",
      "--filter", "- *", "--header-upload", "Content-Type: application/json"],
    only("+ /release.json", "application/json"),
  ];
  return [
    ["copy", basePrefix, dest, ...common, "--files-from-raw", objectsList, "--transfers", "8"],
    ["copy", basePrefix, dest, ...common, "--files-from-raw", manifestsList],
    ["copy", rel, dest, ...common, "--files-from-raw", ownObjectsList, "--header-upload", "Content-Type: application/octet-stream", "--transfers", "4", "--s3-chunk-size", "64M"],
    ...(ownManifestsList ? [["copy", rel, dest, ...common, "--files-from-raw", ownManifestsList, "--header-upload", "Content-Type: application/json"]] : []),
    only("+ /SHA256SUMS", "application/json"),
    only("+ /release.json", "application/json"),
  ];
}

/**
 * The base's GitHub release must serve every file a release by reference shares with it.
 * shared: [{path, bytes, sha256}] (its files[] it does not own); baseRelease: the base
 * tag's one release (null: none); baseAssets: its [{id, name, size, state, digest}];
 * baseRecordText: the base's release.json as its tag holds it. Problems: no release, a draft, a
 * shared basename (or release.json) missing, not "uploaded", of another size or another digest.
 * An asset GitHub has no digest for goes to `unverified` ({name, sha256}: hash a download).
 * → {problems, unverified}
 */
export function checkBaseAssets(shared, baseRelease, baseAssets, baseRecordText) {
  const problems = [], unverified = [];
  if (!baseRelease) return { problems: ["the base has no GitHub release"], unverified };
  if (baseRelease.draft) problems.push(`the base's release (id ${baseRelease.id}) is a draft: publish the base first`);
  const byName = new Map((baseAssets ?? []).map((a) => [a.name, a]));
  const want = shared.map((f) => ({ name: path.posix.basename(f.path), bytes: f.bytes, sha256: f.sha256 }));
  const text = Buffer.from(String(baseRecordText ?? ""), "utf8");
  want.push({ name: "release.json", bytes: text.length, sha256: createHash("sha256").update(text).digest("hex") });
  for (const w of want) {
    const a = byName.get(w.name);
    if (!a) problems.push(`missing: ${w.name}`);
    else if (a.state !== "uploaded") problems.push(`${w.name}: interrupted upload (state ${a.state}, no bytes)`);
    else if (a.size !== w.bytes) problems.push(`${w.name}: size ${a.size} ≠ ${w.bytes}`);
    else if (!a.digest) unverified.push({ name: w.name, sha256: w.sha256 });
    else if (a.digest !== `sha256:${w.sha256}`) problems.push(`${w.name}: digest ${String(a.digest).slice(0, 19)}… ≠ sha256:${w.sha256.slice(0, 12)}…${w.name === "release.json" ? " (not the record at the base's tag)" : ""}`);
  }
  return { problems, unverified };
}

/**
 * Judge `rclone check <staged dir> <prefix> --one-way --files-from-raw <shared> --combined <file> -vv`
 * (`log`: its log). Every shared path must be an "=" line, and no other line may appear. rclone also
 * says "=" (and exits 0) for an object whose MD5 it could not compare (R2 stores none for it), so an
 * "=" passes only with its debug line: "<path>: OK" (the MD5 compared) or "<path>: OK - could not
 * check hash" — then it is returned in `unhashed`, to be hashed from a download. An "=" with neither
 * (a log that went elsewhere, another format) or a count ("N hashes could not be checked") the log
 * does not account for is a problem: nothing passes unproven. → {problems, unhashed}
 */
export function checkR2Copy(combinedText, log, shared) {
  const problems = [];
  const want = new Set(shared);
  const equal = [], seen = new Set();
  const WHAT = { "+": "missing on R2", "-": "on R2 only", "*": "differs from the staged file", "!": "could not be read or hashed" };
  for (const line of String(combinedText ?? "").split("\n")) {
    if (!line.trim()) continue;
    const m = /^([=+*!-]) (.+)$/.exec(line);
    if (!m) { problems.push(`unexpected rclone check line: ${line}`); continue; }
    seen.add(m[2]);
    if (m[1] === "=" && want.has(m[2])) equal.push(m[2]);
    else problems.push(`${m[2]}: ${m[1] === "=" ? "checked, but not a shared file" : WHAT[m[1]]}`);
  }
  for (const p of shared) if (!seen.has(p)) problems.push(`${p}: not in the rclone check output`);
  const text = String(log ?? "");
  const compared = new Set(), noHash = new Set();
  for (const [, p, none] of text.matchAll(/ DEBUG : (.+?): OK( - could not check hash)?\s*$/gm)) (none ? noHash : compared).add(p);
  const unhashed = equal.filter((p) => noHash.has(p));
  const unproven = equal.filter((p) => !noHash.has(p) && !compared.has(p));
  if (unproven.length) problems.push(`rclone's log shows no hash comparison for ${unproven.length} "=" file(s): ${unproven.slice(0, 4).join(", ")}${unproven.length > 4 ? ", …" : ""}`);
  const count = Number(/(\d+) hashes? could not be checked/.exec(text)?.[1] ?? 0);
  if (count > unhashed.length) problems.push(`rclone could not check ${count} hash(es) and its log names ${unhashed.length}: the others cannot be told apart`);
  return { problems, unhashed };
}

/**
 * What the fetch step runs: null (nothing) | {only: null (every file) | "<groups>", deep: verify
 * --deep after it}. auto: every file and verify --deep for a full release; runtime,lists,tools for a
 * release by reference (its runtime: a tools re-cut's through the hop to its base's release, a
 * runtime release's from its own; the lists, always the base's: the hop to it; its own tgz from its
 * own). runtime: the runtime alone, plus lists and tools for a release by reference.
 */
export function fetchPlan(record, mode) {
  if (mode === "none") return null;
  const byRef = !!record?.base;
  if (mode === "full" || (mode === "auto" && !byRef)) return { only: null, deep: true };
  if (mode === "runtime" || mode === "auto") return { only: byRef ? "runtime,lists,tools" : "runtime", deep: false };
  throw new Error(`fetch check ${JSON.stringify(mode)}: auto | full | runtime | none`);
}

// ---------- effects ----------

function parseArgs(argv) {
  const o = { id: null, releaseDir: null, r2: process.env.LEAN4_WASM64_R2 || "qed64-r2:qed64-artifacts/lean4-wasm64",
    only: STEPS, r2Quick: false, r2Full: false, r2Source: "base", fetchCheck: "auto", yes: false, dryRun: false, help: false };
  const caller = process.env.LEAN4_WASM64_CALLER_CWD || process.cwd(); // import-release.sh cds to the repo
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "--release-dir") o.releaseDir = path.resolve(caller, val());
    else if (a === "--r2") o.r2 = val().replace(/\/+$/, "");
    else if (a === "--only") {
      o.only = val().split(",").filter(Boolean);
      if (!o.only.length) throw new Error(`--only: give at least one of ${STEPS.join(",")}`);
      const bad = o.only.filter((s) => !STEPS.includes(s));
      if (bad.length) throw new Error(`--only: unknown step(s) ${bad.join(", ")} (${STEPS.join(",")})`);
    }
    else if (a === "--r2-quick") o.r2Quick = true;
    else if (a === "--r2-full") o.r2Full = true;
    else if (a === "--r2-source") { o.r2Source = val(); if (!["base", "local"].includes(o.r2Source)) throw new Error("--r2-source: base | local"); }
    else if (a === "--fetch-check") { o.fetchCheck = val(); if (!["auto", "full", "runtime", "none"].includes(o.fetchCheck)) throw new Error("--fetch-check: auto | full | runtime | none"); }
    else if (a === "--yes") o.yes = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else if (!o.id) o.id = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (o.r2Quick && o.r2Full) throw new Error("--r2-quick and --r2-full exclude each other");
  return o;
}

function usage() {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
  const end = text.findIndex((l, i) => i > 1 && !l.startsWith("//"));
  return text.slice(1, end).map((l) => l.replace(/^\/\/ ?/, "")).join("\n");
}

/** A step that cannot continue; `code` 2 = usage or environment (a missing tool), 1 = everything else. */
class Stop extends Error { constructor(message, code = 1) { super(message); this.code = code; } }
const say = (s) => console.log(s);
const step = (s) => console.log(`\n== ${s}`);

function run(cmd, args, { capture = true, cwd = REPO, allowFail = false, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", input, stdio: capture ? ["pipe", "pipe", "pipe"] : "inherit", maxBuffer: 256 << 20,
    env: cmd === "git" && !process.env.DEVELOPER_DIR && fs.existsSync("/Library/Developer/CommandLineTools")
      ? { ...process.env, DEVELOPER_DIR: "/Library/Developer/CommandLineTools" } : process.env });
  if (r.error) {
    if (allowFail && r.error.code === "ENOENT") return { status: null, stdout: "", stderr: `${cmd}: not found` };
    throw new Stop(`${cmd}: ${r.error.message}`, r.error.code === "ENOENT" ? 2 : 1);
  }
  if (r.status !== 0 && !allowFail) throw new Stop(`${cmd} ${args.join(" ")} failed (exit ${r.status})${capture ? `:\n${(r.stderr || r.stdout || "").trim().slice(0, 2000)}` : ""}`);
  return r;
}
const git = (...args) => run("git", ["-C", REPO, ...args]).stdout.trim();
const gitOk = (...args) => run("git", ["-C", REPO, ...args], { allowFail: true }).status === 0;
const gitTry = (...args) => { const r = run("git", ["-C", REPO, ...args], { allowFail: true }); return r.status === 0 ? r.stdout : null; };
const ghJson = (endpoint) => JSON.parse(run("gh", ["api", "--paginate", "--slurp", endpoint]).stdout).flat();
const releaseAssets = (slug, id) => ghJson(`repos/${slug}/releases/${id}/assets?per_page=100`)
  .map((a) => ({ id: a.id, name: a.name, size: a.size, state: a.state, digest: a.digest ?? null }));
const short = (rev) => gitTry("log", "-1", "--format=%h %s", rev)?.trim() ?? rev;

/** Temp dirs of this run: removed on exit, but kept under --dry-run (the printed commands name files in them). */
const TEMPS = [];
function tempDir(prefix = "publish-release-") {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMPS.push(d);
  return d;
}
const writeList = (file, paths) => { fs.writeFileSync(file, paths.map((p) => `${p}\n`).join("")); return file; };

/** `rclone lsjson -R --files-only -M` of an R2 prefix; [] while the prefix does not exist. */
function r2Listing(prefix) {
  const r = run("rclone", ["lsjson", "-R", "--files-only", "-M", prefix], { allowFail: true });
  if (r.status === 0) return JSON.parse(r.stdout || "[]");
  if (r.status === 3 && /directory not found/i.test(r.stderr)) return []; // the prefix does not exist yet
  throw new Stop(`rclone lsjson ${prefix} failed (exit ${r.status}):\n${(r.stderr || "").trim().slice(0, 2000)}`);
}
/** SHA-256 of the objects under an R2 prefix, from a download (`listFile`: only those paths). → Map rel → hex */
function r2Sha256(prefix, listFile = null) {
  return new Map(run("rclone", ["hashsum", "sha256", "--download", "--checkers", "4", ...(listFile ? ["--files-from-raw", listFile] : []), prefix]).stdout
    .trim().split("\n").filter(Boolean).map((l) => { const i = l.indexOf("  "); return [l.slice(i + 2), l.slice(0, i)]; }));
}

async function ask(o, question) {
  if (o.yes || o.dryRun) return true;
  if (!process.stdin.isTTY) throw new Stop(`${question} — not a terminal: re-run with --yes`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((res) => rl.question(`${question} [y/N] `, res));
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

/** Run a command that changes something — or, with --dry-run, print it. */
function act(o, cmd, args, opts = {}) {
  const shown = [cmd, ...args].map((x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, "'\\''")}'`)).join(" ");
  if (o.dryRun) { say(`  would run: ${shown}`); return null; }
  say(`  $ ${shown}`);
  return run(cmd, args, { capture: false, ...opts });
}

function sha256File(file) {
  const h = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buf = Buffer.allocUnsafe(1 << 22);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest("hex");
}

function stagedFiles(rel) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) throw new Stop(`${p}: a symlink in the staged release`);
      if (e.isDirectory()) walk(p); else out.push({ rel: path.relative(rel, p), name: e.name, path: p, size: fs.statSync(p).size });
    }
  })(rel);
  return out;
}

const localTagObj = (id) => gitTry("rev-parse", "--verify", "-q", `refs/tags/${id}`)?.trim() || null;
const originTagObj = (id) => run("git", ["-C", REPO, "ls-remote", "origin", `refs/tags/${id}`]).stdout.trim().split(/\s+/)[0] || null;
/** The tag object GitHub (the release's repository) has for <id>, or null. */
function githubTagObj(slug, id) {
  const r = run("gh", ["api", `repos/${slug}/git/ref/tags/${id}`, "--jq", ".object.sha"], { allowFail: true });
  if (r.status === 0) return r.stdout.trim() || null;
  if (/HTTP 404|Not Found/i.test(r.stderr)) return null;
  throw new Stop(`gh api repos/${slug}/git/ref/tags/${id} failed (exit ${r.status}): ${(r.stderr || "").trim().slice(0, 500)}`, r.status === 4 ? 2 : 1);
}
/** The commit a tag on origin points at (peeled), or null. */
function originTagCommit(id) {
  const out = run("git", ["-C", REPO, "ls-remote", "origin", `refs/tags/${id}`, `refs/tags/${id}^{}`]).stdout.trim().split("\n").filter(Boolean)
    .map((l) => l.split(/\s+/));
  return (out.find(([, ref]) => ref.endsWith("^{}")) ?? out[0])?.[0] ?? null;
}
/** Make sure an object from origin is present locally WITHOUT creating any ref (FETCH_HEAD only). */
function haveObject(sha, ref) {
  if (gitOk("cat-file", "-e", `${sha}^{commit}`)) return;
  run("git", ["-C", REPO, "fetch", "-q", "--no-tags", "origin", ref]);
}
const isRecut = (id) => /-r\d+$/.test(id);
/**
 * A re-cut (<base>-rN) may be recorded and tagged off the line, on a branch cut from its base's
 * record commit (RELEASE.md): it needs the base tag on origin, the base on origin/<line>, and the
 * base under `tip`. Returns null when that holds, else the reason.
 */
function recutProblem(o, ctx, tip) {
  const base = o.id.replace(/-r\d+$/, "");
  const baseCommit = originTagCommit(base);
  if (!baseCommit) return `origin has no base tag ${base}`;
  haveObject(baseCommit, `refs/tags/${base}`);
  if (!gitOk("merge-base", "--is-ancestor", baseCommit, tip)) return `${tip} does not descend from ${base}`;
  if (!gitOk("merge-base", "--is-ancestor", baseCommit, `origin/${ctx.line}`)) return `${base} is not on origin/${ctx.line}`;
  return null;
}
/** The local tag holds the staged record and contains the kernel commit. */
function tagHoldsRecord(o, ctx, rev = `${o.id}^{commit}`) {
  const tagged = gitTry("show", `${rev}:${ctx.recordPath}`);
  const tools = ctx.record.tools?.commit;
  return tagged === ctx.recordText && gitOk("merge-base", "--is-ancestor", ctx.record.kernel.commit, rev)
    && (!tools || gitOk("merge-base", "--is-ancestor", tools, rev));
}

/**
 * When the local tag is missing but origin has it: check origin's tag holds the staged record (and
 * its kernel and tools commits), then fetch it — never mint a second one. Every step uses this, so
 * a run limited by --only works in a checkout without the tag, and --dry-run (which only reports
 * the fetch) plans exactly what the real run does. Returns true when the tag is (or would be) local.
 */
function adoptOriginTag(o, ctx) {
  if (localTagObj(o.id)) return true;
  const remote = originTagObj(o.id);
  if (!remote) return false;
  const commit = originTagCommit(o.id);
  haveObject(commit, `refs/tags/${o.id}`); // objects + FETCH_HEAD only, no ref
  if (!tagHoldsRecord(o, ctx, commit)) throw new Stop(`origin's tag ${o.id} does not hold the staged release.json (or lacks its kernel or tools commit)`);
  if (o.dryRun && ctx.adoptPlanned) return true; // a dry run reports the one fetch the real run makes, once
  say(`  origin has tag ${o.id} (${remote.slice(0, 10)}): the local checkout lacks it`);
  act(o, "git", ["-C", REPO, "fetch", "--no-tags", "origin", `refs/tags/${o.id}:refs/tags/${o.id}`]);
  ctx.adoptPlanned = true;
  return true;
}

/**
 * The precondition of every step that publishes bytes (github, r2): the release's tag holds the
 * staged record and GitHub has the same tag object — so a GitHub release can only attach to it
 * (never make GitHub create a tag) and nothing lands on R2 before the record is final. A tag
 * origin already has is adopted. With --dry-run, a gap the selected record/push steps would close
 * is reported and the step only plans (returns false); any other gap stops, as in the real run.
 */
function requireTagged(o, ctx) {
  const adopted = adoptOriginTag(o, ctx);
  const local = localTagObj(o.id) ?? (o.dryRun && adopted ? originTagObj(o.id) : null);
  const rev = localTagObj(o.id) ? `${o.id}^{commit}` : local ? originTagCommit(o.id) : null;
  const problem = !local ? { text: `tag ${o.id} does not exist locally`, closedBy: ["record", "push"] }
    : !tagHoldsRecord(o, ctx, rev) ? { text: `tag ${o.id} does not hold the staged record`, closedBy: null }
    : githubTagObj(ctx.slug, o.id) !== local ? { text: `GitHub (${ctx.slug}) does not have tag ${o.id} at ${local.slice(0, 10)}`, closedBy: ["push"] }
    : null;
  if (!problem) return true;
  if (o.dryRun && problem.closedBy?.every((s) => o.only.includes(s))) {
    say(`  (${problem.text} yet — the ${problem.closedBy.join(" and ")} ${problem.closedBy.length > 1 ? "steps come" : "step comes"} first; planning only)`);
    return false;
  }
  throw new Stop(`${problem.text}: run \`publish ${o.id} --only record,push\` first`);
}

// ---------- a release by reference: its base (read-only; preflight, then re-checked in the steps) ----------

/**
 * The base's record as the base's tag holds it (the local tag, which must be origin's, else
 * origin's, its objects fetched to FETCH_HEAD only as adoptOriginTag does) — never what a mirror or
 * the staged dir says. It must be canonical and pass checkRecutBase with the staged record, which
 * also checks it whole and pinned by base.{id, digest}. → {record, text, where}
 */
function baseRecordAtTag(o, record) {
  const id = record.base.id;
  const recordPath = `wasm64-build/releases/${id}.json`;
  const local = localTagObj(id), remote = originTagObj(id);
  if (!remote) throw new Stop(`origin has no tag ${id}: a release by reference needs its base published first`);
  if (local && local !== remote) throw new Stop(`the local tag ${id} (${local.slice(0, 10)}) is not origin's (${remote.slice(0, 10)})`);
  let rev = `refs/tags/${id}`;
  if (!local) { rev = originTagCommit(id); haveObject(rev, `refs/tags/${id}`); }
  const where = `${recordPath} at ${local ? "" : "origin's "}tag ${id}`;
  const text = gitTry("show", `${rev}:${recordPath}`);
  if (text === null) throw new Stop(`the base's record is not at its tag: no ${where}`);
  let base;
  try { base = JSON.parse(text); } catch (e) { throw new Stop(`${where} is not JSON: ${e.message}`); }
  if (serializeRelease(base) !== text) throw new Stop(`${where} is not in canonical form (serializeRelease)`);
  const problems = checkRecutBase(record, base);
  if (problems.length) throw new Stop(`${o.id} is not a release by reference of ${where}:\n  ${problems.slice(0, 20).join("\n  ")}${problems.length > 20 ? `\n  … ${problems.length - 20} more` : ""}`);
  return { record: base, text, where };
}

/**
 * The base's GitHub release serves every file the release shares with it, and the base's record
 * (checkBaseAssets). `hash`: an asset GitHub has no digest for is hashed from a download (--dry-run
 * reports it); otherwise (a re-check) only the problems count.
 */
function checkBaseRelease(o, ctx, { hash }) {
  const { base, slug } = ctx;
  const choice = chooseRelease(ghJson(`repos/${slug}/releases?per_page=100`), base.id, slug);
  if (choice.action === "stop") throw new Stop(`the base's GitHub release: ${choice.reason}`);
  const release = choice.release ?? null;
  const { problems, unverified } = checkBaseAssets(base.sharedFiles, release, release ? releaseAssets(slug, release.id) : [], base.text);
  if (problems.length) {
    throw new Stop(`the base's GitHub release ${base.id} does not serve the files ${o.id} shares with it:\n  ${problems.slice(0, 20).join("\n  ")}`
      + `${problems.length > 20 ? `\n  … ${problems.length - 20} more` : ""}`);
  }
  const what = `base release ${base.id} (id ${release.id}): its ${base.shared.length} shared assets and its release.json`;
  if (!unverified.length) { say(`  ${what}, each by size and SHA-256`); return; }
  // a re-check: preflight hashed the ones without a digest — a dry run's preflight only reported them
  if (!hash) { say(`  ${what}, by size and SHA-256 (${unverified.length} without a GitHub digest: ${o.dryRun ? "the real run hashes them in preflight" : "hashed in preflight"})`); return; }
  const names = `${unverified.slice(0, 8).map((u) => u.name).join(", ")}${unverified.length > 8 ? ", …" : ""}`;
  if (o.dryRun) { say(`  ${what}, by size; ${unverified.length} have no GitHub digest — the real run hashes a download of each: ${names}`); return; }
  say(`  hashing ${unverified.length} base assets GitHub has no digest for (a download)…`);
  const dir = tempDir();
  for (const u of unverified) {
    const file = path.join(dir, u.name);
    run("gh", ["release", "download", base.id, "--repo", slug, "--pattern", u.name, "--output", file]);
    const same = sha256File(file) === u.sha256;
    fs.rmSync(file, { force: true });
    if (!same) throw new Stop(`the base's asset ${u.name}: its bytes are not the ones release.json names`);
  }
  say(`  ${what}, by size and SHA-256 (${unverified.length} from a download)`);
}

/** The base's R2 prefix holds every shared object (name, size, content type) and the base's record (--r2-source base). */
function checkBasePrefix(o, ctx) {
  const { base } = ctx;
  const want = new Set(base.shared);
  const problems = checkR2Listing(base.sharedFiles.map((f) => ({ rel: f.path, size: f.bytes })), r2Listing(base.prefix).filter((x) => want.has(x.Path)));
  if (problems.length) {
    throw new Stop(`the base's R2 prefix ${base.prefix} cannot be copied from:\n  ${problems.slice(0, 20).join("\n  ")}${problems.length > 20 ? `\n  … ${problems.length - 20} more` : ""}\n`
      + `  \`publish ${base.id} --only r2\` uploads what is missing there; or publish ${o.id} with --r2-source local (its shared files from the staged dir)`);
  }
  const cat = run("rclone", ["cat", `${base.prefix}release.json`], { allowFail: true });
  if (cat.status !== 0) throw new Stop(`rclone cat ${base.prefix}release.json failed (exit ${cat.status}):\n${(cat.stderr || "").trim().slice(0, 1000)}`);
  if (cat.stdout !== base.text) throw new Stop(`${base.prefix}release.json is not the base's record at its tag (${base.where})`);
  say(`  base prefix ${base.prefix}: its ${want.size} shared objects (names, sizes, content types) and its release.json`);
}

/**
 * The shared files on an R2 prefix are the staged bytes — the staged dir is the reference, not the
 * base's prefix: `rclone check` compares the staged files' MD5 with the one R2 stores (nothing is
 * downloaded); an object R2 has no MD5 for is hashed from a download (--dry-run reports it).
 */
function r2CheckShared(o, ctx, prefix, label) {
  const { base } = ctx;
  const combined = path.join(base.lists.dir, `check-${label}.txt`), logFile = path.join(base.lists.dir, `check-${label}.log`);
  for (const f of [combined, logFile]) fs.rmSync(f, { force: true });
  // its own log file: the debug lines that prove each comparison, wherever the environment sends rclone's log
  const r = run("rclone", ["check", ctx.rel, prefix, "--one-way", "--files-from-raw", base.lists.shared, "--combined", combined,
    "-vv", "--log-file", logFile], { allowFail: true });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
  const text = read(combined), logText = `${read(logFile)}${r.stderr || ""}`;
  // exit 1: differences (named in the combined report); anything else is no answer
  const { problems, unhashed } = r.status === 0 || r.status === 1 ? checkR2Copy(text, logText, base.shared) : { problems: [`rclone check exited ${r.status}`], unhashed: [] };
  if (problems.length) {
    const log = logText.split("\n").filter((l) => l.trim() && !/ DEBUG : /.test(l)).slice(-6).join("\n");
    const way = label === "base" ? `publish with --r2-source local (its shared files from ${ctx.rel}, the base's prefix unread)`
      : "--r2-full checks every object by its SHA-256 instead";
    throw new Stop(`the shared files on ${prefix} are not the staged bytes (rclone check, exit ${r.status}):\n  ${problems.slice(0, 20).join("\n  ")}`
      + `${problems.length > 20 ? `\n  … ${problems.length - 20} more` : ""}${log ? `\n${log}` : ""}`
      + (problems.every((q) => /could not check .* hash|no hash comparison/.test(q)) ? `\n  ${way}` : ""));
  }
  const n = base.shared.length;
  if (!unhashed.length) { say(`  rclone check (MD5, nothing downloaded): the ${n} shared files on ${prefix} are the staged bytes`); return; }
  say(`  rclone check (MD5): ${n - unhashed.length} of the ${n} shared files on ${prefix} are the staged bytes; R2 holds no MD5 for ${unhashed.length}`);
  const names = `${unhashed.slice(0, 8).join(", ")}${unhashed.length > 8 ? ", …" : ""}`;
  if (o.dryRun) { say(`  (dry run: the real run hashes a download of each: ${names})`); return; }
  const sums = r2Sha256(prefix, writeList(path.join(base.lists.dir, `unhashed-${label}.txt`), unhashed));
  const bad = unhashed.filter((p) => sums.get(p) !== sha256File(path.join(ctx.rel, ...p.split("/"))));
  if (bad.length) throw new Stop(`R2 bytes on ${prefix} differ from the staged release: ${bad.slice(0, 10).join(", ")}`);
  say(`  verified: those ${unhashed.length} by their SHA-256 (a download)`);
}

/**
 * The reader this release ships: its staged tools tgz, unpacked into a temp dir (the fetch step runs
 * it), must be tools.package@tools.version, and its own `verify` must pass the staged dir (--base for
 * a release by reference). Local and read-only, so preflight runs it — dry run included — before
 * anything is pushed or published: a release whose own tools cannot read it is never made.
 * → {dir, cli} | null (release.json names no tools tgz)
 */
function checkTools(ctx) {
  const tools = ctx.record.tools;
  if (!tools?.tgz) { say("  (release.json names no tools tgz: this working tree's lean4-wasm64 is the fetch check's reader)"); return null; }
  const dir = tempDir("publish-release-tools-");
  run("tar", ["-xzf", path.join(ctx.rel, ...tools.tgz.split("/")), "-C", dir]);
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package", "package.json"), "utf8")); } catch { /* named below */ }
  if (pkg?.name !== tools.package || pkg?.version !== tools.version) {
    throw new Stop(`${tools.tgz} is not ${tools.package}@${tools.version} (its package/package.json: ${pkg ? `${pkg.name}@${pkg.version}` : "none"})`);
  }
  const cli = path.join(dir, "package", "cli.mjs");
  const v = run("node", [cli, "verify", "--release", ctx.rel, ...(ctx.base ? ["--base", ctx.base.file] : [])], { allowFail: true });
  if (v.status !== 0 || !/RELEASE VERIFIED/.test(v.stdout)) {
    throw new Stop(`the reader ${tools.tgz} ships does not verify ${ctx.rel} (its own cli.mjs verify${ctx.base ? " --base" : ""}):\n`
      + `${`${v.stdout ?? ""}${v.stderr ?? ""}`.trim().split("\n").slice(-12).join("\n")}`);
  }
  say(`  the reader it ships: ${tools.package}@${tools.version} from the staged ${tools.tgz} — its own verify${ctx.base ? " --base" : ""}: RELEASE VERIFIED`);
  return { dir, cli };
}

// ---------- the steps ----------

function preflight(o) {
  step(`preflight ${o.id}`);
  if (!RELEASE_ID.test(o.id)) throw new Stop(`${o.id} is not a release id (lean-vX.Y.Z-<kernel7>[-rN])`, 2);
  const rel = o.releaseDir ?? path.resolve(REPO, "..", "wasm64-lean-kernel-release", o.id);
  if (!fs.existsSync(path.join(rel, "release.json"))) throw new Stop(`${rel}/release.json not found — stage it first (import-release.sh release …)`);
  const recordText = fs.readFileSync(path.join(rel, "release.json"), "utf8");
  const record = JSON.parse(recordText);
  if (record.id !== o.id) throw new Stop(`${rel}/release.json is ${record.id}, not ${o.id}`);
  if (releaseDigest(record) !== record.digest) throw new Stop(`${rel}/release.json: its digest field does not match its content`);
  const slug = repoSlug(record.kernel?.repo);
  if (!slug) throw new Stop(`release.json kernel.repo ${record.kernel?.repo} is not a github.com repository`);
  const line = record.kernel.branch;
  // a release by reference: its base is read (gh, and rclone unless --r2-source local) whatever --only is
  const byRef = record.base !== undefined;
  const needs = { gh: true, git: true, rclone: o.only.includes("r2") || (byRef && o.r2Source === "base") };
  for (const [tool, args] of [["gh", ["--version"]], ["git", ["--version"]], ["rclone", ["version"]]]) {
    if (needs[tool] && run(tool, args, { allowFail: true }).status !== 0) throw new Stop(`${tool} is not available (not on PATH, or failing)`, 2);
  }
  if (gitTry("rev-parse", "--is-shallow-repository")?.trim() === "true") {
    throw new Stop("this checkout is shallow: git fetch --unshallow --tags origin (GitHub Actions: actions/checkout with fetch-depth: 0)", 2);
  }
  if (o.only.includes("github") || o.only.includes("r2") || byRef) { // all read through gh: the tag, the base's release
    const auth = run("gh", ["auth", "status", "--hostname", "github.com", "--active"], { allowFail: true });
    if (auth.status !== 0) throw new Stop(`gh is not logged in to github.com: ${(auth.stderr || auth.stdout).trim().split("\n").slice(0, 4).join(" / ")}`, 2);
  }
  if (o.only.includes("github")) {
    const push = run("gh", ["api", `repos/${slug}`, "--jq", ".permissions.push"], { allowFail: true });
    if (push.stdout.trim() !== "true") throw new Stop(`the gh account cannot push to ${slug} (no release rights)`, 2);
  }
  if (needs.rclone) {
    const remote = o.r2.split(":")[0] + ":";
    if (!run("rclone", ["listremotes"]).stdout.split("\n").includes(remote)) throw new Stop(`rclone has no remote ${remote} (rclone config)`, 2);
  }
  const ctx = { rel, record, recordText, slug, line, recordPath: `wasm64-build/releases/${o.id}.json`, base: null, tools: null };
  if (byRef) {
    // before anything reads base.id: the record's own structure (S1-S6: base.id is a first cut of its tag)
    const problems = checkReleaseRecord(record);
    if (problems.length) throw new Stop(`${rel}/release.json is malformed:\n  ${problems.slice(0, 12).join("\n  ")}`);
    const at = baseRecordAtTag(o, record);
    const dir = tempDir();
    const { own, shared } = splitFiles(record);
    const { objects, manifests, ownObjects, ownManifests } = r2Lists(record);
    const lists = { dir, own: writeList(path.join(dir, "own.txt"), own), shared: writeList(path.join(dir, "shared.txt"), shared),
      objects: writeList(path.join(dir, "shared.objects"), objects), manifests: writeList(path.join(dir, "shared.manifests"), manifests),
      ownObjects: writeList(path.join(dir, "own.objects"), ownObjects),
      ownManifests: ownManifests.length ? writeList(path.join(dir, "own.manifests"), ownManifests) : null };
    const file = path.join(dir, "base", "release.json"); // verify --base, here and in the fetch step
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, at.text);
    ctx.base = {
      id: record.base.id, digest: record.base.digest, record: at.record, text: at.text, where: at.where, file,
      prefix: `${o.r2}/${record.base.id}/`, own, shared, sharedFiles: record.files.filter((f) => !isOwnPath(record, f.path)), lists,
    };
  }
  // the staged bytes are what will be published: check them whole before anything else
  const v = run("node", [path.join(JS, "verify-release.mjs"), "--release", rel, ...(ctx.base ? ["--base", ctx.base.file] : [])], { allowFail: true });
  if (v.status !== 0 || !/RELEASE VERIFIED/.test(v.stdout)) throw new Stop(`verify-release failed for ${rel}:\n${(v.stdout + v.stderr).trim().split("\n").slice(-12).join("\n")}`);
  say(`  ${rel}: RELEASE VERIFIED (digest ${record.digest}), ${record.files?.length ?? "?"} recorded files`);
  ctx.tools = checkTools(ctx); // the reader it ships must read it too: checked here, run again by the fetch step
  say(`  github ${slug}, line ${line}, kernel ${record.kernel.commit.slice(0, 10)} (patch ${record.kernel.patch})`);
  if (ctx.base) {
    const { base } = ctx;
    say(`  by reference of ${base.id} (${base.digest.slice(0, 23)}…): ${base.own.length} own, ${base.shared.length} shared — the base's record from ${base.where}, compared`);
    // every read-only check of the base, before any step can push or publish anything
    checkBaseRelease(o, ctx, { hash: true });
    if (o.r2Source === "base") {
      checkBasePrefix(o, ctx);
      r2CheckShared(o, ctx, base.prefix, "base");
    } else say(`  --r2-source local: the base's R2 prefix is not read; the shared files go up from ${rel}`);
  }
  return ctx;
}

async function stepRecord(o, ctx) {
  step("record: the committed record and its tag");
  const { record, recordText, recordPath, line } = ctx;
  if (!localTagObj(o.id)) {
    if (adoptOriginTag(o, ctx)) {
      // published from another checkout (or before an interruption): that tag was taken, not a second one made
      if (o.dryRun) return;
    } else {
      const head = gitTry("symbolic-ref", "-q", "HEAD")?.trim() ?? null;
      if (!head) throw new Stop(`HEAD is detached: check out ${line} (or, for a re-cut, the branch it was staged from) first`);
      run("git", ["-C", REPO, "fetch", "-q", "--no-tags", "origin", line]);
      if (head !== `refs/heads/${line}`) {
        // only a re-cut may be recorded off the line, on a branch cut from its base (RELEASE.md)
        const why = isRecut(o.id) ? recutProblem(o, ctx, "HEAD") : "only a re-cut (-rN) may be recorded off the line";
        if (why) throw new Stop(`HEAD is ${head}: the record commit and the tag belong on ${line} (${why}) — check out ${line} first`);
        say(`  re-cut on ${head.replace("refs/heads/", "")} (descends from its base, which is on origin/${line})`);
      } else if (!gitOk("merge-base", "--is-ancestor", `origin/${line}`, "HEAD")) {
        throw new Stop(`the local ${line} is behind or diverged from origin/${line}: \`git pull --ff-only\` (or rebase) first, then re-run`);
      }
      const tools = record.tools?.commit;
      if (tools && !gitOk("merge-base", "--is-ancestor", tools, "HEAD")) {
        const where = gitTry("branch", "--format=%(refname:short)", "--contains", tools)?.trim().split("\n").filter(Boolean).join(", ") || "no local branch";
        throw new Stop(isRecut(o.id)
          ? `HEAD does not contain tools commit ${tools.slice(0, 10)} the record names: check out the branch the re-cut was staged from (${where})`
          : `tools commit ${tools.slice(0, 10)} (where ${o.id} was staged; on: ${where}) is not on ${line}: bring that branch onto ${line} (\`git merge --ff-only <branch>\` on ${line}) and re-run — or re-stage from ${line}`);
      }
      const atHead = gitTry("show", `HEAD:${recordPath}`);
      let target;
      if (atHead === null) {
        const wtPath = path.join(REPO, recordPath);
        const wt = fs.existsSync(wtPath) ? fs.readFileSync(wtPath, "utf8") : null;
        const idx = gitTry("show", `:${recordPath}`);
        if ((wt !== null && wt !== recordText) || (idx !== null && idx !== recordText)) {
          throw new Stop(`${recordPath} (working tree or index) differs from the staged release.json: \`git -C ${REPO} restore --staged --worktree ${recordPath}\` or remove it, then re-run`);
        }
        if (!o.dryRun && wt === null) { fs.mkdirSync(path.dirname(wtPath), { recursive: true }); fs.writeFileSync(wtPath, recordText); }
        act(o, "git", ["-C", REPO, "add", recordPath]);
        act(o, "git", ["-C", REPO, "commit", "-m", `release ${o.id}`, "--", recordPath]);
        target = o.dryRun ? null : git("rev-parse", "HEAD");
      } else if (atHead !== recordText) {
        throw new Stop(`${recordPath} at HEAD differs from the staged release.json — the staged release changed after it was recorded`);
      } else {
        target = git("log", "-1", "--format=%H", "--", recordPath); // the commit that added the record, not HEAD
        say(`  ${recordPath} is committed in ${short(target)}${target !== git("rev-parse", "HEAD") ? " (HEAD has moved past it: the tag goes on the record commit)" : ""}`);
        // tag it only if the push step will accept it: the same plan, before anything is made
        try { pushPlan(o, ctx, { tip: target, remoteTag: null }); } catch (e) {
          if (!(e instanceof Stop)) throw e;
          throw new Stop(`the record commit ${short(target)} could not be pushed as it stands — ${e.message}`
            + (isRecut(o.id) ? "" : ` (or \`git rebase origin/${line}\` to re-create the record commit, then re-run)`));
        }
      }
      act(o, "git", ["-C", REPO, "tag", "-a", o.id, "-m", `lean4-wasm64 ${o.id} (${record.digest})`, ...(target ? [target] : [])]);
      if (o.dryRun) { say(`  (the tag would go on ${target ? short(target) : "the new record commit"})`); return; }
    }
  } else say(`  tag ${o.id} exists`);
  if (!tagHoldsRecord(o, ctx)) throw new Stop(`tag ${o.id} does not hold the staged release.json at ${recordPath}, or lacks its kernel or tools commit — a local-only tag can be removed with \`git tag -d ${o.id}\``);
  say(`  tag ${o.id} → ${short(`${o.id}^{commit}`)} holds the staged record`);
}

/**
 * What pushing <id> means, from the state alone — shared by the real run and --dry-run so the two
 * cannot disagree. `tip` is the commit to tag (or HEAD when the record commit is still to be made:
 * `pending`); `remoteTag` origin's tag object. Returns {refs, adds, note}; throws Stop.
 */
function pushPlan(o, ctx, { tip, remoteTag, pending = false }) {
  const { line } = ctx;
  const onLine = !pending && gitOk("merge-base", "--is-ancestor", tip, `origin/${line}`);
  const onLocalLine = pending ? gitTry("symbolic-ref", "-q", "HEAD")?.trim() === `refs/heads/${line}` : gitOk("merge-base", "--is-ancestor", tip, `refs/heads/${line}`);
  const ff = gitOk("merge-base", "--is-ancestor", `origin/${line}`, tip);
  const tagRef = pending ? "<record commit>" : tip;
  const plan = { refs: [], adds: "", note: "" };
  if (!onLine) {
    if (isRecut(o.id) && !(onLocalLine && ff)) {
      // a re-cut recorded off the line (on a branch from its base): its tag alone is pushed, the line stays
      const why = recutProblem(o, ctx, tip);
      if (why) throw new Stop(`re-cut ${o.id} is off ${line} and ${why}`);
      plan.note = `re-cut off its base: only the tag is pushed (${line} stays as it is)`;
    } else if (ff) {
      // a fast-forward of the line — only to commits the local line already holds
      if (!onLocalLine) throw new Stop(`${pending ? "HEAD" : `tag ${o.id} (${short(tip)})`} is not on the local ${line}: pushing it would put another branch's commits on the line`);
      plan.refs.push(`${tagRef}:refs/heads/${line}`);
      plan.adds = (pending ? `(new) release ${o.id}\n` : "") + git("log", "--oneline", `origin/${line}..${tip}`);
    } else {
      const merged = onLocalLine && gitOk("merge-base", "--is-ancestor", `origin/${line}`, `refs/heads/${line}`);
      throw new Stop(`origin/${line} is not an ancestor of ${pending ? "HEAD" : short(tip)}: the line moved elsewhere — `
        + (merged ? `the local ${line} holds origin's work (a merge): \`git push origin ${line}\` first, then re-run`
          : !remoteTag && !pending ? `reconcile it by hand; the tag exists only locally (\`git tag -d ${o.id}\`, then re-run to record it again)`
          : "reconcile it by hand"));
    }
  }
  if (!remoteTag) plan.refs.push(`refs/tags/${o.id}`);
  return plan;
}

async function stepPush(o, ctx) {
  const { line, recordPath } = ctx;
  step(`push: the tag, and ${line} up to it`);
  const tagObj = localTagObj(o.id);
  const remoteTag = originTagObj(o.id);
  if (tagObj && remoteTag && remoteTag !== tagObj) throw new Stop(`origin has tag ${o.id} at ${remoteTag}, not ${tagObj} — never moved automatically`);
  run("git", ["-C", REPO, "fetch", "-q", "--no-tags", "origin", line]);
  let plan;
  if (tagObj) plan = pushPlan(o, ctx, { tip: git("rev-parse", `${o.id}^{commit}`), remoteTag });
  else if (remoteTag) { // origin has it: adopt it (dry run: report the fetch) and plan against it
    adoptOriginTag(o, ctx);
    plan = pushPlan(o, ctx, { tip: originTagCommit(o.id), remoteTag });
  } else if (!o.dryRun || !o.only.includes("record")) throw new Stop(`tag ${o.id} does not exist (run the record step)`);
  else { // nobody has the tag yet: the record step tags the record commit, or a new one on HEAD
    const recorded = gitTry("show", `HEAD:${recordPath}`) !== null;
    plan = pushPlan(o, ctx, recorded ? { tip: git("log", "-1", "--format=%H", "--", recordPath), remoteTag: null } : { tip: "HEAD", remoteTag: null, pending: true });
  }
  if (plan.note) say(`  ${plan.note}`);
  if (!plan.refs.length) { say(`  origin has tag ${o.id}${plan.note ? "" : ` and ${line} contains it`}`); return; }
  if (plan.adds) say(`  ${line} would gain:\n${plan.adds.split("\n").filter(Boolean).map((l) => `    ${l}`).join("\n")}`);
  if (!(await ask(o, `push ${plan.refs.join(" ")} to origin?`))) throw new Stop("push declined");
  act(o, "git", ["-C", REPO, "push", "--atomic", "origin", ...plan.refs]); // the line and the tag together, or neither
}

async function stepGithub(o, ctx) {
  step(`github: release ${o.id} on ${ctx.slug}`);
  const tagged = requireTagged(o, ctx);
  // a release by reference: its base's release must still serve the shared files (re-checked), and
  // only its own files go on its release
  if (ctx.base) checkBaseRelease(o, ctx, { hash: false });
  const own = ctx.base ? new Set(ctx.base.own) : null;
  const files = stagedFiles(ctx.rel).filter((f) => !own || own.has(f.rel.split(path.sep).join("/")));
  if (own) {
    const missing = [...own].filter((p) => !files.some((f) => f.rel.split(path.sep).join("/") === p));
    if (missing.length) throw new Stop(`the staged release lacks its own files: ${missing.join(", ")}`);
    say(`  a release by reference: its ${files.length} own files (${ownLabel(ctx.record)}, release.json, SHA256SUMS) go on its release; the other ${ctx.base.shared.length} are assets of ${ctx.base.id}`);
  }
  const dup = files.map((f) => f.name).filter((n, i, all) => all.indexOf(n) !== i);
  if (dup.length) throw new Stop(`GitHub assets are flat: these basenames repeat: ${[...new Set(dup)].join(", ")}`);
  say(`  hashing ${files.length} staged files…`);
  for (const f of files) f.sha256 = sha256File(f.path);
  const releases = () => ghJson(`repos/${ctx.slug}/releases?per_page=100`);
  let choice = chooseRelease(releases(), o.id, ctx.slug);
  if (choice.action === "stop") throw new Stop(choice.reason);
  if (choice.action === "create") {
    const notes = path.join(tempDir(), "notes.md");
    fs.writeFileSync(notes, releaseBody(ctx.record));
    act(o, "gh", ["release", "create", o.id, "--repo", ctx.slug, "--draft", "--verify-tag", "--title", `lean4-wasm64 ${o.id}`, "--notes-file", notes]);
    if (o.dryRun) { say(`  (then upload ${files.length} files, verify each, publish)`); return; }
    choice = await relisted(() => chooseRelease(releases(), o.id, ctx.slug), (c) => c.action !== "create");
    if (choice.action !== "use") throw new Stop(choice.reason ?? "GitHub does not list the new draft after 30 s; re-run later: the re-run adopts it once it is listed");
  }
  let rel = choice.release;
  say(`  release id ${rel.id}: ${rel.draft ? "draft" : "published"}`);
  const assets = () => releaseAssets(ctx.slug, rel.id);
  let plan = planAssets(files, assets(), rel.draft, ctx.slug);
  if (plan.stop) {
    throw new Stop(plan.stop + (ctx.base && rel.draft ? `\n  (a release by reference's release carries its ${files.length} own files only: a draft filled by the by-value fallback is emptied first)` : ""));
  }
  for (const r of plan.remove) {
    say(`  re-uploading ${r.name} (${r.why})`);
    act(o, "gh", ["api", "-X", "DELETE", `repos/${ctx.slug}/releases/assets/${r.id}`]);
  }
  if (plan.upload.length) {
    say(`  uploading ${plan.upload.length} of ${files.length} files`);
    const byName = new Map(files.map((f) => [f.name, f.path]));
    for (let i = 0; i < plan.upload.length; i += UPLOAD_BATCH) {
      act(o, "gh", ["release", "upload", o.id, "--repo", ctx.slug, ...plan.upload.slice(i, i + UPLOAD_BATCH).map((n) => byName.get(n))]);
    }
  } else say(`  all ${files.length} files are on the release`);
  if (o.dryRun && (plan.upload.length || plan.remove.length)) say("  (then verify each asset by its SHA-256)"); // nothing uploaded yet
  else {
    // verify: every asset uploaded, by its SHA-256 (GitHub's digest; a download when it has none)
    plan = planAssets(files, assets(), rel.draft, ctx.slug);
    if (plan.stop || plan.upload.length) throw new Stop(plan.stop ?? `still missing or broken after the upload: ${plan.upload.slice(0, 8).join(", ")}`);
    for (const name of plan.unverified) {
      const f = files.find((x) => x.name === name);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-release-"));
      try {
        run("gh", ["release", "download", o.id, "--repo", ctx.slug, "--pattern", name, "--output", path.join(dir, name)]);
        if (sha256File(path.join(dir, name)) !== f.sha256) throw new Stop(`${name}: the uploaded bytes differ from the staged file`);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    say(`  verified: ${files.length} assets, each uploaded with the staged SHA-256`);
  }
  if (rel.draft) {
    if (!tagged) { say("  (would publish the draft once the tag is on GitHub)"); return; }
    if (!(await ask(o, `publish GitHub release ${o.id} (draft → public)?`))) throw new Stop("publish declined: the draft stays a draft");
    if (!o.dryRun) requireTagged(o, ctx); // the tag on GitHub is still ours, at the moment that cannot be undone
    act(o, "gh", ["release", "edit", o.id, "--repo", ctx.slug, "--tag", o.id, "--verify-tag", "--draft=false"]);
    if (o.dryRun) return;
    rel = (await relisted(() => chooseRelease(releases(), o.id, ctx.slug), (c) => c.release && !c.release.draft)).release;
    if (!rel || rel.draft) throw new Stop("GitHub still lists the release as a draft 30 s after the edit; re-run to check it");
  }
  say(`  published: https://github.com/${ctx.slug}/releases/tag/${o.id}`);
}

async function stepR2(o, ctx) {
  const dest = `${o.r2}/${o.id}/`;
  step(`r2: ${dest}`);
  const tagged = requireTagged(o, ctx);
  const { base } = ctx;
  // a release by reference copies its shared files from the base's prefix: re-checked here (dry run too)
  const fromBase = !!base && o.r2Source === "base";
  if (fromBase) checkBasePrefix(o, ctx);
  const files = stagedFiles(ctx.rel); // complete for a release by reference too: its prefix is
  const before = checkR2Listing(files, r2Listing(dest));
  const foreign = before.filter((p) => !p.startsWith("missing on R2:"));
  if (foreign.length) throw new Stop(`R2 holds objects that differ from the staged release (never overwritten):\n  ${foreign.slice(0, 20).join("\n  ")}`);
  if (before.length === 0) say(`  already complete: ${files.length} objects, sizes and content types match`);
  else {
    say(`  ${files.length - before.length} of ${files.length} objects present; copying the rest`
      + (fromBase ? ` (the ${base.shared.length} shared ones server-side from ${base.prefix})` : base ? " (the shared ones from the staged dir: --r2-source local)" : ""));
    if (!tagged) { say("  (would copy them once the tag is on GitHub)"); return; }
    // objects, then manifests + SHA256SUMS, then release.json: a reader that finds release.json finds everything.
    // Every pass is `copy --immutable` (copyto would replace a different release.json); never sync.
    const passes = r2Passes({ rel: ctx.rel, dest, basePrefix: fromBase ? base.prefix : null, objectsList: base?.lists.objects,
      manifestsList: base?.lists.manifests, ownObjectsList: base?.lists.ownObjects, ownManifestsList: base?.lists.ownManifests, source: o.r2Source });
    for (const args of passes) act(o, "rclone", args);
  }
  if (o.dryRun) {
    const how = o.r2Quick ? "no hashing (--r2-quick)" : !base || o.r2Full ? "the hashing is skipped: every object's SHA-256 (a download)"
      : `the hashing is skipped: its ${base.own.length} own objects' SHA-256 (a download), then an rclone check (MD5) of the ${base.shared.length} shared ones against ${ctx.rel}`;
    say(`  (dry run: ${before.length === 0 ? "the listing is checked" : "then the listing is checked"}; ${how})`);
    return;
  }
  const problems = checkR2Listing(files, r2Listing(dest));
  if (problems.length) throw new Stop(`R2 does not match the staged release:\n  ${problems.slice(0, 20).join("\n  ")}`);
  say(`  listing: ${files.length} objects, sizes and content types match`);
  if (o.r2Quick) return;
  if (!base || o.r2Full) {
    say(`  hashing every R2 object (downloads ~${(files.reduce((s, f) => s + f.size, 0) / 1e9).toFixed(1)} GB)…`);
    const sums = r2Sha256(dest);
    const bad = files.filter((f) => sums.get(f.rel) !== sha256File(f.path)).map((f) => f.rel);
    if (bad.length) throw new Stop(`R2 bytes differ from the staged release: ${bad.slice(0, 10).join(", ")}`);
    say(`  verified: every R2 object has the staged SHA-256`);
    return;
  }
  // a release by reference: its own files by SHA-256 (a download: ~100 KB for a tools re-cut, its
  // runtime and lean-lib too for a runtime release, ~700 MB), the shared ones by MD5 against the
  // staged dir (whose every file the preflight verify hashed against the record)
  const sums = r2Sha256(dest, base.lists.own);
  const bad = base.own.filter((p) => sums.get(p) !== sha256File(path.join(ctx.rel, ...p.split("/"))));
  if (bad.length) throw new Stop(`R2 bytes differ from the staged release: ${bad.join(", ")}`);
  say(`  verified: its ${base.own.length} own objects have the staged SHA-256`);
  r2CheckShared(o, ctx, dest, "dest");
}

async function stepFetch(o, ctx) {
  const plan = fetchPlan(ctx.record, o.fetchCheck);
  if (!plan) return;
  const from = `https://github.com/${ctx.slug}/releases/download/${o.id}/`;
  step(`fetch: a consumer's pinned fetch of ${from} (${plan.only ?? "every file"}${plan.deep ? ", then verify --deep" : ""})`);
  // the reader this release ships, unpacked from its staged tgz and checked in preflight — not this
  // working tree's (a consumer installs that tgz first; for a release by reference it is the reader
  // that knows `base`)
  const { tools } = ctx.record;
  const cli = ctx.tools?.cli ?? path.join(JS, "cli.mjs");
  say(ctx.tools ? `  the reader: ${tools.package}@${tools.version}, the staged ${tools.tgz} as preflight unpacked and checked it`
    : "  (release.json names no tools tgz: this working tree's lean4-wasm64 reads it)");
  const out = o.dryRun ? "<tmp>" : tempDir("publish-release-fetch-");
  const fetchArgs = [cli, "fetch", "--from", from, "--id", o.id, "--digest", ctx.record.digest, "--out", out, ...(plan.only ? ["--only", plan.only] : [])];
  const verifyArgs = [cli, "verify", "--release", out, "--deep", ...(ctx.base ? ["--base", ctx.base.file] : [])];
  if (o.dryRun) {
    say(`  would run: node ${fetchArgs.join(" ")}`);
    if (plan.deep) say(`  would run: node ${verifyArgs.join(" ")}`);
    return;
  }
  try {
    run("node", fetchArgs, { capture: false });
    if (plan.deep) {
      const v = run("node", verifyArgs, { allowFail: true });
      if (v.status !== 0 || !/RELEASE VERIFIED/.test(v.stdout)) throw new Stop(`verify --deep of the fetched release failed:\n${(v.stdout + v.stderr).trim().split("\n").slice(-12).join("\n")}`);
    }
    say(`  FETCH VERIFIED${plan.deep ? " + RELEASE VERIFIED (deep)" : ` (${plan.only})`}`);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
}

export async function main(argv = process.argv.slice(2)) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error(`publish-release: ${e.message}`); return 2; }
  if (o.help) { console.log(usage()); return 0; }
  if (!o.id) { console.error("usage: publish-release.mjs <release id> [options]   (--help)"); return 2; }
  try {
    const ctx = preflight(o);
    for (const s of STEPS) if (o.only.includes(s)) await { record: stepRecord, push: stepPush, github: stepGithub, r2: stepR2, fetch: stepFetch }[s](o, ctx);
    const full = ["record", "push", "github", "r2"].every((s) => o.only.includes(s));
    say(o.dryRun ? `\nDRY RUN: nothing was changed (${o.id})`
      : full ? `\nPUBLISHED ${o.id} (${ctx.record.digest})`
      : `\nDONE ${o.only.join(",")} for ${o.id} — not run: ${STEPS.filter((s) => !o.only.includes(s)).join(",")} (not a full publish)`);
    return 0;
  } catch (e) {
    if (e instanceof Stop) { console.error(`\npublish-release: STOPPED — ${e.message}`); return e.code; }
    throw e;
  } finally {
    const temps = TEMPS.splice(0);
    if (o.dryRun) { if (temps.length) say(`  (kept for the commands printed above: ${temps.join(", ")})`); }
    else for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
  }
}

const invokedDirectly = (() => {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invokedDirectly) process.exitCode = await main();
