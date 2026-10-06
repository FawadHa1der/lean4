// End to end on a small synthetic release: chunk → pack → release → verify,
// then tamper and check that each failure is caught. Runs the scripts as
// separate processes, exactly as a user would.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../artifact-id.mjs";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (script, args) => spawnSync(process.execPath, [path.join(pkg, script), ...args], { encoding: "utf8" });
const KERNEL = "a8817d01f97227b1b04cc7d661b9e396f6ca8f34";

function stage() {
  const root = mkdtemp("l4w-rel-");
  // a fake runtime pair (bytes need not be real wasm for these tools)
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "lean.js"), Buffer.alloc(2500, 1));
  fs.writeFileSync(path.join(bin, "lean.wasm"), Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 7) % 251)));
  const rel = path.join(root, "release");
  let r = run("chunk-runtime.mjs", ["--bin", bin, "--out", path.join(rel, "runtime"), "--lean-version", "4.34.0",
    "--revision", `qed64-wasm64@${KERNEL.slice(0, 10)} (upstream v4.34.0)`, "--part-bytes", "1024"]);
  assert.equal(r.status, 0, r.stderr);
  fs.mkdirSync(path.join(rel, "runtime", "bin"));
  fs.writeFileSync(path.join(rel, "runtime", "bin", "leanmake"), "#!/bin/sh\n");
  // a tiny olean tree, packed without reading imports (not real regions)
  const lib = path.join(root, "lib");
  fs.mkdirSync(path.join(lib, "Init"), { recursive: true });
  fs.writeFileSync(path.join(lib, "Init.olean"), Buffer.alloc(300, 3));
  fs.writeFileSync(path.join(lib, "Init.ir"), Buffer.alloc(40, 4));
  fs.writeFileSync(path.join(lib, "Init", "Prelude.olean"), Buffer.alloc(1200, 5));
  r = run("pack.mjs", ["--lib", lib, "--id", "lean-core", "--out", path.join(rel, "profiles"), "--lean-version", "4.34.0",
    "--revision", KERNEL, "--roots", "Init", "--url-prefix", "/profiles/", "--no-imports"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // a second pack, packed the way packs.json cuts mathlib-game-extra
  const extra = path.join(root, "extra");
  fs.mkdirSync(path.join(extra, "Mathlib"), { recursive: true });
  fs.writeFileSync(path.join(extra, "Mathlib", "Extra.olean"), Buffer.alloc(900, 6));
  r = run("pack.mjs", ["--lib", extra, "--id", "mathlib-game-extra", "--out", path.join(rel, "profiles"), "--lean-version", "4.34.0",
    "--revision", KERNEL, "--url-prefix", "/profiles/", "--no-imports"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  for (const f of fs.readdirSync(path.join(rel, "profiles"))) if (f.endsWith(".pack")) fs.rmSync(path.join(rel, "profiles", f));
  fs.mkdirSync(path.join(rel, "native64"));
  fs.writeFileSync(path.join(rel, "native64", "native64.tar.gz"), "not really a tarball");
  fs.mkdirSync(path.join(rel, "lists"));
  fs.writeFileSync(path.join(rel, "lists", "essential-modules.txt"), "Init\n");
  // the selection records stage-release copies beside the lists: listed files no `modules` entry names
  fs.writeFileSync(path.join(rel, "lists", "essential-selection.json"), "{}\n");
  fs.writeFileSync(path.join(rel, "lists", "extra-selection.json"), "{}\n");
  fs.mkdirSync(path.join(rel, "tools"));
  fs.writeFileSync(path.join(rel, "tools", "lean4-wasm64-4.34.0-a8817d0.tgz"), "tgz");
  const manifest = JSON.parse(fs.readFileSync(path.join(rel, "runtime", "runtime-manifest.json"), "utf8"));
  const config = {
    upstreamTag: "v4.34.0", kernelCommit: KERNEL, kernelPatch: "0035b",
    gate: { commit: KERNEL, wasmSha256: manifest.files["lean.wasm"].sha256 },
    packs: [{ id: "lean-core", compiler: "8d91aadcda8a0b231e47c42d4ff4b9b8360563aa" },
      { id: "mathlib-game-extra", compiler: "857544b439aa51633344d638dacc03d304b9ea96" }],
    native64: { commit: "857544b439aa51633344d638dacc03d304b9ea96", os: "linux", arch: "aarch64", tar: "native64/native64.tar.gz" },
    docker: { tag: "qed64-toolchain:emsdk-6.0.5", recipeCommit: "974ee228b0" },
    mathlib: { commit: "5ed2965256430c3649e86755f9576b54eca72435", tag: "v4.34.0" },
    modules: { essential: "lists/essential-modules.txt" },
    tools: { package: "lean4-wasm64", version: "4.34.0-a8817d0", tgz: "tools/lean4-wasm64-4.34.0-a8817d0.tgz" },
  };
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { root, rel, config, configPath, manifest };
}

test("a staged release is written, then verified --deep", () => {
  const s = stage();
  let r = run("release.mjs", ["--release", s.rel, "--config", s.configPath]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const record = JSON.parse(fs.readFileSync(path.join(s.rel, "release.json"), "utf8"));
  assert.equal(record.id, "lean-v4.34.0-a8817d0");
  assert.equal(record.kernel.patch, "0035b");
  assert.equal(record.packs[0].lean.compiler, "8d91aadcda8a0b231e47c42d4ff4b9b8360563aa");
  assert.equal(Object.keys(record).at(-1), "digest");
  r = run("verify-release.mjs", ["--release", s.rel, "--deep"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /RELEASE VERIFIED lean-v4\.34\.0-a8817d0/);
  assert.match(r.stdout, /artifact digests/);
  assert.match(r.stdout, /mathlib-game-extra: 1 transport parts/);
});

test("release refuses part URLs that are not /profiles/<name>, and dotfiles", () => {
  const s = stage();
  const mf = path.join(s.rel, "profiles", "mathlib-game-extra.manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  const part = m.content.pack.transport.parts[0];
  part.url = part.url.replace(/^\/profiles\//, ""); // a bare name: no browser can fetch it verbatim
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  let r = run("release.mjs", ["--release", s.rel, "--config", s.configPath]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /part url mathlib-game-extra\.pack\.gzip\.[0-9a-f]{20}\.part-000 is not \/profiles\/<name>/);
  const t = stage();
  fs.writeFileSync(path.join(t.rel, "lists", ".DS_Store"), "x");
  r = run("release.mjs", ["--release", t.rel, "--config", t.configPath]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lists\/\.DS_Store: dotfiles and unsafe names are not release files/);
});

test("servedPath resolves manifest URLs as a browser on the mounting site would", async () => {
  const { servedPath } = await import("../release-record.mjs");
  assert.equal(servedPath("/runtime/chunks/lean.wasm.ab.part-000", "runtime/runtime-manifest.json"), "runtime/chunks/lean.wasm.ab.part-000");
  assert.equal(servedPath("x.pack.gzip.ab.part-001", "profiles/x.manifest.json"), "profiles/x.pack.gzip.ab.part-001");
  assert.equal(servedPath("/profiles/x.part-000", "profiles/x.manifest.json"), "profiles/x.part-000");
  assert.equal(servedPath("../../../etc/passwd", "profiles/x.manifest.json"), "etc/passwd"); // never escapes the release root
  assert.throws(() => servedPath("https://elsewhere.example/p", "profiles/x.manifest.json"), /own origin/);
  assert.throws(() => servedPath("//elsewhere.example/p", "profiles/x.manifest.json"), /own origin/);
  assert.throws(() => servedPath("/profiles/a%2F..%2F..%2Fetc", "profiles/x.manifest.json"), /escapes/);
});

test("release refuses a stale part that no manifest names; verify flags one added later", async () => {
  const s = stage();
  const stale = path.join(s.rel, "profiles", "lean-core.pack.gzip.0123456789abcdef0123.part-000");
  fs.writeFileSync(stale, "an older transport");
  let r = run("release.mjs", ["--release", s.rel, "--config", s.configPath]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lean-core\.pack\.gzip\.0123456789abcdef0123\.part-000 is named by no manifest/);
  fs.rmSync(stale);
  assert.equal(run("release.mjs", ["--release", s.rel, "--config", s.configPath]).status, 0);
  // a record that lists a stray chunk (written by hand, digest recomputed) still fails verify
  const record = JSON.parse(fs.readFileSync(path.join(s.rel, "release.json"), "utf8"));
  fs.writeFileSync(path.join(s.rel, "runtime", "chunks", "lean.js.ffffffffffffffffffff.part-009"), "x");
  record.files.push({ path: "runtime/chunks/lean.js.ffffffffffffffffffff.part-009", bytes: 1, sha256: sha256Hex(Buffer.from("x")) });
  record.files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const { canonicalRelease, serializeRelease, sha256sums } = await import("../release-record.mjs");
  const { digest, ...rest } = record;
  const text = serializeRelease(canonicalRelease(rest));
  fs.writeFileSync(path.join(s.rel, "release.json"), text);
  fs.writeFileSync(path.join(s.rel, "SHA256SUMS"), sha256sums([...record.files, { path: "release.json", sha256: sha256Hex(Buffer.from(text)) }]));
  r = run("verify-release.mjs", ["--release", s.rel]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL.*named by a manifest — stray: runtime\/chunks\/lean\.js\.ffffffffffffffffffff\.part-009/);
});

test("a corrupted chunk fails verification", () => {
  const s = stage();
  assert.equal(run("release.mjs", ["--release", s.rel, "--config", s.configPath]).status, 0);
  const chunk = path.join(s.rel, s.manifest.files["lean.wasm"].chunks[1].url.replace(/^\//, ""));
  const b = fs.readFileSync(chunk); b[0] ^= 0xff; fs.writeFileSync(chunk, b);
  const r = run("verify-release.mjs", ["--release", s.rel]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL .*lean\.wasm: \d+ chunks/);
});

test("an unlisted extra file fails verification", () => {
  const s = stage();
  assert.equal(run("release.mjs", ["--release", s.rel, "--config", s.configPath]).status, 0);
  fs.writeFileSync(path.join(s.rel, "lists", "stowaway.txt"), "x");
  const r = run("verify-release.mjs", ["--release", s.rel, "--skip-packs"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /unlisted: lists\/stowaway\.txt/);
});

test("release refuses a gate that ran on another binary", () => {
  const s = stage();
  s.config.gate.wasmSha256 = sha256Hex(Buffer.from("other"));
  fs.writeFileSync(s.configPath, JSON.stringify(s.config));
  const r = run("release.mjs", ["--release", s.rel, "--config", s.configPath]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gate\.wasmSha256/);
  assert.equal(fs.existsSync(path.join(s.rel, "release.json")), false);
});

test("release refuses a pack built for another Lean version", () => {
  const s = stage();
  const mpath = path.join(s.rel, "profiles", "lean-core.manifest.json");
  const m = JSON.parse(fs.readFileSync(mpath, "utf8"));
  m.content.lean.version = "4.33.0-pre";
  fs.writeFileSync(mpath, JSON.stringify(m));
  const r = run("release.mjs", ["--release", s.rel, "--config", s.configPath]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pairing rule/);
});

test("release refuses a mismatched id, a bad patch id and a missing compiler", () => {
  const s = stage();
  Object.assign(s.config, { id: "lean-v4.34.0-0000000", kernelPatch: "35b" });
  s.config.packs[0].compiler = "8d91aad";
  fs.writeFileSync(s.configPath, JSON.stringify(s.config));
  const r = run("release.mjs", ["--release", s.rel, "--config", s.configPath]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not name/);
  assert.match(r.stderr, /not a patch id/);
  assert.match(r.stderr, /compiler must be/);
});

test("the gzip header's OS byte is normalized", () => {
  const s = stage();
  const m = JSON.parse(fs.readFileSync(path.join(s.rel, "profiles", "lean-core.manifest.json"), "utf8"));
  const first = path.join(s.rel, m.content.pack.transport.parts[0].url.replace(/^\//, ""));
  const head = fs.readFileSync(first).subarray(0, 10);
  assert.equal(head[0], 0x1f); assert.equal(head[1], 0x8b);
  assert.equal(head[9], 0x03);
});

// ---------- fetch ----------
import http from "node:http";

const made = [];
const mkdtemp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

function released() {
  const s = stage();
  assert.equal(run("release.mjs", ["--release", s.rel, "--config", s.configPath]).status, 0);
  return s;
}
const runAsync = (script, args) => new Promise((resolve) => {
  import("node:child_process").then(({ spawn }) => {
    const p = spawn(process.execPath, [path.join(pkg, script), ...args]);
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d)); p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (status) => resolve({ status, stdout, stderr }));
  });
});

test("fetch --only runtime rebuilds bin/ from a served dir and recomputes the build id", () => {
  const s = released();
  const out = path.join(s.root, "got");
  let r = run("fetch-release.mjs", ["--from", s.rel, "--out", out, "--only", "runtime"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.readFileSync(path.join(out, "bin", "lean.wasm")).equals(fs.readFileSync(path.join(s.root, "bin", "lean.wasm"))));
  assert.ok(fs.readFileSync(path.join(out, "bin", "lean.js")).equals(fs.readFileSync(path.join(s.root, "bin", "lean.js"))));
  assert.ok(fs.existsSync(path.join(out, "bin", "leanmake")));
  // pthreads re-load lean.js as a script: it must stay CommonJS under any parent package.json
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "bin", "package.json"), "utf8")), { type: "commonjs" });
  assert.match(r.stdout, new RegExp(`runtime ${s.manifest.buildId}`));
  // resume: a second run fetches nothing new
  r = run("fetch-release.mjs", ["--from", s.rel, "--out", out, "--only", "runtime"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("fetch from a flat (GitHub-style) dir, all groups, then verify the result", () => {
  const s = released();
  const flat = path.join(s.root, "flat");
  fs.mkdirSync(flat);
  const record = JSON.parse(fs.readFileSync(path.join(s.rel, "release.json"), "utf8"));
  for (const f of record.files) fs.copyFileSync(path.join(s.rel, f.path), path.join(flat, path.basename(f.path)));
  fs.copyFileSync(path.join(s.rel, "release.json"), path.join(flat, "release.json"));
  const out = path.join(s.root, "got");
  const r = run("fetch-release.mjs", ["--from", flat, "--out", out, "--layout", "flat"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const f of record.files) assert.ok(fs.existsSync(path.join(out, f.path)), f.path);
  const v = run("verify-release.mjs", ["--release", out, "--deep"]);
  assert.equal(v.status, 0, v.stdout + v.stderr);
});

test("fetch refuses a tampered file and leaves nothing unverified behind", () => {
  const s = released();
  const record = JSON.parse(fs.readFileSync(path.join(s.rel, "release.json"), "utf8"));
  const victim = record.files.find((f) => f.path.startsWith("profiles/") && f.path.includes(".part-"));
  const b = fs.readFileSync(path.join(s.rel, victim.path)); b[5] ^= 0xff; fs.writeFileSync(path.join(s.rel, victim.path), b);
  const out = path.join(s.root, "got");
  const r = run("fetch-release.mjs", ["--from", s.rel, "--out", out, "--only", "packs"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /expected .* bytes sha256/);
  assert.equal(fs.existsSync(path.join(out, victim.path)), false);
  assert.equal(fs.readdirSync(path.join(out, "profiles")).some((n) => n.includes(".partial-")), false);
});

test("fetch refuses a release whose id is not the expected one", () => {
  const s = released();
  const r = run("fetch-release.mjs", ["--from", s.rel, "--out", path.join(s.root, "got"), "--only", "lists", "--id", "lean-v4.35.0-1234567"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /expected lean-v4\.35\.0-1234567/);
});

test("fetch over HTTP from a served layout", async () => {
  const s = released();
  const server = http.createServer((req, res) => {
    const p = path.join(s.rel, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/rel\//, ""));
    if (!p.startsWith(s.rel) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end(); }
    fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/rel/`;
    const out = path.join(s.root, "got");
    const r = await runAsync("fetch-release.mjs", ["--from", url, "--out", out, "--only", "runtime,lean-core"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(path.join(out, "bin", "lean.wasm")));
    assert.ok(fs.existsSync(path.join(out, "profiles", "lean-core.manifest.json")));
  } finally {
    server.close();
  }
});

// ---------- fetch hardening ----------
const rewriteRecord = async (relDir, mutate) => {
  const { canonicalRelease, serializeRelease } = await import("../release-record.mjs");
  const record = JSON.parse(fs.readFileSync(path.join(relDir, "release.json"), "utf8"));
  mutate(record);
  const { digest, ...rest } = record;
  fs.writeFileSync(path.join(relDir, "release.json"), serializeRelease(canonicalRelease(rest)));
};

test("fetch refuses a release.json naming a path outside the release, before writing anything", async () => {
  const s = released();
  // a hostile mirror: consistent self-digest, a files[] path and a bin name that climb out of --out
  await rewriteRecord(s.rel, (r) => {
    r.files.push({ path: "runtime/../../../ESCAPED", bytes: 1, sha256: sha256Hex(Buffer.from("x")) });
    r.files.sort((a, b) => (a.path < b.path ? -1 : 1));
    r.runtime.bin.push({ name: "../../ESCAPED-bin", path: "runtime/bin/../../ESCAPED-bin", bytes: 1, sha256: sha256Hex(Buffer.from("x")) });
  });
  const out = path.join(s.root, "deep", "a", "out");
  const r = run("fetch-release.mjs", ["--from", s.rel, "--out", out]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /is not a safe release path/);
  assert.match(r.stderr, /runtime\.bin name "\.\.\/\.\.\/ESCAPED-bin" is not a safe, unreserved, unique file name/);
  assert.equal(fs.existsSync(path.join(s.root, "ESCAPED")), false);
  assert.equal(fs.existsSync(out), false, "nothing written");
});

test("fetch --only runtime refuses a swapped runtime manifest; failures leave no .partial files", () => {
  const s = released();
  const mf = path.join(s.rel, "runtime", "runtime-manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  m.sourceRevision = "tampered";
  fs.writeFileSync(mf, JSON.stringify(m, null, 2)); // same chunks, different bytes: not the listed manifest
  const out = path.join(s.root, "got");
  const r = run("fetch-release.mjs", ["--from", s.rel, "--out", out, "--only", "runtime"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /runtime\/runtime-manifest\.json: expected \d+ bytes sha256/);
  assert.equal(fs.existsSync(path.join(out, "bin", "lean.wasm")), false);
  const leftovers = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.includes(".partial-")) leftovers.push(p); } })(out);
  assert.deepEqual(leftovers, []);
});

test("fetch --digest pins the record; fetch --only all gives a dir verify accepts", () => {
  const s = released();
  const record = JSON.parse(fs.readFileSync(path.join(s.rel, "release.json"), "utf8"));
  let r = run("fetch-release.mjs", ["--from", s.rel, "--out", path.join(s.root, "x"), "--digest", `sha256:${"0".repeat(64)}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /digest is sha256:[0-9a-f]{64}, pinned sha256:0000/);
  const out = path.join(s.root, "got");
  r = run("fetch-release.mjs", ["--from", s.rel, "--out", out, "--id", record.id, "--digest", record.digest]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // `all` is the release, nothing else: no artifact layout beside it
  assert.ok(fs.existsSync(path.join(out, "SHA256SUMS")) && !fs.existsSync(path.join(out, "bin")));
  assert.ok(fs.existsSync(path.join(out, "lists", "extra-selection.json")), "files no group names are fetched too");
  r = run("verify-release.mjs", ["--release", out, "--deep"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.readFileSync(path.join(out, "release.json")).equals(fs.readFileSync(path.join(s.rel, "release.json"))), "release.json byte-identical");
  assert.ok(fs.readFileSync(path.join(out, "SHA256SUMS")).equals(fs.readFileSync(path.join(s.rel, "SHA256SUMS"))), "SHA256SUMS byte-identical");
});

test("verify-release refuses a record whose id, gate, runtime or pack fields contradict the rest", async () => {
  const { serializeRelease, sha256sums } = await import("../release-record.mjs");
  const cases = [
    [(r) => { r.gate.commit = "f".repeat(40); }, /gate\.commit ≠ kernel\.commit/],
    [(r) => { r.packs[0].rawBytes += 1; }, /FAIL  lean-core: release\.json rawSha256\/rawBytes/],
    [(r) => { r.runtime.sourceRevision = "elsewhere"; }, /FAIL  release\.json runtime .* target \/ sourceRevision = the manifest's/],
    [(r) => { r.runtime.target = "wasm32-unknown-emscripten"; }, /FAIL  release\.json runtime .* target \/ sourceRevision = the manifest's/],
  ];
  for (const [mutate, expected] of cases) {
    const s = released();
    await rewriteRecord(s.rel, mutate);
    const rec = JSON.parse(fs.readFileSync(path.join(s.rel, "release.json"), "utf8"));
    fs.writeFileSync(path.join(s.rel, "SHA256SUMS"), sha256sums([...rec.files, { path: "release.json", sha256: sha256Hex(Buffer.from(serializeRelease(rec))) }]));
    const r = run("verify-release.mjs", ["--release", s.rel]);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, expected);
  }
});


test("fetch refuses an empty or malformed pin instead of fetching unpinned", () => {
  const s = released();
  for (const args of [["--digest", ""], ["--digest"], ["--id", ""], ["--digest=sha256:XYZ"]]) {
    const r = run("fetch-release.mjs", ["--from", s.rel, "--out", path.join(s.root, "x"), ...args]);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(fs.existsSync(path.join(s.root, "x")), false);
  }
});

test("verify refuses a stray file, a non-canonical SHA256SUMS, a symlinked file and a file two artifacts claim", async () => {
  let s = released();
  fs.mkdirSync(path.join(s.rel, "bin")); fs.writeFileSync(path.join(s.rel, "bin", "leanmake"), "x"); // fetch's artifact layout is not a release file
  let r = run("verify-release.mjs", ["--release", s.rel]);
  assert.equal(r.status, 1); assert.match(r.stdout, /unlisted: bin\/leanmake/);
  s = released();
  fs.appendFileSync(path.join(s.rel, "SHA256SUMS"), "\n");
  r = run("verify-release.mjs", ["--release", s.rel]);
  assert.equal(r.status, 1); assert.match(r.stdout, /FAIL  SHA256SUMS is exactly the canonical text/);
  s = released();
  const list = path.join(s.rel, "lists", "essential-modules.txt");
  fs.renameSync(list, path.join(s.root, "real-list")); fs.symlinkSync(path.join(s.root, "real-list"), list);
  r = run("verify-release.mjs", ["--release", s.rel]);
  assert.equal(r.status, 1); assert.match(r.stdout, /not: lists\/essential-modules\.txt/);
  const t = stage();
  fs.renameSync(path.join(t.rel, "lists", "essential-modules.txt"), path.join(t.root, "real"));
  fs.symlinkSync(path.join(t.root, "real"), path.join(t.rel, "lists", "essential-modules.txt"));
  r = run("release.mjs", ["--release", t.rel, "--config", t.configPath]);
  assert.equal(r.status, 1); assert.match(r.stderr, /not a regular file/);
});

test("checkReleaseRecord: reserved runtime.bin names in any case, uncovered runtime/bin files, paths outside their dir", async () => {
  const { checkReleaseRecord, canonicalRelease } = await import("../release-record.mjs");
  const s = released();
  const base = JSON.parse(fs.readFileSync(path.join(s.rel, "release.json"), "utf8"));
  const resign = (mut) => { const { digest, ...r } = structuredClone(base); mut(r); return canonicalRelease(r); };
  assert.deepEqual(checkReleaseRecord(base), []);
  const lean = resign((r) => { const f = r.files.find((x) => x.path === "runtime/bin/leanmake"); r.runtime.bin = [{ name: "LEAN.JS", path: "runtime/bin/LEAN.JS", bytes: f.bytes, sha256: f.sha256 }]; });
  assert.ok(checkReleaseRecord(lean).some((p) => /LEAN\.JS.*not a safe, unreserved, unique file name/.test(p)));
  const uncovered = resign((r) => { r.runtime.bin = []; });
  assert.ok(checkReleaseRecord(uncovered).some((p) => /runtime\/bin files missing from runtime\.bin: runtime\/bin\/leanmake/.test(p)));
  const misplaced = resign((r) => { r.tools.tgz = r.modules.essential; });
  assert.ok(checkReleaseRecord(misplaced).some((p) => /tools\.tgz lists\/essential-modules\.txt is not under tools\//.test(p)));
});

test("verify refuses a pack whose file two artifacts claim (one would be unmountable)", async () => {
  const s = released();
  const mf = path.join(s.rel, "profiles", "lean-core.manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf8"));
  const mods = Object.values(m.content.modules);
  const [a, b] = [mods[0], mods[1]];
  Object.values(b.artifacts)[0].filename = Object.values(a.artifacts)[0].filename;
  m.digest = `sha256:${sha256Hex(Buffer.from(JSON.stringify(m.content)))}`;
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  await rewriteRecord(s.rel, (r) => { const f = r.files.find((x) => x.path === "profiles/lean-core.manifest.json"); f.bytes = fs.statSync(mf).size; f.sha256 = sha256Hex(fs.readFileSync(mf)); });
  const { serializeRelease, sha256sums } = await import("../release-record.mjs");
  const rec = JSON.parse(fs.readFileSync(path.join(s.rel, "release.json"), "utf8"));
  fs.writeFileSync(path.join(s.rel, "SHA256SUMS"), sha256sums([...rec.files, { path: "release.json", sha256: sha256Hex(Buffer.from(serializeRelease(rec))) }]));
  const r = run("verify-release.mjs", ["--release", s.rel]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL  lean-core: no file is claimed by two artifacts/);
});

test("each pack-manifest field browsers check is checked: own digest, encoding, parts sum, transport digest", async () => {
  const tamper = {
    "manifest digest": (m) => { m.digest = `sha256:${"0".repeat(64)}`; return false; },
    encoding: (m) => { m.content.pack.transport.encoding = "br"; return true; },
    "parts sum": (m) => { m.content.pack.transport.byteLength += 1; return true; },
    "transport digest": (m) => { m.content.pack.transport.digest = `sha256:${"1".repeat(64)}`; return true; },
  };
  for (const [name, fn] of Object.entries(tamper)) {
    const s = stage();
    const mf = path.join(s.rel, "profiles", "lean-core.manifest.json");
    const m = JSON.parse(fs.readFileSync(mf, "utf8"));
    if (fn(m)) m.digest = `sha256:${sha256Hex(Buffer.from(JSON.stringify(m.content)))}`; // re-sign unless the digest is the target
    fs.writeFileSync(mf, JSON.stringify(m, null, 2));
    const r = run("inspect.mjs", [mf]);
    assert.equal(r.status, 1, `inspect, ${name}: ${r.stdout}`);
    const rel = run("release.mjs", ["--release", s.rel, "--config", s.configPath]);
    if (name === "transport digest") {
      // release.mjs reads no part bytes; verify must catch it
      assert.equal(rel.status, 0, rel.stderr);
      const v = run("verify-release.mjs", ["--release", s.rel]);
      assert.equal(v.status, 1); assert.match(v.stdout, /FAIL  lean-core: \d+ transport parts and the transport digest/);
    } else {
      assert.equal(rel.status, 1, `release, ${name}`);
    }
  }
});

test("checkReleaseRecord closes nested objects and refuses paths that differ only in case", async () => {
  const { checkReleaseRecord, canonicalRelease } = await import("../release-record.mjs");
  const s = released();
  const base = JSON.parse(fs.readFileSync(path.join(s.rel, "release.json"), "utf8"));
  const resign = (mut) => { const { digest, ...r } = structuredClone(base); mut(r); return canonicalRelease(r); };
  assert.ok(checkReleaseRecord(resign((r) => { r.runtime.injected = 1; })).some((p) => /runtime: unknown keys injected/.test(p)));
  assert.ok(checkReleaseRecord(resign((r) => { r.packs[0].mathlib = "garbage"; })).some((p) => /mathlib is not an object/.test(p)));
  const cased = resign((r) => { const f = r.files.find((x) => x.path === "lists/essential-modules.txt"); r.files.push({ ...f, path: "lists/Essential-modules.txt" }); r.files.sort((a, b) => (a.path < b.path ? -1 : 1)); });
  assert.ok(checkReleaseRecord(cased).some((p) => /differ only in letter case/.test(p)));
});

test("fetch refuses an explicit group the release has no files for", async () => {
  const s = released();
  await rewriteRecord(s.rel, (r) => { r.files = r.files.filter((f) => !f.path.startsWith("native64/")); delete r.native64; });
  const r = run("fetch-release.mjs", ["--from", s.rel, "--out", path.join(s.root, "x"), "--only", "native64"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /no files for --only native64/);
});
