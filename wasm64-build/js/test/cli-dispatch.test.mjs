// The dispatcher (cli.mjs): every command but `id` runs as its child, with this Node, the stack flag when
// the tool boots the runtime, the arguments verbatim and this environment; the dispatcher passes
// SIGINT, SIGTERM and SIGHUP to it. The tools are stubs in a copy of the dispatcher's package dir
// (cli.mjs + package.json beside a stub script of a table name), so these tests depend on cli.mjs
// alone, not on the tools behind it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "l4w-dispatch-")); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
const STACK = ["--stack-size=8192"];

// A stub tool: one JSON line {mark, pid, ppid, execArgv, argv, env}, then, by its own
// arguments, `--exit <n>`, `--die` (SIGKILLs itself) or `--wait` (stays alive).
const STUB = (mark) => `const at = (f) => process.argv.indexOf(f);
console.log(JSON.stringify({ mark: ${JSON.stringify(mark)}, pid: process.pid, ppid: process.ppid, execArgv: process.execArgv, argv: process.argv.slice(2), env: process.env.L4W_DISPATCH_MARK ?? null }));
if (at("--exit") >= 0) process.exit(Number(process.argv[at("--exit") + 1]));
if (at("--die") >= 0) setTimeout(() => process.kill(process.pid, "SIGKILL"), 50); // after stdout drained
if (at("--wait") >= 0) setInterval(() => {}, 1000);
`;

/** A copy of the dispatcher with a stub tool under the script its table names for `probe`. */
function stubPackage() {
  const d = tmp();
  for (const f of ["cli.mjs", "package.json"]) fs.copyFileSync(path.join(pkg, f), path.join(d, f));
  fs.writeFileSync(path.join(d, "persistent-probe.mjs"), STUB("probe"));
  return d;
}
const stubs = fs.realpathSync(stubPackage()); // the path cli.mjs sees (import.meta.url is resolved: /var → /private/var)
const ENV = { ...process.env, L4W_DISPATCH_MARK: "inherited" };
const dispatch = (args, opts = {}) => spawnSync(process.execPath, [path.join(stubs, "cli.mjs"), ...args], { encoding: "utf8", env: ENV, timeout: 30_000, ...opts });
const stubLine = (stdout) => JSON.parse(stdout.trim().split("\n").at(-1));

test("`lean4-wasm64 probe` (every command but `id`) runs as the dispatcher's child, with its arguments and environment verbatim", () => {
  const args = ["--name", "x", "--help", "--", "--y=1"];
  let r = dispatch(["probe", ...args, "--exit", "0"]);
  assert.equal(r.status, 0, r.stderr);
  const out = stubLine(r.stdout);
  assert.equal(out.mark, "probe");
  assert.notEqual(out.pid, r.pid);
  assert.equal(out.ppid, r.pid);
  assert.deepEqual(out.execArgv, STACK); // the stack flag: the probe boots the runtime
  assert.deepEqual(out.argv, [...args, "--exit", "0"]); // --help is the tool's
  assert.equal(out.env, "inherited");
  assert.equal(r.stderr, "");
  r = dispatch(["probe", "--exit", "7"]);
  assert.equal(r.status, 7);
  r = dispatch(["probe", "--die"]);
  assert.equal(r.signal, null);
  assert.equal(r.status, 128 + os.constants.signals.SIGKILL); // the child's signal as 128+n
});

test("SIGTERM to the dispatcher is passed on: it exits 143 and the tool is gone", async () => {
  const p = spawn(process.execPath, [path.join(stubs, "cli.mjs"), "probe", "--wait"], { stdio: ["ignore", "pipe", "pipe"], env: ENV });
  let stdout = "";
  let toolPid = null;
  try {
    await new Promise((resolve, reject) => {
      p.stdout.on("data", (d) => { stdout += d; if (stdout.includes("\n")) resolve(); });
      p.on("exit", () => reject(new Error(`exited before the tool started: ${stdout}`)));
    });
    toolPid = stubLine(stdout).pid;
    assert.notEqual(toolPid, p.pid);
    const exited = once(p, "exit");
    p.kill("SIGTERM");
    const [code, signal] = await exited;
    assert.equal(signal, null);
    assert.equal(code, 128 + os.constants.signals.SIGTERM);
    for (let i = 0; i < 100 && alive(toolPid); i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(alive(toolPid), false, `tool ${toolPid} outlived its dispatcher`);
  } finally {
    if (toolPid && alive(toolPid)) process.kill(toolPid, "SIGKILL"); // only the PID this test recorded
    if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  }
});

test("under --permission without --allow-child-process: one refusal line and exit 1, no stack", () => {
  const r = spawnSync(process.execPath, ["--permission", "--allow-fs-read=*", path.join(stubs, "cli.mjs"), "probe", "--exit", "0"], { encoding: "utf8", env: ENV, timeout: 30_000 });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  const [first, ...more] = r.stderr.split("\n").filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l) && l !== "");
  assert.match(first, /^lean4-wasm64: .*--allow-child-process/);
  assert.deepEqual(more, []);
});

test("`lean4-wasm64 --help` lists the commands; bake and snapshot-probe are QED64's (unknown here, exit 2)", () => {
  const r = spawnSync(process.execPath, [path.join(pkg, "cli.mjs"), "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (const cmd of ["fetch", "verify", "release", "run", "gate", "probe", "chunk", "pack", "pack-set", "unpack", "inspect", "olean-imports", "id"]) {
    assert.match(r.stdout, new RegExp(`^ {2}${cmd} `, "m"), cmd);
  }
  assert.doesNotMatch(r.stdout, /^ {2}(bake|snapshot-probe) /m);
  assert.match(r.stdout, /^Every command but `id` runs as this process's child, which is passed SIGINT, SIGTERM and SIGHUP\.$/m);
  for (const cmd of ["bake", "snapshot-probe"]) {
    const u = spawnSync(process.execPath, [path.join(pkg, "cli.mjs"), cmd], { encoding: "utf8" });
    assert.equal(u.status, 2, cmd);
    assert.equal(u.stderr, `lean4-wasm64: unknown command ${JSON.stringify(cmd)}\n`);
  }
});
