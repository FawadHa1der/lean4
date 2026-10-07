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

const FAKE_GLUE = `
const M = globalThis.Module;
const NODEFS = { name: "NODEFS" };
const mounts = [];
M.FS = {
  filesystems: { NODEFS },
  mkdir() {},
  chdir() {},
  analyzePath(p) { return { exists: mounts.some(([, mp]) => p === mp || p.startsWith(mp + "/")) }; },
  mount(type, opts, mp) { mounts.push([opts.root, mp]); return {}; },
};
M.ENV = {};
for (const f of M.preRun) f();
M.FS.mount(NODEFS, { root: "/home" }, "/home"); // the prologue's own mounts, after preRun
M.FS.mount(NODEFS, { root: "/tmp" }, "/tmp");
console.log(JSON.stringify({ cwd: process.cwd(), hostLeanPath: process.env.LEAN_PATH, envLeanPath: M.ENV.LEAN_PATH, leanArgs: M.arguments, mounts }));
process.exit(0);
`;

function layout(extraArgs = [], env = {}) {
  const a = tmp();
  write(path.join(a, "bin", "lean.js"), FAKE_GLUE);
  write(path.join(a, "bin", "lean.wasm"), Buffer.from("not wasm"));
  fs.mkdirSync(path.join(a, "lib", "lean"), { recursive: true });
  const work = path.join(tmp(), "work");
  const r = spawnSync(process.execPath, ["--stack-size=8192", path.join(pkg, "node-runner.mjs"), "--artifact", a, "--work", work, ...extraArgs, "--", "/work/probe.lean"],
    { encoding: "utf8", env: { ...ENV, ...env }, timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return { a, work, workReal: fs.realpathSync.native(work), stderr: r.stderr, ...JSON.parse(r.stdout.trim().split("\n").at(-1)) };
}
const has = (mounts, root, mp) => mounts.some(([r, m]) => r === root && m === mp);

test("node-runner: Lean's cwd is the VFS root /, LEAN_PATH is pinned, /lib/lean and /work mounted, no work-dir mirror (QED64's bake layout)", () => {
  for (const extra of [[], ["--lib", null]]) {
    const lib = extra.length ? tmp() : null;
    const out = layout(extra.length ? ["--lib", lib] : []);
    assert.equal(out.cwd, "/"); // /work/probe.lean is then module `work.probe`, as under QED64's runner
    assert.equal(out.hostLeanPath, "/lib/lean"); // an inherited host LEAN_PATH never reaches the prologue
    assert.equal(out.envLeanPath, "/lib/lean");
    assert.deepEqual(out.leanArgs, ["/work/probe.lean"]);
    assert.ok(has(out.mounts, lib ?? path.join(out.a, "lib", "lean"), "/lib/lean"), JSON.stringify(out.mounts));
    assert.ok(has(out.mounts, out.work, "/work"), JSON.stringify(out.mounts));
    const bin = path.join(out.a, "bin");
    assert.ok(has(out.mounts, bin, bin), JSON.stringify(out.mounts)); // patch 0031: lean.js's host dir
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
