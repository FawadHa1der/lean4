// r2 (f): node-runner lays out the VFS as QED64's runner does where it decides snapshot bytes.
// Lean names the main module after the input's path relative to the VFS cwd (Shell.lean
// moduleNameOfFileName), and lean_main's Node prologue (src/util/shell.cpp) sets that cwd from
// the HOST cwd after preRun — so a bake is byte-identical to QED64's only when the runner's host
// cwd is "/" (QED64 pipeline/snapshot/node-runner.mjs: process.chdir("/")). No runtime boots:
// the fake bin/lean.js stands in for the glue, runs preRun against a recording FS, replays the
// prologue's /home and /tmp mounts, and prints what the runtime would see.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV = { ...process.env, LEAN4_WASM64_ARTIFACT: "", QED64_LEAN_ARTIFACT: "", LEAN4_WASM64_CWD: "", LEAN_PATH: "/somewhere/else" };
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "l4w-vfs-")); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };

/** How each glue generation offers NODEFS and a path lookup to a host (runtime-knobs.mjs glueFilesystem, vfsExists):
 *  6.0.5 keeps NODEFS in FS.filesystems; 7.0.0 has no FS.filesystems (emscripten#27940) and the kernel's link
 *  exports NODEFS on Module; -sSTRICT also drops the deprecated FS.analyzePath (#27765), leaving FS.lookupPath;
 *  a 7.0.0 link without the export leaves only the glue's top-level var (a global under vm.runInThisContext). */
const GLUES = {
  "emsdk 6.0.5": { nodefs: "M.FS.filesystems = { MEMFS: {}, NODEFS };", analyzePath: true },
  "emsdk 7.0.0": { nodefs: "M.NODEFS = NODEFS;", analyzePath: true },
  "emsdk 7.0.0 -sSTRICT": { nodefs: "M.NODEFS = NODEFS;", analyzePath: false },
  "emsdk 7.0.0 without the NODEFS export": { nodefs: "", analyzePath: true, globalVar: true },
};
const FAKE_GLUE = (glue = "emsdk 6.0.5") => `
const M = globalThis.Module;
${GLUES[glue].globalVar ? "var" : "const"} NODEFS = { name: "NODEFS" };
const mounts = [], lookups = [];
// FAKE_EXISTS=all|none answers every lookup so; unset, a path exists when it lies under a mount
const exists = (p) => (process.env.FAKE_EXISTS ? process.env.FAKE_EXISTS === "all" : mounts.some(([, mp]) => p === mp || p.startsWith(mp + "/")));
M.FS = {
  mkdir() {},
  chdir() {},
  lookupPath(p, opts) { lookups.push(["lookupPath", p, opts]); if (!exists(p)) throw new Error("ENOENT"); return { path: p, node: {} }; },
  mount(type, opts, mp) { if (type !== NODEFS) throw new Error("FS.mount: not the glue's NODEFS"); mounts.push([opts.root, mp]); return {}; },
};
${GLUES[glue].analyzePath ? 'M.FS.analyzePath = (p) => { lookups.push(["analyzePath", p]); return { exists: exists(p) }; };' : ""}
${GLUES[glue].nodefs}
M.ENV = {};
for (const f of M.preRun) f();
M.FS.mount(NODEFS, { root: "/home" }, "/home"); // the prologue's own mounts, after preRun
M.FS.mount(NODEFS, { root: "/tmp" }, "/tmp");
console.log(JSON.stringify({ cwd: process.cwd(), hostLeanPath: process.env.LEAN_PATH, envLeanPath: M.ENV.LEAN_PATH, leanArgs: M.arguments, mounts, lookups }));
process.exit(0);
`;

function layout(extraArgs = [], env = {}, glue = "emsdk 6.0.5") {
  const a = tmp();
  write(path.join(a, "bin", "lean.js"), FAKE_GLUE(glue));
  write(path.join(a, "bin", "lean.wasm"), Buffer.from("not wasm"));
  fs.mkdirSync(path.join(a, "lib", "lean"), { recursive: true });
  const work = path.join(tmp(), "work");
  const r = spawnSync(process.execPath, ["--stack-size=8192", path.join(pkg, "node-runner.mjs"), "--artifact", a, "--work", work, ...extraArgs, "--", "/work/probe.lean"],
    { encoding: "utf8", env: { ...ENV, ...env }, timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { a, work, workReal: fs.realpathSync.native(work), stderr: r.stderr, ...JSON.parse(r.stdout.trim().split("\n").at(-1)) };
}
const has = (mounts, root, mp) => mounts.some(([r, m]) => r === root && m === mp);

for (const glue of Object.keys(GLUES)) test(`node-runner [${glue} glue]: Lean's cwd is the VFS root /, LEAN_PATH is pinned, /lib/lean and /work mounted, no work-dir mirror (QED64's bake layout)`, () => {
  for (const extra of [[], ["--lib", null]]) {
    const lib = extra.length ? tmp() : null;
    const out = layout(extra.length ? ["--lib", lib] : [], {}, glue);
    assert.equal(out.cwd, "/"); // /work/probe.lean is then module `work.probe`, as under QED64's runner
    assert.equal(out.hostLeanPath, "/lib/lean"); // an inherited host LEAN_PATH never reaches the prologue
    assert.equal(out.envLeanPath, "/lib/lean");
    assert.deepEqual(out.leanArgs, ["/work/probe.lean"]);
    // every host directory is mounted by its real path (a NODEFS root that is a symlink cannot be walked)
    assert.ok(has(out.mounts, fs.realpathSync(lib ?? path.join(out.a, "lib", "lean")), "/lib/lean"), JSON.stringify(out.mounts));
    assert.ok(has(out.mounts, fs.realpathSync(out.work), "/work"), JSON.stringify(out.mounts));
    const bin = path.join(out.a, "bin");
    assert.ok(has(out.mounts, fs.realpathSync(bin), bin), JSON.stringify(out.mounts)); // patch 0031: lean.js's host dir
    assert.equal(out.mounts.filter(([, mp]) => mp === "/lib/lean" || mp === "/work").every(([root]) => root === fs.realpathSync(root)), true);
    assert.ok(has(out.mounts, fs.realpathSync("/tmp"), "/tmp")); // the prologue's symlinked roots, resolved
    assert.equal(out.mounts.some(([, mp]) => mp === out.workReal), false, "the work dir is not mirrored at its host path");
    assert.equal(out.stderr, "");
  }
});

test("node-runner: LEAN4_WASM64_CWD=work keeps the pre-r2 layout (cwd = the work dir); any other value is a WARNING and ignored", () => {
  const out = layout([], { LEAN4_WASM64_CWD: "work" });
  assert.equal(out.cwd, out.workReal);
  const inVfs = out.workReal.replace(/^\/private\/tmp(?=\/|$)/, "/tmp");
  assert.equal(has(out.mounts, out.workReal, out.workReal), !/^\/(tmp|home)(\/|$)/.test(inVfs));
  const bogus = layout([], { LEAN4_WASM64_CWD: "here" });
  assert.equal(bogus.cwd, "/");
  assert.equal(bogus.stderr, "node-runner: WARNING — LEAN4_WASM64_CWD=here ignored (only `work` is known); the cwd is /\n");
});

test("node-runner: with --lib, <artifact>/lib/lean is shadowed exactly where the VFS says it exists, asked through FS.analyzePath or, without it, FS.lookupPath", () => {
  for (const glue of Object.keys(GLUES)) {
    const lib = tmp();
    for (const answer of ["all", "none"]) {
      const out = layout(["--lib", lib], { FAKE_EXISTS: answer }, glue);
      const builtins = [...new Set([out.a, fs.realpathSync(out.a)])].map((d) => path.join(d, "lib", "lean"));
      for (const b of builtins) assert.equal(has(out.mounts, fs.realpathSync(lib), b), answer === "all", `${glue}, ${answer}: ${b} ${JSON.stringify(out.mounts)}`);
      // the lookups are the shadow's own, one per built-in path each time it is laid (preRun, then after /home and /tmp)
      assert.deepEqual(out.lookups, Array.from({ length: 3 }, () => builtins).flat()
        .map((b) => (GLUES[glue].analyzePath ? ["analyzePath", b] : ["lookupPath", b, { follow: true }])), `${glue}, ${answer}`);
    }
    assert.deepEqual(layout([], { FAKE_EXISTS: "all" }, glue).lookups, [], glue); // without --lib nothing is shadowed or looked up
  }
});

test("node-runner on a glue that exposes no NODEFS fails with the clear error, before any mount", () => {
  const a = tmp();
  write(path.join(a, "bin", "lean.js"), FAKE_GLUE("emsdk 7.0.0").replace("M.NODEFS = NODEFS;", ""));
  write(path.join(a, "bin", "lean.wasm"), Buffer.from("not wasm"));
  fs.mkdirSync(path.join(a, "lib", "lean"), { recursive: true });
  const r = spawnSync(process.execPath, ["--stack-size=8192", path.join(pkg, "node-runner.mjs"), "--artifact", a, "--work", path.join(tmp(), "work"), "--", "/work/probe.lean"],
    { encoding: "utf8", env: ENV, timeout: 60_000 });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /the runtime's glue exposes no NODEFS: not as Module\.NODEFS \(exported from emsdk 7 on\), FS\.filesystems\.NODEFS \(emsdk 6\) or a global NODEFS/);
  assert.equal(r.stdout, "");
});

test("node-runner: a --lib (or --work) given as a symbolic link to a directory is mounted by its target, so the VFS can walk it", () => {
  const target = tmp();
  const link = path.join(tmp(), "lib-link");
  fs.symlinkSync(target, link);
  const out = layout(["--lib", link]);
  assert.ok(has(out.mounts, fs.realpathSync(target), "/lib/lean"), JSON.stringify(out.mounts));
  assert.equal(out.mounts.some(([root]) => root === link), false, "the link itself is never a NODEFS root");
});
