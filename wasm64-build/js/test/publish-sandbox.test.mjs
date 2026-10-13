// publish-release.mjs end to end, offline, on a release by reference: FAKE git, gh and rclone
// (fixtures/publish-sandbox/, first on PATH) and a fetch shim stand in for the repository, GitHub,
// R2 and the network. A small synthetic first cut is "published" in the fakes' state (its GitHub
// release, its R2 prefix, its tag), and its -r3 by reference (a tools re-cut) and a runtime release
// by reference of it (another kernel commit's runtime and lean-lib) are staged, each with a real
// tools tgz packed from this package. The script runs from a copy of wasm64-build
// (publish-release.mjs, stage-by-reference.mjs and js/) in a temp dir, so nothing it does reaches
// this repository; the fakes refuse any other repository, remote or URL, and the fake git refuses
// every write. What it pins (decision 8, AMENDMENTS A1-A3, A10):
//   - every check of the base runs in preflight, whatever --only is, before any write: its GitHub
//     release missing a shared asset, an R2 object with other bytes, its record at its tag failing
//     checkRecutBase, an `rclone check` that gives no answer
//   - the staged tools tgz (the reader the release ships) is checked in preflight, dry run too:
//     its package.json name@version, and its own verify of the staged dir
//   - a dry run writes nothing, keeps the files its printed commands name, and prints the R2
//     commands the real run runs
//   - a real publish uploads only the 3 own files, copies the shared ones server-side, checks
//     them against the staged dir (a copy that wrote other bytes is caught), and fetches with
//     the staged reader
//   - --r2-source local never reads the base's prefix, and checks against the staged dir
//   - a runtime release by reference uploads its own files (runtime, lean-lib, tools) and copies
//     the rest server-side, and its fetch check takes its runtime from its own release and the
//     lists from the base's; preflight runs staging's pairing guards again on its record, and a
//     dry run from the staged dir plans the record, push and release
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildIdFromSha256 } from "../artifact-id.mjs";
import { byReferenceKind, canonicalRelease, checkRecutBase, checkReleaseRecord, isOwnPath, isRecutOwnPath, serializeRelease, sha256sums } from "../release-record.mjs";
import { contentTypeOf, r2Lists, splitFiles } from "../../publish-release.mjs";
import { byReferenceConfig } from "../../stage-by-reference.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, "fixtures", "publish-sandbox");
const WB = path.resolve(here, "..", ".."); // wasm64-build
const skip = process.platform === "win32" ? "the fakes are run through /bin/sh wrappers" : false;

const SLUG = "sandbox-owner/sandbox-repo", LINE = "qed64-wasm64", R2 = "fake-r2:bucket/lean4-wasm64";
const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// the sandbox's history (fake git): root (which adds docker-wasm64/, the base's recipe), the kernel
// commit, the base's record commit, the -r3's tools commit, then (once recorded) the -r3's record
// commit. A runtime release by reference's history: root, the kernel commit, the base's record
// commit, its own kernel commit (a descendant), its tools commit, then (once recorded) its record
// commit.
const C = { root: sha1("root"), kernel: sha1("kernel"), base: sha1("release base"), tools: sha1("tools of -r3"), recut: sha1("release -r3"),
  kernel2: sha1("kernel 0040"), rtTools: sha1("tools of 0040"), rt: sha1("release 0040") };
const TAGOBJ = { base: sha1("tag object base"), recut: sha1("tag object -r3"), rt: sha1("tag object 0040") };
const K7 = C.kernel.slice(0, 7);
const BASE_ID = `lean-v4.34.0-${K7}`, ID = `${BASE_ID}-r3`;
const VERSION = `4.34.0-${K7}-r3`, TGZ = `tools/lean4-wasm64-${VERSION}.tgz`;
const BASE_PREFIX = `${R2}/${BASE_ID}/`, DEST = `${R2}/${ID}/`;
const RT_ID = `lean-v4.34.0-${C.kernel2.slice(0, 7)}`, RT_VERSION = `4.34.0-${C.kernel2.slice(0, 7)}`, RT_TGZ = `tools/lean4-wasm64-${RT_VERSION}.tgz`;

const TOP = fs.mkdtempSync(path.join(os.tmpdir(), "l4w-publish-sandbox-"));
after(() => fs.rmSync(TOP, { recursive: true, force: true }));
const BIN = path.join(TOP, "bin"), NODE_BIN = path.join(TOP, "node-bin"), GOLDEN = path.join(TOP, "golden");

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 60_000, ...opts });
  assert.equal(r.error, undefined, `${cmd} ${args.join(" ")}: ${r.error?.message}`);
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")}:\n${r.stdout}${r.stderr}`);
  return r;
}
const node = (script, args) => sh(process.execPath, [script, ...args]);
const shq = (s) => `'${s.replace(/'/g, "'\\''")}'`;
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 1));
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
/** Every file under a dir: [rel] sorted, "/"-separated. */
function walk(d, base = d, out = []) {
  for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, base, out); else out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out.sort();
}
const tree = (d) => walk(d).map((r) => `${r} ${sha256(fs.readFileSync(path.join(d, r)))}`);

/** A tools tgz as `npm pack` lays it out (package/…), from a js dir, at a version; `verifyStub` replaces its verify. */
function packTools(js, version, out, { verifyStub = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(TOP, "pack-"));
  const pkg = path.join(tmp, "package");
  fs.mkdirSync(pkg);
  for (const e of fs.readdirSync(js)) {
    if (/\.(mjs|d\.mts)$/.test(e) || ["probes", "formats", "packs.json", "README.md", "LICENSE"].includes(e)) fs.cpSync(path.join(js, e), path.join(pkg, e), { recursive: true });
  }
  const pj = readJson(path.join(js, "package.json"));
  fs.writeFileSync(path.join(pkg, "package.json"), `${JSON.stringify({ ...pj, version }, null, 2)}\n`);
  if (verifyStub) fs.writeFileSync(path.join(pkg, "verify-release.mjs"), verifyStub);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  sh("tar", ["-czf", out, "-C", tmp, "package"]);
  fs.rmSync(tmp, { recursive: true, force: true });
}

/** A lean-lib pack of `lib` into <rel>/profiles, the build's own: its gitRevision and release name `kernel` and its lean.wasm. */
function packLeanLib(js, lib, rel, kernel, wasmSha) {
  node(path.join(js, "pack.mjs"), ["--lib", lib, "--id", "lean-lib", "--out", path.join(rel, "profiles"), "--lean-version", "4.34.0", "--mount", "/lib/lean",
    "--revision", kernel.slice(0, 12), "--release", `lean-lib-4.34.0-${buildIdFromSha256(wasmSha)}`, "--roots", "Init", "--url-prefix", "/profiles/", "--no-imports"]);
  for (const f of fs.readdirSync(path.join(rel, "profiles"))) if (f.endsWith(".pack")) fs.rmSync(path.join(rel, "profiles", f));
}

/** The first cut, staged by this package's own tools (chunk → pack → release), as the sandbox repo publishes it. */
function stageBase(js, rel) {
  const work = fs.mkdtempSync(path.join(TOP, "base-"));
  const bin = path.join(work, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "lean.js"), Buffer.alloc(2500, 1));
  fs.writeFileSync(path.join(bin, "lean.wasm"), Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 251)));
  node(path.join(js, "chunk-runtime.mjs"), ["--bin", bin, "--out", path.join(rel, "runtime"), "--lean-version", "4.34.0",
    "--revision", `qed64-wasm64@${C.kernel.slice(0, 10)} (upstream v4.34.0)`, "--part-bytes", "1024"]);
  fs.mkdirSync(path.join(rel, "runtime", "bin"));
  fs.writeFileSync(path.join(rel, "runtime", "bin", "leanmake"), "#!/bin/sh\n");
  const lib = path.join(work, "lib");
  fs.mkdirSync(path.join(lib, "Init"), { recursive: true });
  fs.writeFileSync(path.join(lib, "Init.olean"), Buffer.alloc(300, 3));
  fs.writeFileSync(path.join(lib, "Init", "Prelude.olean"), Buffer.alloc(1200, 5));
  node(path.join(js, "pack.mjs"), ["--lib", lib, "--id", "lean-core", "--out", path.join(rel, "profiles"), "--lean-version", "4.34.0",
    "--revision", C.kernel, "--roots", "Init", "--url-prefix", "/profiles/", "--no-imports"]);
  const wasmSha = readJson(path.join(rel, "runtime", "runtime-manifest.json")).files["lean.wasm"].sha256;
  packLeanLib(js, lib, rel, C.kernel, wasmSha);
  fs.mkdirSync(path.join(rel, "native64"));
  fs.writeFileSync(path.join(rel, "native64", "native64.tar.gz"), Buffer.from(Array.from({ length: 6000 }, (_, i) => (i * 13) % 253)));
  fs.mkdirSync(path.join(rel, "lists"));
  fs.writeFileSync(path.join(rel, "lists", "essential-modules.txt"), "Init\n");
  const version = `4.34.0-${K7}`;
  fs.mkdirSync(path.join(rel, "tools"));
  fs.writeFileSync(path.join(rel, "tools", `lean4-wasm64-${version}.tgz`), "the first cut's tools (never unpacked here)");
  const manifest = readJson(path.join(rel, "runtime", "runtime-manifest.json"));
  writeJson(path.join(work, "config.json"), {
    upstreamTag: "v4.34.0", kernelCommit: C.kernel, kernelPatch: "0035b", kernelRepo: `https://github.com/${SLUG}`, kernelBranch: LINE,
    gate: { commit: C.kernel, wasmSha256: manifest.files["lean.wasm"].sha256, checks: 33 },
    packs: [{ id: "lean-core", compiler: "8d91aadcda8a0b231e47c42d4ff4b9b8360563aa" }, { id: "lean-lib", compiler: C.kernel }],
    native64: { commit: "857544b439aa51633344d638dacc03d304b9ea96", os: "linux", arch: "aarch64", tar: "native64/native64.tar.gz" },
    docker: { tag: "qed64-toolchain:emsdk-6.0.5", recipeCommit: C.root }, // the root commit adds docker-wasm64/
    mathlib: { commit: "5ed2965256430c3649e86755f9576b54eca72435", tag: "v4.34.0" },
    modules: { essential: "lists/essential-modules.txt" },
    tools: { package: "lean4-wasm64", version, tgz: `tools/lean4-wasm64-${version}.tgz`, commit: C.kernel },
    notes: ["the sandbox's first cut"],
  });
  node(path.join(js, "release.mjs"), ["--release", rel, "--config", path.join(work, "config.json")]);
  fs.rmSync(work, { recursive: true, force: true });
  return fs.readFileSync(path.join(rel, "release.json"), "utf8");
}

/** The -r3 by reference, as stage-release.sh --base writes it: the base's files outside tools/, its own tgz, base = {id, digest}. */
function stageRecut(w, { pkgVersion = VERSION, verifyStub = null } = {}) {
  const base = readJson(path.join(w.stage, BASE_ID, "release.json"));
  const rel = path.join(w.stage, ID);
  fs.rmSync(rel, { recursive: true, force: true });
  for (const f of base.files.filter((x) => !isRecutOwnPath(x.path))) {
    fs.mkdirSync(path.dirname(path.join(rel, f.path)), { recursive: true });
    fs.copyFileSync(path.join(w.stage, BASE_ID, f.path), path.join(rel, f.path));
  }
  packTools(w.js, pkgVersion, path.join(rel, TGZ), { verifyStub });
  const tgz = fs.readFileSync(path.join(rel, TGZ));
  const files = [...base.files.filter((x) => !isRecutOwnPath(x.path)), { path: TGZ, bytes: tgz.length, sha256: sha256(tgz) }]
    .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const { digest: _d, ...fields } = base;
  const record = canonicalRelease({ ...fields, id: ID, base: { id: base.id, digest: base.digest }, gate: { ...base.gate, checks: 34 },
    tools: { ...base.tools, version: VERSION, tgz: TGZ, commit: C.tools }, notes: ["the sandbox's tools re-cut", ...base.notes], files });
  const text = serializeRelease(record);
  fs.writeFileSync(path.join(rel, "release.json"), text);
  fs.writeFileSync(path.join(rel, "SHA256SUMS"), sha256sums([...files, { path: "release.json", sha256: sha256(text) }]));
  return { record, text };
}

/** The runtime release by reference, as stage-release.sh --base --runtime writes it: the base's files outside what it owns, its own runtime, lean-lib and tgz. */
function stageRuntime(w) {
  const base = readJson(path.join(w.stage, BASE_ID, "release.json"));
  const rel = path.join(w.stage, RT_ID);
  fs.rmSync(rel, { recursive: true, force: true });
  for (const f of base.files.filter((x) => !isRecutOwnPath(x.path))) {
    fs.mkdirSync(path.dirname(path.join(rel, f.path)), { recursive: true });
    fs.copyFileSync(path.join(w.stage, BASE_ID, f.path), path.join(rel, f.path));
  }
  const work = fs.mkdtempSync(path.join(TOP, "rt-"));
  const bin = path.join(work, "bin"), lib = path.join(work, "lib");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "lean.js"), Buffer.alloc(1700, 4));
  fs.writeFileSync(path.join(bin, "lean.wasm"), Buffer.from(Array.from({ length: 4300 }, (_, i) => (i * 11 + 5) % 249)));
  const wasmSha = sha256(fs.readFileSync(path.join(bin, "lean.wasm")));
  fs.rmSync(path.join(rel, "runtime"), { recursive: true });
  node(path.join(w.js, "chunk-runtime.mjs"), ["--bin", bin, "--out", path.join(rel, "runtime"), "--lean-version", "4.34.0",
    "--revision", `qed64-wasm64@${C.kernel2.slice(0, 10)} (upstream v4.34.0)`, "--part-bytes", "1024"]);
  fs.mkdirSync(path.join(rel, "runtime", "bin"));
  fs.writeFileSync(path.join(rel, "runtime", "bin", "leanmake"), "#!/bin/sh\n# 0040\n");
  fs.mkdirSync(path.join(lib, "Init"), { recursive: true });
  fs.writeFileSync(path.join(lib, "Init.olean"), Buffer.alloc(320, 6));
  fs.writeFileSync(path.join(lib, "Init", "Prelude.olean"), Buffer.alloc(1100, 7));
  for (const f of fs.readdirSync(path.join(rel, "profiles"))) if (f.startsWith("lean-lib.")) fs.rmSync(path.join(rel, "profiles", f));
  packLeanLib(w.js, lib, rel, C.kernel2, wasmSha);
  packTools(w.js, RT_VERSION, path.join(rel, RT_TGZ));
  writeJson(path.join(work, "config.json"), byReferenceConfig(base, { id: RT_ID, runtime: { kernelCommit: C.kernel2, kernelPatch: "0040", wasmSha256: wasmSha },
    checks: "4", version: RT_VERSION, tgz: path.posix.basename(RT_TGZ), commit: C.rtTools, notes: ["the sandbox's runtime release by reference"] }));
  node(path.join(w.js, "release.mjs"), ["--release", rel, "--config", path.join(work, "config.json"), "--base", path.join(w.stage, BASE_ID)]);
  fs.rmSync(work, { recursive: true, force: true });
}

const ROOT = { sha: C.root, subject: "root", adds: { README: "sandbox\n", "docker-wasm64/Dockerfile": "FROM emscripten/emsdk:6.0.5\n" } };
/**
 * The fake git's repository and origin: the base recorded, tagged and pushed; with `tagged`, the -r3
 * (or, with `runtime`, the runtime release by reference) too, else only staged on the line.
 */
function writeGit(w, { tagged, runtime = false }) {
  if (runtime) {
    const baseText = fs.readFileSync(path.join(w.stage, BASE_ID, "release.json"), "utf8");
    const rtText = fs.readFileSync(path.join(w.stage, RT_ID, "release.json"), "utf8");
    const tip = tagged ? C.rt : C.rtTools;
    const tags = { [`refs/tags/${BASE_ID}`]: TAGOBJ.base, ...(tagged ? { [`refs/tags/${RT_ID}`]: TAGOBJ.rt } : {}) };
    writeJson(path.join(w.state, "git.json"), {
      head: `refs/heads/${LINE}`,
      commits: [
        ROOT,
        { sha: C.kernel, subject: "the kernel commit", adds: { "kernel.txt": "kernel\n" } },
        { sha: C.base, subject: `release ${BASE_ID}`, adds: { [`wasm64-build/releases/${BASE_ID}.json`]: baseText } },
        { sha: C.kernel2, subject: "the 0040 kernel commit", adds: { "kernel.txt": "kernel 0040\n", "src/runtime/object.cpp": "0040\n" } },
        { sha: C.rtTools, subject: "the tools of 0040", adds: { "tools.txt": "0040\n" } },
        ...(tagged ? [{ sha: C.rt, subject: `release ${RT_ID}`, adds: { [`wasm64-build/releases/${RT_ID}.json`]: rtText } }] : []),
      ],
      refs: { [`refs/heads/${LINE}`]: tip, [`refs/remotes/origin/${LINE}`]: tip, ...tags },
      origin: { [`refs/heads/${LINE}`]: tip, ...tags },
      tags: { [TAGOBJ.base]: C.base, ...(tagged ? { [TAGOBJ.rt]: C.rt } : {}) },
    });
    return;
  }
  const baseText = fs.readFileSync(path.join(w.stage, BASE_ID, "release.json"), "utf8");
  const recutText = fs.readFileSync(path.join(w.stage, ID, "release.json"), "utf8");
  const tip = tagged ? C.recut : C.tools;
  const tags = { [`refs/tags/${BASE_ID}`]: TAGOBJ.base, ...(tagged ? { [`refs/tags/${ID}`]: TAGOBJ.recut } : {}) };
  writeJson(path.join(w.state, "git.json"), {
    head: `refs/heads/${LINE}`,
    commits: [
      ROOT,
      { sha: C.kernel, subject: "the kernel commit", adds: { "kernel.txt": "kernel\n" } },
      { sha: C.base, subject: `release ${BASE_ID}`, adds: { [`wasm64-build/releases/${BASE_ID}.json`]: baseText } },
      { sha: C.tools, subject: "the tools of the re-cut", adds: { "tools.txt": "-r3\n" } },
      ...(tagged ? [{ sha: C.recut, subject: `release ${ID}`, adds: { [`wasm64-build/releases/${ID}.json`]: recutText } }] : []),
    ],
    refs: { [`refs/heads/${LINE}`]: tip, [`refs/remotes/origin/${LINE}`]: tip, ...tags },
    origin: { [`refs/heads/${LINE}`]: tip, ...tags },
    tags: { [TAGOBJ.base]: C.base, ...(tagged ? { [TAGOBJ.recut]: C.recut } : {}) },
  });
}

/** The base, published: its GitHub release (every file flat, release.json, SHA256SUMS) and its complete R2 prefix. */
function publishBase(w) {
  const rel = path.join(w.stage, BASE_ID);
  const base = readJson(path.join(rel, "release.json"));
  const assets = [];
  let id = 100;
  fs.mkdirSync(path.join(w.state, "assets"), { recursive: true });
  for (const p of [...base.files.map((f) => f.path), "release.json", "SHA256SUMS"]) {
    const b = fs.readFileSync(path.join(rel, p));
    fs.writeFileSync(path.join(w.state, "assets", String(id)), b);
    assets.push({ id, name: path.posix.basename(p), size: b.length, state: "uploaded", digest: `sha256:${sha256(b)}` });
    id++;
  }
  writeJson(path.join(w.state, "gh.json"), { nextId: 1000, releases: [{ id: 10, tag_name: BASE_ID, draft: false, name: `lean4-wasm64 ${BASE_ID}`, assets }] });
  const prefix = path.join(w.state, "r2", "bucket", "lean4-wasm64", BASE_ID);
  fs.cpSync(rel, prefix, { recursive: true });
  const meta = {};
  for (const p of walk(prefix)) meta[`bucket/lean4-wasm64/${BASE_ID}/${p}`] = { type: contentTypeOf(p), md5: true };
  writeJson(path.join(w.state, "r2meta.json"), meta);
}

const paths = (root) => ({ root, repo: path.join(root, "repo"), js: path.join(root, "repo", "wasm64-build", "js"), stage: path.join(root, "stage"),
  state: path.join(root, "state"), tmp: path.join(root, "tmp"), rel: path.join(root, "stage", ID) });

before(() => {
  if (skip) return;
  // the fakes, first on PATH; node alone beside them (its own dir may hold a real gh or rclone)
  fs.mkdirSync(BIN);
  for (const t of ["git", "gh", "rclone"]) {
    fs.writeFileSync(path.join(BIN, t), `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(path.join(FIX, `${t}.mjs`))} "$@"\n`, { mode: 0o755 });
  }
  fs.mkdirSync(NODE_BIN);
  fs.symlinkSync(process.execPath, path.join(NODE_BIN, "node"));
  // the golden world: a copy of wasm64-build's publish script and package, the base staged and
  // published in the fakes, the -r3 staged
  const g = paths(GOLDEN);
  fs.mkdirSync(path.join(g.repo, "wasm64-build"), { recursive: true });
  // (stage-by-reference.mjs: publish runs its pairing guards on a runtime release by reference)
  for (const f of ["publish-release.mjs", "stage-by-reference.mjs"]) fs.copyFileSync(path.join(WB, f), path.join(g.repo, "wasm64-build", f));
  fs.cpSync(path.join(WB, "js"), g.js, { recursive: true, filter: (s) => !/[/\\](test|node_modules)$/.test(s) });
  for (const d of [g.stage, g.state, g.tmp]) fs.mkdirSync(d, { recursive: true });
  stageBase(g.js, path.join(g.stage, BASE_ID));
  stageRecut(g);
  stageRuntime(g);
  publishBase(g);
});

let worlds = 0;
/** A fresh copy of the golden world; `tagged`: the -r3 (with `runtime`: the runtime release by reference) already recorded, tagged and pushed (GitHub has its tag). */
function world({ tagged = false, runtime = false } = {}) {
  const w = paths(path.join(TOP, `w${++worlds}`));
  fs.cpSync(GOLDEN, w.root, { recursive: true });
  writeGit(w, { tagged, runtime });
  for (const f of ["calls.log", "events.log"]) fs.writeFileSync(path.join(w.state, f), "");
  return w;
}
const env = (w, extra = {}) => ({
  PATH: [BIN, NODE_BIN, "/usr/bin", "/bin"].join(path.delimiter), HOME: w.tmp, TMPDIR: w.tmp, LANG: "C",
  FAKE_STATE: w.state, FAKE_REPO: w.repo, NODE_OPTIONS: `--import=${pathToFileURL(path.join(FIX, "fetch-shim.mjs")).href}`, ...extra,
});
/** Run the world's publish-release.mjs on the -r3, or on `id` (a hang fails at the timeout, not at CI's). */
function publish(w, args, extra = {}, id = ID) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(w.repo, "wasm64-build", "publish-release.mjs"), id, "--release-dir", path.join(w.stage, id), "--r2", R2, ...args],
      { env: env(w, extra), stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`publish ${args.join(" ")}: no exit after 120 s\n${out}${err}`)); }, 120_000);
    p.on("close", (status) => { clearTimeout(timer); resolve({ status, out, err, all: `${out}\n${err}` }); });
  });
}

const calls = (w) => fs.readFileSync(path.join(w.state, "calls.log"), "utf8").split("\n").filter(Boolean)
  .map((l) => ({ tool: l.slice(0, l.indexOf(" ")), argv: JSON.parse(l.slice(l.indexOf(" ") + 1)) }));
const events = (w) => fs.readFileSync(path.join(w.state, "events.log"), "utf8").split("\n").filter(Boolean);
const RCLONE_READS = ["version", "listremotes", "lsjson", "cat", "check", "hashsum"];
/** A call that changes the repository, GitHub or R2 (attempted: the fake git refuses its writes, after logging them). */
function isWrite({ tool, argv }) {
  if (tool === "git") {
    const [c, ...rest] = argv[0] === "-C" ? argv.slice(2) : argv;
    return !["--version", "rev-parse", "symbolic-ref", "cat-file", "merge-base", "show", "ls-remote", "log", "diff", "branch", "fetch"].includes(c)
      || (c === "fetch" && rest.some((x) => x.includes(":"))) || (c === "branch" && !rest.includes("--contains"));
  }
  if (tool === "gh") return (argv[0] === "release" && argv[1] !== "download") || (argv[0] === "api" && argv.includes("-X"));
  if (tool === "rclone") return !RCLONE_READS.includes(argv[0]);
  return true;
}
function assertNoWrite(w, what) {
  assert.deepEqual(calls(w).filter(isWrite).map((c) => `${c.tool} ${c.argv.join(" ")}`), [], `${what}: no write may be attempted`);
  assert.deepEqual(events(w).filter((e) => !/^(GH READ|R2 READ|FETCH) /.test(e)), [], `${what}: nothing changed`);
}
/** Stopped in preflight: no step ran. */
function assertStoppedInPreflight(r, what, message) {
  assert.equal(r.status, 1, `${what}:\n${r.all}`);
  assert.match(r.err, /publish-release: STOPPED — /, what);
  assert.match(r.all, message, what);
  assert.doesNotMatch(r.out, /^== (record|push|github|r2|fetch)/m, `${what}: stopped before any step`);
}
/** Every state a publish can change, as one fingerprint: the fakes' state and the copied repository. */
const snapshot = (w) => [...["git.json", "gh.json", "r2meta.json"].map((f) => fs.readFileSync(path.join(w.state, f), "utf8")),
  ...tree(path.join(w.state, "r2")), ...tree(path.join(w.state, "assets")), ...walk(w.repo)].join("\n");
const shown = (r, lead) => r.out.split("\n").filter((l) => l.startsWith(`  ${lead}rclone `)).map((l) => l.slice(2 + lead.length));
const norm = (w, s) => s.split(w.root).join("<world>").replace(/publish-release-[A-Za-z0-9]{6}/g, "publish-release-<tmp>");

// the worlds are independent copies: the tests run concurrently
describe("publish-release.mjs on a tools re-cut, against fake git, gh and rclone", { concurrency: true, skip }, () => {
  test("the sandbox: fakes first on PATH, a synthetic first cut published in them, its -r3 by reference staged", () => {
    const w = world();
    const which = sh("/bin/sh", ["-c", "command -v git gh rclone node"], { env: env(w) }).stdout.trim().split("\n");
    assert.deepEqual(which, [...["git", "gh", "rclone"].map((t) => path.join(BIN, t)), path.join(NODE_BIN, "node")]);
    const base = readJson(path.join(w.stage, BASE_ID, "release.json")), r3 = readJson(path.join(w.rel, "release.json"));
    assert.deepEqual(checkReleaseRecord(r3), []);
    assert.deepEqual(checkRecutBase(r3, base), []);
    assert.deepEqual(splitFiles(r3).own, ["release.json", "SHA256SUMS", TGZ]);
    assert.ok(splitFiles(r3).shared.length >= 8);
  });

  test("a dry run of the staged -r3 reads and checks everything, prints the record, push and release, and changes nothing", async () => {
    const w = world();
    const before = snapshot(w);
    const r = await publish(w, ["--dry-run"], { FAKE_GH_NO_DIGEST: "native64.tar.gz" });
    assert.equal(r.status, 0, r.all);
    assert.match(r.out, /\nDRY RUN: nothing was changed/);
    assertNoWrite(w, "a dry run");
    assert.equal(snapshot(w), before, "a dry run changes no state");
    // every base check ran (A1), and the reader the release ships verified it (preflight, dry run too)
    assert.match(r.out, new RegExp(`by reference of ${esc(BASE_ID)} .*: 3 own, \\d+ shared`));
    assert.match(r.out, /the reader it ships: lean4-wasm64@4\.34\.0-[0-9a-f]{7}-r3 from the staged tools\/\S+\.tgz — its own verify --base: RELEASE VERIFIED/);
    assert.match(r.out, /rclone check \(MD5, nothing downloaded\): the \d+ shared files on fake-r2:bucket\/lean4-wasm64\/lean-v4\.34\.0-[0-9a-f]{7}\/ are the staged bytes/);
    // a base asset without a GitHub digest: reported, not downloaded — and the re-check does not claim it was hashed
    assert.match(r.out, /1 have no GitHub digest — the real run hashes a download of each: native64\.tar\.gz/);
    assert.match(r.out, /\(1 without a GitHub digest: the real run hashes them in preflight\)/);
    assert.doesNotMatch(r.out, /hashed in preflight/);
    // the plan
    for (const c of [/would run: git -C \S+ add wasm64-build\/releases\//, /would run: git -C \S+ commit -m /, /would run: git -C \S+ tag -a /,
      /would run: git -C \S+ push --atomic origin /, /would run: gh release create /]) assert.match(r.out, c);
    // A10: the files the printed commands name are kept; the fetch command names the reader preflight unpacked
    const cli = /would run: node (\S+) fetch --from https:\/\/github\.com\/sandbox-owner\/sandbox-repo\/releases\/download\//.exec(r.out)?.[1];
    assert.ok(cli && fs.existsSync(cli) && cli.endsWith(path.join("package", "cli.mjs")), r.out);
    assert.equal(readJson(path.join(path.dirname(cli), "package.json")).version, VERSION);
    const kept = /\(kept for the commands printed above: (.+)\)/.exec(r.out)?.[1].split(", ") ?? [];
    assert.ok(kept.length >= 3 && kept.every((d) => fs.existsSync(d)), r.out);
  });

  test("A1: a base release missing a shared asset stops in preflight, whatever --only is: no tag, commit or push, no gh or rclone write", async () => {
    const w = world();
    const s = readJson(path.join(w.state, "gh.json"));
    s.releases[0].assets = s.releases[0].assets.filter((a) => a.name !== "native64.tar.gz");
    writeJson(path.join(w.state, "gh.json"), s);
    for (const args of [["--only", "record,push", "--yes"], ["--only", "github", "--yes"], ["--only", "fetch", "--yes"], ["--dry-run"]]) {
      const r = await publish(w, args);
      assertStoppedInPreflight(r, args.join(" "), new RegExp(`the base's GitHub release ${esc(BASE_ID)} does not serve the files ${esc(ID)} shares with it:\\n  missing: native64\\.tar\\.gz`));
    }
    assertNoWrite(w, "a base release missing an asset");
  });

  test("A1/A2: a base R2 object of the right size and other bytes stops in preflight, before the push", async () => {
    const w = world();
    const obj = path.join(w.state, "r2", "bucket", "lean4-wasm64", BASE_ID, "native64", "native64.tar.gz");
    const b = fs.readFileSync(obj);
    b[100] ^= 0xff;
    fs.writeFileSync(obj, b);
    for (const args of [["--only", "record,push", "--yes"], ["--only", "github", "--yes"]]) {
      const r = await publish(w, args);
      assertStoppedInPreflight(r, args.join(" "), new RegExp(`the shared files on ${esc(BASE_PREFIX)} are not the staged bytes \\(rclone check, exit 1\\):\\n  native64/native64\\.tar\\.gz: differs from the staged file`));
    }
    assertNoWrite(w, "a base object with other bytes");
    // R2 holds no MD5 for it (a multipart upload): a dry run reports the download it would hash, the real run hashes it
    const meta = readJson(path.join(w.state, "r2meta.json"));
    meta[`bucket/lean4-wasm64/${BASE_ID}/native64/native64.tar.gz`].md5 = false;
    writeJson(path.join(w.state, "r2meta.json"), meta);
    const dry = await publish(w, ["--dry-run", "--only", "record,push"]);
    assert.equal(dry.status, 0, dry.all);
    assert.match(dry.out, /R2 holds no MD5 for 1\n {2}\(dry run: the real run hashes a download of each: native64\/native64\.tar\.gz\)/);
    assert.ok(!events(w).some((e) => e.startsWith("R2 READ hashsum")), "a dry run downloads nothing");
    const real = await publish(w, ["--only", "record,push", "--yes"]);
    assertStoppedInPreflight(real, "no MD5, real run", /R2 bytes on \S+ differ from the staged release: native64\/native64\.tar\.gz/);
    assert.ok(events(w).some((e) => e.startsWith(`R2 READ hashsum --download 1 objects of bucket/lean4-wasm64/${BASE_ID}`)));
    assertNoWrite(w, "a base object without an MD5");
  });

  test("A1: the base's record at its tag that fails checkRecutBase stops in preflight", async () => {
    const w = world();
    const g = readJson(path.join(w.state, "git.json"));
    const at = g.commits.find((c) => c.sha === C.base);
    const { digest: _d, ...fields } = JSON.parse(at.adds[`wasm64-build/releases/${BASE_ID}.json`]);
    at.adds[`wasm64-build/releases/${BASE_ID}.json`] = serializeRelease(canonicalRelease({ ...fields, notes: [...fields.notes, "another note"] }));
    writeJson(path.join(w.state, "git.json"), g);
    const r = await publish(w, ["--only", "record,push", "--yes"]);
    assertStoppedInPreflight(r, "another base record", new RegExp(`${esc(ID)} is not a release by reference of wasm64-build/releases/${esc(BASE_ID)}\\.json at tag ${esc(BASE_ID)}:\\n  the base's release\\.json digest is sha256:`));
    assertNoWrite(w, "another base record");
  });

  test("A2: an rclone check of the base's prefix that gives no answer (exit 3, exit 5, no report) stops in preflight", async () => {
    const w = world();
    for (const [knob, message] of [[{ FAKE_RCLONE_CHECK_EXIT: "3" }, /rclone check exited 3/], [{ FAKE_RCLONE_CHECK_EXIT: "5" }, /rclone check exited 5/],
      [{ FAKE_RCLONE_CHECK_NO_COMBINED: "1" }, /native64\/native64\.tar\.gz: not in the rclone check output/]]) {
      const r = await publish(w, ["--only", "record,push", "--yes"], knob);
      assertStoppedInPreflight(r, JSON.stringify(knob), message);
      assert.match(r.err, /are not the staged bytes \(rclone check, exit \d\)/);
    }
    assertNoWrite(w, "an rclone check with no answer");
  });

  test("the staged tools tgz: another package version, or a reader that refuses the release, stops in preflight — dry run too — before any write", async () => {
    const w = world();
    stageRecut(w, { pkgVersion: `4.34.0-${K7}-r9` });
    for (const args of [["--dry-run"], ["--only", "record,push", "--yes"]]) {
      const r = await publish(w, args);
      assertStoppedInPreflight(r, `another version: ${args.join(" ")}`,
        new RegExp(`${esc(TGZ)} is not lean4-wasm64@${esc(VERSION)} \\(its package/package\\.json: lean4-wasm64@4\\.34\\.0-${K7}-r9\\)`));
    }
    stageRecut(w, { verifyStub: 'console.log("RELEASE FAILED (malformed release.json)"); process.exitCode = 1;\n' });
    const r = await publish(w, ["--dry-run"]);
    assertStoppedInPreflight(r, "a reader that refuses it", new RegExp(`the reader ${esc(TGZ)} ships does not verify \\S+ \\(its own cli\\.mjs verify --base\\):\\nRELEASE FAILED \\(malformed release\\.json\\)`));
    assertNoWrite(w, "a tgz that is not the release's reader");
  });

  test("a recorded -r3: the dry run's R2 commands are the real run's; the real publish uploads its 3 own files, copies the rest server-side, checks and fetches", async () => {
    const dryWorld = world({ tagged: true }), w = world({ tagged: true });
    const before = snapshot(dryWorld);
    const knobs = { FAKE_GH_NO_DIGEST: "native64.tar.gz" };
    const dry = await publish(dryWorld, ["--dry-run"], knobs);
    assert.equal(dry.status, 0, dry.all);
    assertNoWrite(dryWorld, "the dry run");
    assert.equal(snapshot(dryWorld), before);
    const real = await publish(w, ["--yes"], knobs);
    assert.equal(real.status, 0, real.all);
    assert.match(real.out, new RegExp(`\\nPUBLISHED ${esc(ID)} \\(sha256:`));
    // the R2 commands: printed by the dry run exactly as the real run runs them (A10: their list files kept)
    const planned = shown(dry, "would run: "), ran = shown(real, "$ ");
    assert.equal(ran.length, 5, real.out);
    assert.deepEqual(planned.map((l) => norm(dryWorld, l)), ran.map((l) => norm(w, l)));
    for (const f of planned.flatMap((l) => / --files-from-raw (\S+)/.exec(l)?.[1] ?? [])) assert.ok(fs.existsSync(f), `${f} kept`);
    const copies = calls(w).filter((c) => c.tool === "rclone" && c.argv[0] === "copy").map((c) => c.argv);
    assert.deepEqual(copies.map((a) => a[1]), [BASE_PREFIX, BASE_PREFIX, w.rel, w.rel, w.rel], "shared files server-side from the base's prefix, then the own files from the staged dir");
    assert.ok(copies.every((a) => a[2] === DEST && a.includes("--immutable")));
    assert.ok(copies.at(-1).includes("+ /release.json"), "release.json last");
    // the lists passes 1-2 copy by: the shared objects, then the shared manifests (read from the dry run's, which are kept)
    const { shared } = splitFiles(readJson(path.join(w.rel, "release.json")));
    const { objects, manifests } = r2Lists(readJson(path.join(w.rel, "release.json")));
    assert.deepEqual(planned.slice(0, 2).map((l) => fs.readFileSync(/ --files-from-raw (\S+)/.exec(l)[1], "utf8")), [objects, manifests].map((l) => l.map((p) => `${p}\n`).join("")));
    // GitHub: only the 3 own files on the -r3's release, then published
    const uploads = calls(w).filter((c) => c.tool === "gh" && c.argv[0] === "release" && c.argv[1] === "upload");
    assert.equal(uploads.length, 1);
    assert.deepEqual(uploads[0].argv.slice(5).sort(), [path.join(w.rel, "SHA256SUMS"), path.join(w.rel, "release.json"), path.join(w.rel, ...TGZ.split("/"))].sort());
    const gh = events(w).filter((e) => e.startsWith("GH ") && !e.startsWith("GH READ"));
    assert.deepEqual(gh.map((e) => e.replace(/ \d+ /, " <id> ")), [
      `GH CREATE release <id> (${ID}) draft`,
      ...uploads[0].argv.slice(5).map((f) => `GH UPLOAD ${path.basename(f)} to draft <id> (${ID})`),
      `GH PUBLISH release <id> (${ID}), 3 assets`,
    ]);
    // the base's asset without a digest was hashed in preflight (a download); the step's re-check says so
    assert.ok(events(w).includes(`GH READ download native64.tar.gz of ${BASE_ID}`));
    assert.match(real.out, /\(1 without a GitHub digest: hashed in preflight\)/);
    // R2: a complete prefix of the -r3, every object the staged one; shared ones copied, own ones put, release.json last
    assert.deepEqual(tree(path.join(w.state, "r2", "bucket", "lean4-wasm64", ID)), tree(w.rel));
    const r2 = events(w).filter((e) => / bucket\/lean4-wasm64\/lean-[^/]+-r3\//.test(e) && /^R2 (COPY|PUT) /.test(e));
    assert.equal(r2.filter((e) => e.startsWith("R2 COPY")).length, shared.length);
    assert.deepEqual(r2.filter((e) => e.startsWith("R2 PUT")).map((e) => e.split(" ")[2].split(`${ID}/`)[1]), [TGZ, "SHA256SUMS", "release.json"]);
    // A2: the copy checked against the STAGED dir, not the base's prefix — after the listing and the own files' SHA-256
    const checks = calls(w).filter((c) => c.tool === "rclone" && c.argv[0] === "check").map((c) => c.argv.slice(1, 3));
    assert.deepEqual(checks, [[w.rel, BASE_PREFIX], [w.rel, DEST]]);
    const rclone = calls(w).filter((c) => c.tool === "rclone").map((c) => c.argv);
    const verification = rclone.slice(rclone.findLastIndex((a) => a[0] === "copy") + 1);
    assert.deepEqual(verification.map((a) => [a[0], a.at(a[0] === "check" ? 2 : -1)]), [["lsjson", DEST], ["hashsum", DEST], ["check", DEST]]);
    // the fetch check: the staged reader (unpacked in preflight), its runtime through the base's release, its tools from its own
    assert.match(real.out, /FETCH VERIFIED \(runtime,lists,tools\)/);
    const fetched = events(w).filter((e) => e.startsWith("FETCH ")).map((e) => e.slice(6));
    assert.deepEqual(fetched.filter((f) => f.startsWith(`${ID}/`)).sort(), [`${ID}/${path.posix.basename(TGZ)}`, `${ID}/release.json`].sort());
    assert.ok(fetched.includes(`${BASE_ID}/release.json`) && fetched.some((f) => /^lean-[^/]+\/lean\.wasm\./.test(f) && f.startsWith(`${BASE_ID}/`)), fetched.join("\n"));
    assert.deepEqual(calls(w).filter((c) => c.tool === "git" && isWrite(c)), [], "recorded and pushed already: nothing to commit, tag or push");
  });

  test("A3: --r2-source local never reads the base's prefix; the shared files go up from the staged dir and are checked against it", async () => {
    const w = world({ tagged: true });
    fs.rmSync(path.join(w.state, "r2", "bucket", "lean4-wasm64", BASE_ID), { recursive: true }); // the base's prefix is not needed
    const r = await publish(w, ["--only", "r2", "--r2-source", "local", "--yes"]);
    assert.equal(r.status, 0, r.all);
    assert.match(r.out, /--r2-source local: the base's R2 prefix is not read/);
    assert.match(r.out, /\nDONE r2 for /);
    const rclone = calls(w).filter((c) => c.tool === "rclone");
    assert.deepEqual(rclone.filter((c) => c.argv.some((x) => x.startsWith(BASE_PREFIX))).map((c) => c.argv.join(" ")), [], "no call on the base's prefix");
    assert.deepEqual(rclone.filter((c) => c.argv[0] === "copy").map((c) => c.argv.slice(1, 3)), [[w.rel, DEST], [w.rel, DEST], [w.rel, DEST]]);
    const check = rclone.filter((c) => c.argv[0] === "check").map((c) => c.argv);
    assert.equal(check.length, 1);
    assert.deepEqual(check[0].slice(1, 4), [w.rel, DEST, "--one-way"], "the copy is checked against the staged dir (A2)");
    assert.match(r.out, /rclone check \(MD5, nothing downloaded\): the \d+ shared files on \S+-r3\/ are the staged bytes/);
    assert.deepEqual(tree(path.join(w.state, "r2", "bucket", "lean4-wasm64", ID)), tree(w.rel));
  });

  test("A2: a server-side copy that wrote other bytes is caught after the copy, by the check against the staged dir", async () => {
    const w = world({ tagged: true });
    const r = await publish(w, ["--only", "r2", "--yes"], { FAKE_RCLONE_CORRUPT_COPY: "native64/native64.tar.gz" });
    assert.equal(r.status, 1, r.all);
    assert.match(r.out, new RegExp(`the \\d+ shared files on ${esc(BASE_PREFIX)} are the staged bytes`), "the base's prefix is fine");
    assert.ok(events(w).includes(`R2 COPY bucket/lean4-wasm64/${ID}/native64/native64.tar.gz (application/octet-stream)`), "it was copied");
    assert.match(r.err, new RegExp(`STOPPED — the shared files on ${esc(DEST)} are not the staged bytes \\(rclone check, exit 1\\):\\n  native64/native64\\.tar\\.gz: differs from the staged file`));
  });

  test("a recorded runtime release by reference: the real publish uploads its own files, copies the shared ones server-side, puts its own by list, and fetches", async () => {
    const w = world({ runtime: true, tagged: true });
    const rel = path.join(w.stage, RT_ID);
    const record = readJson(path.join(rel, "release.json"));
    const base = readJson(path.join(w.stage, BASE_ID, "release.json"));
    assert.equal(byReferenceKind(record), "runtime");
    assert.deepEqual(checkReleaseRecord(record), []);
    assert.deepEqual(checkRecutBase(record, base), []);
    const { own, shared } = splitFiles(record);
    assert.ok(own.some((p) => p.startsWith("runtime/chunks/")) && own.includes("profiles/lean-lib.manifest.json") && own.includes(RT_TGZ));
    const r = await publish(w, ["--yes"], {}, RT_ID);
    assert.equal(r.status, 0, r.all);
    assert.match(r.out, new RegExp(`\\nPUBLISHED ${esc(RT_ID)} \\(sha256:`));
    assert.match(r.out, new RegExp(`by reference of ${esc(BASE_ID)} .*: ${own.length} own, ${shared.length} shared`));
    // GitHub: exactly its own files, release.json and SHA256SUMS
    const uploaded = calls(w).filter((c) => c.tool === "gh" && c.argv[0] === "release" && c.argv[1] === "upload").flatMap((c) => c.argv.slice(5));
    assert.deepEqual(uploaded.map((f) => path.relative(rel, f).split(path.sep).join("/")).sort(), [...own].sort());
    const created = readJson(path.join(w.state, "gh.json")).releases.find((x) => x.tag_name === RT_ID);
    assert.equal(created.draft, false);
    assert.match(created.body, new RegExp(`Release by reference of ${esc(BASE_ID)} \\(sha256:[0-9a-f]{64}\\): this release's assets are its own files \\(runtime/, profiles/lean-lib\\.\\* and tools/: ${own.length - 2} files\\)`));
    // R2: the shared files server-side from the base's prefix, then its own objects and manifests by list, SHA256SUMS, release.json last
    const dest = `${R2}/${RT_ID}/`;
    const copies = calls(w).filter((c) => c.tool === "rclone" && c.argv[0] === "copy").map((c) => c.argv);
    assert.deepEqual(copies.map((a) => a[1]), [BASE_PREFIX, BASE_PREFIX, rel, rel, rel, rel]);
    assert.ok(copies.every((a) => a[2] === dest && a.includes("--immutable")));
    assert.ok(copies.at(-1).includes("+ /release.json"), "release.json last");
    // passes 1-4 are list-driven (the run's temp lists, removed after it): the own ones with their content type
    assert.ok(copies.slice(0, 4).every((a) => a.includes("--files-from-raw")));
    assert.deepEqual(copies.slice(2, 4).map((a) => a[a.indexOf("--header-upload") + 1]), ["Content-Type: application/octet-stream", "Content-Type: application/json"]);
    assert.ok(r2Lists(record).ownManifests.length === 3);
    assert.deepEqual(tree(path.join(w.state, "r2", "bucket", "lean4-wasm64", RT_ID)), tree(rel));
    const puts = events(w).filter((e) => e.startsWith(`R2 PUT bucket/lean4-wasm64/${RT_ID}/`)).map((e) => e.split(" ")[2].split(`${RT_ID}/`)[1]);
    assert.deepEqual(puts.slice(-2), ["SHA256SUMS", "release.json"]);
    assert.deepEqual(puts.slice(0, -2).sort(), own.filter((p) => p !== "release.json" && p !== "SHA256SUMS").sort());
    for (const e of events(w).filter((x) => x.startsWith(`R2 PUT bucket/lean4-wasm64/${RT_ID}/`))) {
      const p = e.split(" ")[2].split(`${RT_ID}/`)[1];
      assert.ok(e.endsWith(`(${contentTypeOf(p)})`), e);
    }
    assert.equal(events(w).filter((e) => e.startsWith(`R2 COPY bucket/lean4-wasm64/${RT_ID}/`)).length, shared.length);
    // the fetch check: its runtime and tools from its own release, the lists from the base's
    assert.match(r.out, /FETCH VERIFIED \(runtime,lists,tools\)/);
    const fetched = events(w).filter((e) => e.startsWith("FETCH ")).map((e) => e.slice(6));
    const mine = fetched.filter((f) => f.startsWith(`${RT_ID}/`)).map((f) => f.slice(RT_ID.length + 1));
    assert.ok(mine.includes("release.json") && mine.includes(path.posix.basename(RT_TGZ)) && mine.includes("runtime-manifest.json") && mine.some((f) => f.startsWith("lean.wasm.")), mine.join(", "));
    assert.ok(fetched.includes(`${BASE_ID}/release.json`) && fetched.includes(`${BASE_ID}/essential-modules.txt`), fetched.join("\n"));
    assert.ok(!fetched.some((f) => f.startsWith(`${BASE_ID}/lean.`)), "no runtime chunk from the base");
    assert.deepEqual(calls(w).filter((c) => c.tool === "git" && isWrite(c)), [], "recorded and pushed already");
  });

  test("a staged runtime release by reference: the dry run checks its base and the pairing guards, plans the record, push and release, and changes nothing", async () => {
    const w = world({ runtime: true });
    const before = snapshot(w);
    const r = await publish(w, ["--dry-run"], {}, RT_ID);
    assert.equal(r.status, 0, r.all);
    assert.match(r.out, /\nDRY RUN: nothing was changed/);
    assertNoWrite(w, "a dry run");
    assert.equal(snapshot(w), before, "a dry run changes no state");
    assert.match(r.out, new RegExp(`its runtime pairs with ${esc(BASE_ID)}'s files: kernel ${C.kernel2.slice(0, 10)} descends from ${C.kernel.slice(0, 10)}, the same docker-wasm64 recipe, the olean format's C\\+\\+ unchanged`));
    assert.match(r.out, /the reader it ships: lean4-wasm64@4\.34\.0-[0-9a-f]{7} from the staged tools\/\S+\.tgz — its own verify --base: RELEASE VERIFIED/);
    for (const c of [/would run: git -C \S+ add wasm64-build\/releases\//, /would run: git -C \S+ commit -m /, /would run: git -C \S+ tag -a /,
      /would run: git -C \S+ push --atomic origin /]) assert.match(r.out, c);
    assert.match(r.out, /the record and push steps come first; planning only/);
    // the guards asked git what staging asks: the olean format, then the stdlib's sources, between the two kernels
    const diffs = calls(w).filter((c) => c.tool === "git" && c.argv.includes("diff")).map((c) => c.argv.slice(c.argv.indexOf("diff")));
    assert.deepEqual(diffs.map((a) => a.slice(0, 4)), [["diff", "--quiet", C.kernel, C.kernel2], ["diff", "--name-only", C.kernel, C.kernel2]]);
  });

  test("a runtime release by reference whose kernel changed the Docker recipe and the olean format's C++ stops in preflight, whatever wrote its record", async () => {
    const w = world({ runtime: true, tagged: true });
    const g = readJson(path.join(w.state, "git.json"));
    Object.assign(g.commits.find((c) => c.sha === C.kernel2).adds, { "docker-wasm64/Dockerfile": "FROM another\n", "src/runtime/object.h": "another layout\n" });
    writeJson(path.join(w.state, "git.json"), g);
    for (const args of [["--dry-run"], ["--only", "fetch", "--yes"]]) {
      const r = await publish(w, args, {}, RT_ID);
      assertStoppedInPreflight(r, args.join(" "), new RegExp(`${esc(RT_ID)}'s runtime cannot share ${esc(BASE_ID)}'s files \\(the guards of stage-release\\.sh, run on the record\\):`
        + `\\n  docker-wasm64 at ${C.kernel2.slice(0, 10)} is not the base's recipe \\(${C.root.slice(0, 10)}\\): `
        + `.*\\n  the olean format's C\\+\\+ \\(src/include/lean/lean\\.h .*\\) changed since the base's kernel ${C.kernel.slice(0, 10)}: `));
    }
    assertNoWrite(w, "a runtime that does not pair with its base");
  });
});
