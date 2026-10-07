// The CLI entry points on small synthetic fixtures: the dispatcher (signals,
// exit status, id, olean-imports), inspect (help, streaming, --deep range
// rules), unpack --slim, chunk-runtime's flag contract and the gate's
// children. Every script runs as a separate process, exactly as a user runs it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256Hex } from "../artifact-id.mjs";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (script, args, opts = {}) => spawnSync(process.execPath, [...(opts.node ?? []), path.join(pkg, script), ...args], { encoding: "utf8", ...opts });
const cli = (args, opts) => run("cli.mjs", args, opts);
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "l4w-cli-")); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v));
// deterministic, poorly compressible bytes, so ranges span many inflate chunks
const noise = (n, seed) => { const b = Buffer.alloc(n); let x = seed >>> 0 || 1; for (let i = 0; i < n; i += 1) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = x & 0xff; } return b; };

// ---------- fixtures ----------

/** An artifact dir whose bin/lean.js is `body` (node-runner and the probe run it with a global require). */
function fakeArtifact(body) {
  const a = tmp();
  write(path.join(a, "bin", "lean.js"), body);
  write(path.join(a, "bin", "lean.wasm"), Buffer.from("not wasm"));
  fs.mkdirSync(path.join(a, "lib", "lean"), { recursive: true });
  return a;
}

/** A pack (pack.mjs --no-imports) with private facets, a zero-length file and multi-chunk artifacts. */
function packFixture({ big = 0 } = {}) {
  const root = tmp();
  const lib = path.join(root, "lib");
  write(path.join(lib, "Init.olean"), noise(40_000, 1));
  write(path.join(lib, "Init.olean.private"), noise(3_000, 2));
  write(path.join(lib, "Init.ir"), Buffer.alloc(40, 4));
  write(path.join(lib, "Init.ir.sig"), Buffer.alloc(0));
  write(path.join(lib, "Init", "Prelude.olean"), noise(70_000, 3));
  write(path.join(lib, "Init", "Prelude.olean.private"), noise(500, 4));
  if (big) write(path.join(lib, "Init", "Big.olean"), Buffer.alloc(big, 7));
  const out = path.join(root, "out");
  const r = run("pack.mjs", ["--lib", lib, "--id", "fx", "--out", out, "--lean-version", "4.34.0", "--no-imports"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { root, lib, out, manifest: path.join(out, "fx.manifest.json"), rawPack: path.join(out, "fx.pack") };
}

/** Re-cut a manifest's transport into `size`-byte parts (bare names beside the manifest). */
function recut(manifestPath, size) {
  const dir = path.dirname(manifestPath);
  const m = readJson(manifestPath);
  const gz = Buffer.concat(m.content.pack.transport.parts.map((p) => fs.readFileSync(path.join(dir, path.basename(p.url)))));
  for (const p of m.content.pack.transport.parts) fs.rmSync(path.join(dir, path.basename(p.url)));
  m.content.pack.transport.parts = [];
  for (let at = 0, k = 0; at < gz.length; at += size, k += 1) {
    const piece = gz.subarray(at, at + size);
    const name = `fx.pack.gzip.${sha256Hex(piece).slice(0, 20)}.part-${String(k).padStart(3, "0")}`;
    fs.writeFileSync(path.join(dir, name), piece);
    m.content.pack.transport.parts.push({ url: name, digest: `sha256:${sha256Hex(piece)}`, byteLength: piece.length });
  }
  m.digest = `sha256:${sha256Hex(Buffer.from(JSON.stringify(m.content)))}`; // the manifest's own digest follows its content
  writeJson(manifestPath, m);
  return m;
}

/** A minimal 64-bit olean region carrying an import table (the layout olean-imports.mjs reads). */
function fakeOlean(imports) {
  const base = 0x2000000000n;
  const buf = Buffer.alloc(8192);
  buf.write("olean", 0, "latin1");
  buf.writeBigUInt64LE(base, 80);
  let top = 96;
  const alloc = (n) => { const o = top; top += Math.ceil(n / 8) * 8; return o; };
  const ptr = (o) => base + BigInt(o);
  const header = (o, tag, other) => { buf.writeUInt8(other, o + 6); buf.writeUInt8(tag, o + 7); };
  const str = (s) => {
    const b = Buffer.from(s, "utf8");
    const o = alloc(32 + b.length + 1);
    header(o, 249, 0);
    buf.writeBigUInt64LE(BigInt(b.length + 1), o + 8);
    b.copy(buf, o + 32);
    return o;
  };
  const name = (n) => {
    let w = 1n; // box 0 = anonymous
    for (const part of n.split(".")) {
      const s = str(part);
      const o = alloc(24);
      header(o, 1, 2);
      buf.writeBigUInt64LE(w, o + 8);
      buf.writeBigUInt64LE(ptr(s), o + 16);
      w = ptr(o);
    }
    return w;
  };
  const entries = imports.map(({ module, importAll }) => {
    const n = name(module);
    const o = alloc(24);
    header(o, 0, 1);
    buf.writeBigUInt64LE(n, o + 8);
    buf.writeUInt8(importAll ? 1 : 0, o + 16);
    return o;
  });
  const arr = alloc(24 + 8 * entries.length);
  header(arr, 246, 0);
  buf.writeBigUInt64LE(BigInt(entries.length), arr + 8);
  entries.forEach((o, k) => buf.writeBigUInt64LE(ptr(o), arr + 24 + 8 * k));
  const root = alloc(16);
  header(root, 0, 1);
  buf.writeBigUInt64LE(ptr(arr), root + 8);
  buf.writeBigUInt64LE(ptr(root), 88);
  return buf.subarray(0, top);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };

// ---------- #27 run/gate/probe: signals reach the runtime, status passes through ----------

test("killing `lean4-wasm64 gate` kills the runtime the gate is waiting on", async () => {
  const pidFile = path.join(tmp(), "runtime.pid");
  const a = fakeArtifact('require("fs").writeFileSync(process.env.L4W_PIDFILE, String(process.pid));\nsetInterval(() => {}, 1000);\n');
  const p = spawn(process.execPath, [path.join(pkg, "cli.mjs"), "gate", "--artifact", a], { stdio: "ignore", env: { ...process.env, L4W_PIDFILE: pidFile } });
  let runtimePid = null;
  try {
    for (let i = 0; i < 250 && !fs.existsSync(pidFile); i += 1) await new Promise((r) => setTimeout(r, 20));
    runtimePid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(alive(runtimePid));
    const exited = once(p, "exit");
    p.kill("SIGTERM");
    const [code] = await exited;
    assert.equal(code, 128 + os.constants.signals.SIGTERM);
    for (let i = 0; i < 100 && alive(runtimePid); i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(alive(runtimePid), false, `runtime ${runtimePid} outlived the gate`);
  } finally {
    if (runtimePid && alive(runtimePid)) process.kill(runtimePid, "SIGKILL"); // only the PID this test recorded
    if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  }
});

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  test(`killing \`lean4-wasm64 run\` with ${sig} kills the runtime and exits 128+n`, async () => {
    const a = fakeArtifact('console.log(`PID ${process.pid} ${process.execArgv.join(" ")}`);\nsetInterval(() => {}, 1000);\n');
    const p = spawn(process.execPath, [path.join(pkg, "cli.mjs"), "run", "--artifact", a, "--work", tmp(), "--", "/work/x.lean"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let runtimePid = null;
    try {
      await new Promise((resolve, reject) => {
        p.stdout.on("data", (d) => { out += d; if (/PID \d+/.test(out)) resolve(); });
        p.on("exit", () => reject(new Error(`exited before the runtime started: ${out}`)));
      });
      const [, pid, execArgv] = /PID (\d+) ?([^\n]*)/.exec(out);
      runtimePid = Number(pid);
      assert.notEqual(runtimePid, p.pid);
      assert.match(execArgv, /--stack-size=8192/);
      const exited = once(p, "exit");
      p.kill(sig);
      const [code, signal] = await exited;
      assert.equal(signal, null);
      assert.equal(code, 128 + os.constants.signals[sig]);
      for (let i = 0; i < 50 && alive(runtimePid); i += 1) await new Promise((r) => setTimeout(r, 20));
      assert.equal(alive(runtimePid), false, `runtime ${runtimePid} outlived its CLI`);
    } finally {
      if (runtimePid && alive(runtimePid)) process.kill(runtimePid, "SIGKILL"); // only the PID this test recorded
      if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    }
  });
}

test("the dispatcher exits with the child's status, a signal as 128+n", () => {
  assert.equal(cli(["run", "--artifact", fakeArtifact("process.exit(7);\n"), "--work", tmp(), "--", "/work/x.lean"]).status, 7);
  const r = cli(["run", "--artifact", fakeArtifact('process.kill(process.pid, "SIGKILL");\n'), "--work", tmp(), "--", "/work/x.lean"]);
  assert.equal(r.signal, null);
  assert.equal(r.status, 128 + os.constants.signals.SIGKILL);
  assert.equal(cli(["unpack"]).status, 2); // a plain tool's usage exit still passes through
});

// ---------- #53 id ----------

test("`lean4-wasm64 id --help` prints usage, exit 0; no dir exits 2; a bad dir exits 1 without a stack", () => {
  for (const h of ["--help", "-h"]) {
    const r = cli(["id", h]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /usage: lean4-wasm64 id <artifact dir>/);
  }
  let r = cli(["id"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: lean4-wasm64 id <artifact dir>/);
  r = cli(["id", path.join(tmp(), "nope")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^id: .*bin\/lean\.wasm: not found/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
  const a = fakeArtifact("");
  r = cli(["id", a]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `wasm64-${sha256Hex(Buffer.from("not wasm")).slice(0, 16)}`);
});

// ---------- #46/#54 olean-imports ----------

test("`lean4-wasm64 olean-imports` is dispatched: help, usage and a real audit", () => {
  let r = cli(["--help"]);
  assert.match(r.stdout, /^\s+olean-imports\s/m);
  r = cli(["olean-imports", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /run as: lean4-wasm64 olean-imports/);
  assert.equal(cli(["olean-imports"]).status, 2);
  const tree = tmp();
  write(path.join(tree, "Foo", "Bar.olean"), fakeOlean([{ module: "Init", importAll: false }, { module: "Mathlib.Data.X", importAll: true }]));
  write(path.join(tree, "Lean", "Y.olean"), fakeOlean([{ module: "Lean.Z", importAll: true }]));
  r = cli(["olean-imports", `--audit=${tree}`]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /2 modules, 2 `import all` edge\(s\)/);
  assert.match(r.stdout, /outside Init\/Std\/Lean\/Lake: 1/);
  assert.match(r.stdout, /Foo\.Bar → import all Mathlib\.Data\.X/);
  // the module half still runs no CLI when imported, and runs it through a symlinked package dir
  const link = path.join(tmp(), "pkg");
  fs.symlinkSync(pkg, link);
  r = spawnSync(process.execPath, [path.join(link, "olean-imports.mjs"), "--audit", tree], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 modules, 2 `import all` edge\(s\)/);
  r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { oleanImports } from ${JSON.stringify(pathToFileURL(path.join(pkg, "olean-imports.mjs")).href)}; console.log(JSON.stringify(oleanImports(Buffer.from(${JSON.stringify([...fakeOlean([{ module: "A.B", importAll: false }])])}))))`], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), '["A.B"]', r.stderr);
});

// ---------- #36/#52/#44/#28 inspect ----------

test("`inspect --help` prints usage, exit 0, before reading anything; no manifest exits 2", () => {
  for (const args of [["--help"], ["-h"], ["--deep", "--help"], ["/nonexistent.json", "--help"]]) {
    const r = run("inspect.mjs", args);
    assert.equal(r.status, 0, `${args}: ${r.stderr}`);
    assert.match(r.stdout, /usage: inspect\.mjs <manifest\.json> \[--pack <file>\] \[--deep\]/);
  }
  const r = cli(["inspect", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--deep/);
  assert.equal(run("inspect.mjs", []).status, 2);
  assert.equal(run("inspect.mjs", ["--deep"]).status, 2);
});

test("inspect --deep streams a multi-part pack: PASS, every artifact verified, flags in any order", () => {
  const f = packFixture();
  const m = recut(f.manifest, 4096);
  assert.ok(m.content.pack.transport.parts.length > 5);
  const artifacts = Object.values(m.content.modules).reduce((n, mod) => n + Object.keys(mod.artifacts).length, 0);
  for (const args of [[f.manifest, "--deep"], ["--deep", f.manifest], [`--manifest=${f.manifest}`, "--deep"]]) {
    const r = run("inspect.mjs", args);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(` ok   ${artifacts} artifact digests verified`));
    assert.match(r.stdout, / ok {3}raw pack digest/);
    assert.match(r.stdout, /\nPASS/);
  }
  // --pack hashes the raw file instead; an unknown flag warns and is ignored
  const r = run("inspect.mjs", [f.manifest, "--pack", f.rawPack, "--deep", "--bogus"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /inspect: WARNING — unknown flag --bogus ignored/);
  assert.match(r.stdout, new RegExp(`${artifacts} artifact digests verified`));
});

test("inspect never hashes the raw pack in one update() nor inflates it in one gunzipSync()", () => {
  // Node refuses a hash update over 2 GiB (the 3.57 GB essential pack); scaled
  // down: a preload refuses any update over 1 MiB and any gunzipSync at all.
  const f = packFixture({ big: 3 * 1024 * 1024 });
  const guard = path.join(tmp(), "guard.mjs");
  fs.writeFileSync(guard, [
    'import crypto from "node:crypto"; import zlib from "node:zlib"; import { syncBuiltinESMExports } from "node:module";',
    'const proto = Object.getPrototypeOf(crypto.createHash("sha256")); const update = proto.update;',
    'proto.update = function (d, e) { if (d.length > (1 << 20)) throw new Error(`hash update of ${d.length} bytes`); return update.call(this, d, e); };',
    'zlib.gunzipSync = () => { throw new Error("gunzipSync"); }; syncBuiltinESMExports();',
  ].join("\n"));
  const node = ["--import", pathToFileURL(guard).href];
  const sanity = spawnSync(process.execPath, [...node, "-e", 'require("node:crypto").createHash("sha256").update(Buffer.alloc(2 << 20))'], { encoding: "utf8" });
  assert.notEqual(sanity.status, 0, "the guard is active");
  for (const args of [[f.manifest, "--deep"], [f.manifest, "--deep", "--pack", f.rawPack]]) {
    const r = run("inspect.mjs", args, { node });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, / ok {3}raw pack byteLength = 3\d{6}\n/);
    assert.match(r.stdout, /\nPASS/);
  }
});

test("inspect --deep: each module artifact needs exactly one in-bounds range of its own", () => {
  const f = packFixture();
  const base = readJson(f.manifest);
  const tamper = (edit) => {
    const m = structuredClone(base);
    edit(m.content);
    writeJson(f.manifest, m);
    return run("inspect.mjs", [f.manifest, "--deep"]);
  };
  const fileOf = (c, name) => c.workerfs.metadata.files.find((x) => x.filename === name);

  // the finding's case: one artifact's range removed, another's listed twice
  let r = tamper((c) => {
    const fs_ = c.workerfs.metadata.files;
    fs_.splice(fs_.indexOf(fileOf(c, "/Init/Prelude.olean")), 1);
    fs_.push({ ...fileOf(c, "/Init.olean") });
  });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL {2}range \/Init\.olean listed 2 times/);
  assert.match(r.stdout, /FAIL {2}artifact Init\.Prelude\.olean — no WORKERFS range for \/Init\/Prelude\.olean/);
  assert.match(r.stdout, /FAIL {2}artifact Init\.olean — 2 WORKERFS ranges for \/Init\.olean/);
  assert.doesNotMatch(r.stdout, /\nPASS/);

  // a range simply missing is a failure, not a skip
  r = tamper((c) => { c.workerfs.metadata.files = c.workerfs.metadata.files.filter((x) => x.filename !== "/Init.ir"); });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL {2}artifact Init\.ir — no WORKERFS range for \/Init\.ir/);
  assert.match(r.stdout, /FAIL {2}\d+\/\d+ artifact digests verified/);

  // out of bounds
  r = tamper((c) => { fileOf(c, "/Init/Prelude.olean").end = c.pack.byteLength + 1; });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL {2}range \/Init\/Prelude\.olean\n/);
  assert.match(r.stdout, /FAIL {2}artifact Init\.Prelude\.olean — range of \/Init\/Prelude\.olean out of bounds/);

  // overlapping ranges (the browser loader refuses them)
  r = tamper((c) => { fileOf(c, "/Init/Prelude.olean").start -= 16; });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL {2}range \/Init\/Prelude\.olean overlaps \/Init\.olean\.private/);

  // two artifacts naming one file
  r = tamper((c) => { c.modules.Init.artifacts.ir.filename = "Init.olean"; });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL {2}artifact Init\.ir — \/Init\.olean is claimed by 2 artifacts/);

  // a wrong artifact digest
  r = tamper((c) => { c.modules["Init.Prelude"].artifacts.olean.digest = `sha256:${"0".repeat(64)}`; });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FAIL {2}artifact Init\.Prelude\.olean\n/);

  // without --deep the range table is still checked; untampered passes
  r = tamper(() => {});
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /WORKERFS ranges in bounds, one per filename, none overlapping/);
});

test("inspect reports a tampered or missing part and still checks every part", () => {
  const f = packFixture();
  const m = recut(f.manifest, 4096);
  const parts = m.content.pack.transport.parts;
  const p1 = path.join(f.out, parts[1].url);
  const b = fs.readFileSync(p1); b[10] ^= 0xff; fs.writeFileSync(p1, b);
  fs.rmSync(path.join(f.out, parts[3].url));
  const r = run("inspect.mjs", [f.manifest, "--deep"]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, new RegExp(`FAIL {2}part ${parts[1].url}`));
  assert.match(r.stdout, new RegExp(`FAIL {2}transport part present: ${parts[3].url}`));
  assert.match(r.stdout, new RegExp(` ok {3}part ${parts.at(-1).url}`));
  assert.match(r.stdout, /FAIL {2}raw pack reconstructible/);
  assert.equal((r.stdout.match(/part fx\.pack\.gzip|transport part present/g) ?? []).length, parts.length);
});

// ---------- #23 unpack --slim ----------

test("unpack --slim leaves out *.olean.private and still verifies every part and the raw pack", () => {
  const f = packFixture();
  recut(f.manifest, 4096);
  let r = run("unpack.mjs", ["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--slim\s+do not write \*\.olean\.private/);
  const full = path.join(tmp(), "full");
  r = run("unpack.mjs", ["--manifest", f.manifest, "--out", full]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(full, "Init.olean.private")));
  assert.doesNotMatch(r.stdout, /--slim/);
  const slim = path.join(tmp(), "slim");
  r = cli(["unpack", "--manifest", f.manifest, "--out", slim, "--slim"]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /WARNING/);
  assert.match(r.stdout, /--slim: 2 \*\.olean\.private left out/);
  const listing = (d) => fs.readdirSync(d, { recursive: true }).filter((p) => fs.statSync(path.join(d, p)).isFile()).sort();
  assert.deepEqual(listing(slim), ["Init.ir", "Init.ir.sig", "Init.olean", path.join("Init", "Prelude.olean")]);
  for (const p of listing(slim)) assert.ok(fs.readFileSync(path.join(slim, p)).equals(fs.readFileSync(path.join(f.lib, p))), p);
  // verification is unchanged by --slim: a bad part still fails
  const m = readJson(f.manifest);
  const last = path.join(f.out, m.content.pack.transport.parts.at(-1).url);
  fs.appendFileSync(last, "x");
  r = run("unpack.mjs", ["--manifest", f.manifest, "--out", path.join(tmp(), "slim2"), "--slim"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /FAIL: transport part .* failed verification/);
});

// ---------- #45 chunk-runtime ----------

test("chunk-runtime follows the flag contract; its manifest bytes are unchanged", () => {
  const root = tmp();
  const bin = path.join(root, "bin");
  const js = noise(2500, 9);
  const wasm = noise(5000, 10);
  write(path.join(bin, "lean.js"), js);
  write(path.join(bin, "lean.wasm"), wasm);
  const USAGE = "usage: chunk-runtime.mjs --bin <dir> --out <dir> --lean-version <x.y.z> --revision <string> [--url-prefix /runtime/chunks/] [--part-bytes n] [--initial-memory n] [--maximum-memory n]";
  let r = run("chunk-runtime.mjs", ["--help"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${USAGE}\n`);
  r = run("chunk-runtime.mjs", ["--bin", bin, "--out", path.join(root, "o0"), "--lean-version", "4.34.0"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: chunk-runtime\.mjs --bin/);
  assert.equal(fs.existsSync(path.join(root, "o0")), false);

  const rev = "qed64-wasm64@a8817d01f9 (upstream v4.34.0)";
  r = run("chunk-runtime.mjs", ["--bin", bin, "--out", path.join(root, "o1"), "--lean-version", "4.34.0", "--revision", rev, "--part-bytes", "1024"]);
  assert.equal(r.status, 0, r.stderr);
  r = run("chunk-runtime.mjs", [`--bin=${bin}`, `--out=${path.join(root, "o2")}`, "--lean-version=4.34.0", `--revision=${rev}`, "--part-bytes=1024", "--url-prefx", "/cdn/"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /chunk-runtime: WARNING — unknown flag --url-prefx ignored/);
  const text = fs.readFileSync(path.join(root, "o1", "runtime-manifest.json"), "utf8");
  assert.equal(fs.readFileSync(path.join(root, "o2", "runtime-manifest.json"), "utf8"), text);

  // the format, rebuilt independently (key order included)
  const chunks = (name, bytes) => {
    const out = [];
    for (let at = 0, k = 0; at < bytes.length; at += 1024, k += 1) {
      const piece = bytes.subarray(at, at + 1024);
      const d = sha256Hex(piece);
      out.push({ url: `/runtime/chunks/${name}.${d.slice(0, 20)}.part-${String(k).padStart(3, "0")}`, bytes: piece.length, sha256: d });
    }
    return { bytes: bytes.length, sha256: sha256Hex(bytes), chunks: out };
  };
  const buildId = `wasm64-${sha256Hex(wasm).slice(0, 16)}`;
  const expected = JSON.stringify({
    schema: "org.lean-browser64.runtime/v1", buildId, leanVersion: "4.34.0", sourceRevision: rev,
    target: "wasm64-unknown-emscripten", pointerBits: 64,
    memory: { initialBytes: 134217728, maximumBytes: 17179869184, shared: true },
    files: { "lean.js": chunks("lean.js", js), "lean.wasm": chunks("lean.wasm", wasm) },
  }, null, 2);
  assert.equal(text, expected);
  assert.equal(fs.readFileSync(path.join(root, "o1", `runtime-manifest.${buildId}.json`), "utf8"), expected);
});

// ---------- #55 gate ----------

test("the gate boots its children on this Node with --stack-size=8192, whatever PATH holds", () => {
  const log = path.join(tmp(), "children.jsonl");
  const a = fakeArtifact('require("node:fs").appendFileSync(process.env.L4W_TEST_LOG, JSON.stringify({ execPath: process.execPath, execArgv: process.execArgv }) + "\\n");\nprocess.exit(0);\n');
  const emptyPath = tmp(); // no `node` on PATH at all
  const r = run("gate.mjs", ["--artifact", a], { env: { ...process.env, PATH: emptyPath, L4W_TEST_LOG: log }, timeout: 120_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr); // a fake runtime fails the checks, but every child ran
  const children = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(children.length, 11); // 9 one-shot runs (3 of them deep-recursion probes) + the persistent probe + the 0037 async-cases persistent probe
  for (const c of children) {
    assert.equal(c.execPath, process.execPath);
    assert.ok(c.execArgv.includes("--stack-size=8192"), JSON.stringify(c.execArgv));
  }
});
