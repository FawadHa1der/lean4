// node-runner's --exit-with-parent and --parent-pid. The one-shot CLI never exits by itself
// (patches 0020/0031), so a runner whose starter is gone must exit by itself, and a --parent-pid
// that is not a pid, or not the runner's parent, is refused before anything is created. Each runner
// boots a fake artifact (its bin/lean.js marks that it was loaded, then never exits): no runtime
// boots. Moved here from bake.test.mjs when the package's bake was deleted (review D4 (a)).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "l4w-parent-")); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
async function waitFor(pred, what, ms = 15_000) {
  for (const t0 = Date.now(); !pred();) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** An artifact, a lib tree, and a --work path (not created). */
function fixture() {
  const root = tmp();
  const art = path.join(root, "art");
  write(path.join(art, "bin", "lean.wasm"), Buffer.from(`\0asm a fake runtime ${root}`));
  write(path.join(art, "bin", "lean.js"), "// never loaded by these tests\n");
  const lib = path.join(root, "lib");
  fs.mkdirSync(lib);
  return { root, art, lib, work: path.join(root, "work") };
}
/** Every path under `dir` with its size (directories too), so a refusal that touched the filesystem shows. */
function tree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(`${path.relative(dir, p)} ${e.isDirectory() ? "dir" : fs.lstatSync(p).size}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

test("--exit-with-parent: a runner whose parent is SIGKILLed while the runtime runs exits by itself", async () => {
  const f = fixture();
  const loaded = path.join(f.root, "lean-js-loaded");
  // a lean.js the runner loads: it marks the load, then never exits (patch 0031's wedge)
  fs.writeFileSync(path.join(f.art, "bin", "lean.js"), `require("fs").writeFileSync(${JSON.stringify(loaded)}, "");\nsetInterval(() => {}, 1000);\nsetTimeout(() => process.exit(9), 30_000);\n`);
  const parentScript = path.join(f.root, "parent.mjs");
  fs.writeFileSync(parentScript, `import { spawn } from "node:child_process";
import fs from "node:fs";
const c = spawn(process.execPath, ["--stack-size=8192", ${JSON.stringify(path.join(pkg, "node-runner.mjs"))}, "--exit-with-parent",
  "--artifact", ${JSON.stringify(f.art)}, "--lib", ${JSON.stringify(f.lib)}, "--work", ${JSON.stringify(f.work)}, "--", "/work/x.lean"], { stdio: "ignore", detached: false });
fs.writeFileSync(${JSON.stringify(path.join(f.root, "runner.pid"))}, String(c.pid));
for (const t0 = Date.now(); !fs.existsSync(${JSON.stringify(loaded)});) {
  if (Date.now() - t0 > 15_000) process.exit(7);
  await new Promise((r) => setTimeout(r, 20));
}
process.kill(process.pid, "SIGKILL"); // the runtime runs: only the parent watch can end the runner now
`);
  const r = spawnSync(process.execPath, [parentScript]);
  assert.equal(r.signal, "SIGKILL", `the parent exited ${r.status} before the runtime was loaded`);
  const pid = Number(fs.readFileSync(path.join(f.root, "runner.pid"), "utf8"));
  try {
    await waitFor(() => !alive(pid), `runner ${pid} to exit with its parent`, 5000);
  } finally {
    if (alive(pid)) process.kill(pid, "SIGKILL"); // only the PID this test recorded
  }
});

test("--exit-with-parent --parent-pid: a parent SIGKILLed before the runner's Node has even started is seen at once", async () => {
  const f = fixture();
  const loaded = path.join(f.root, "lean-js-loaded");
  fs.writeFileSync(path.join(f.art, "bin", "lean.js"), `require("fs").writeFileSync(${JSON.stringify(loaded)}, "");\nsetInterval(() => {}, 1000);\nsetTimeout(() => process.exit(9), 30_000);\n`);
  const parentScript = path.join(f.root, "parent.mjs");
  fs.writeFileSync(parentScript, `import { spawn } from "node:child_process";
import fs from "node:fs";
const c = spawn(process.execPath, ["--stack-size=8192", ${JSON.stringify(path.join(pkg, "node-runner.mjs"))}, "--exit-with-parent", "--parent-pid", String(process.pid),
  "--artifact", ${JSON.stringify(f.art)}, "--lib", ${JSON.stringify(f.lib)}, "--work", ${JSON.stringify(f.work)}, "--", "/work/x.lean"], { stdio: "ignore", detached: false });
fs.writeFileSync(${JSON.stringify(path.join(f.root, "runner.pid"))}, String(c.pid));
process.kill(process.pid, "SIGKILL"); // at once: the runner's Node is still starting
`);
  const r = spawnSync(process.execPath, [parentScript]);
  assert.equal(r.signal, "SIGKILL");
  const pid = Number(fs.readFileSync(path.join(f.root, "runner.pid"), "utf8"));
  try {
    await waitFor(() => !alive(pid), `runner ${pid} to see its parent gone`, 10_000);
  } finally {
    if (alive(pid)) process.kill(pid, "SIGKILL"); // only the PID this test recorded
  }
  assert.equal(fs.existsSync(loaded), false, "seen at once: before the runtime was ever loaded");
});

test("node-runner --parent-pid: not a pid, or a live process that is not its parent, is exit 2 with nothing created", () => {
  const f = fixture();
  for (const [value, line] of [
    ["abc", 'error: --parent-pid "abc" is not a pid'],
    ["0", 'error: --parent-pid "0" is not a pid'],
    ["99999999999", 'error: --parent-pid "99999999999" is not a pid'],
    ["1", `error: --parent-pid 1 is not this runner's parent (its parent is ${process.pid})`],
  ]) {
    const before = tree(f.root);
    const r = spawnSync(process.execPath, ["--stack-size=8192", path.join(pkg, "node-runner.mjs"), "--exit-with-parent", "--parent-pid", value, "--artifact", f.art, "--lib", f.lib, "--work", f.work, "--", "/work/x.lean"], { encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 2, `${value}: ${r.stderr}`);
    assert.equal(r.stderr.trim(), line);
    assert.deepEqual(tree(f.root), before, value);
  }
});
