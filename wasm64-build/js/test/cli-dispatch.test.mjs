// The dispatcher's two ways of starting a tool (cli.mjs): `bake` and `snapshot-probe`
// REPLACE the dispatcher (process.execve: the tool runs in the PID the caller started),
// every other command is a child the dispatcher passes signals to; where execve cannot
// work, the two fall back to the child with one WARNING. The tools are stubs in a copy of
// the dispatcher's package dir (cli.mjs + package.json beside stub scripts of the tables'
// names), so these tests depend on cli.mjs alone, not on the tools behind it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fork, spawn, spawnSync } from "node:child_process";
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

/** A copy of the dispatcher with stub tools under the scripts its table names. */
function stubPackage() {
  const d = tmp();
  for (const f of ["cli.mjs", "package.json"]) fs.copyFileSync(path.join(pkg, f), path.join(d, f));
  for (const [script, mark] of [["bake-snapshot.mjs", "bake"], ["snapshot-probe.mjs", "snapshot-probe"], ["persistent-probe.mjs", "probe"]]) {
    fs.writeFileSync(path.join(d, script), STUB(mark));
  }
  return d;
}
const stubs = fs.realpathSync(stubPackage()); // the path cli.mjs sees (import.meta.url is resolved: /var → /private/var)
const ENV = { ...process.env, L4W_DISPATCH_MARK: "inherited" };
const dispatch = (args, opts = {}) => spawnSync(process.execPath, [path.join(stubs, "cli.mjs"), ...args], { encoding: "utf8", env: ENV, timeout: 30_000, ...opts });
const stubLine = (stdout) => JSON.parse(stdout.trim().split("\n").at(-1));
const IN_PID = [["bake", []], ["snapshot-probe", STACK]];
const warning = (cmd, why, node) => `lean4-wasm64: WARNING — cannot run ${cmd} in this process (${why}); it runs as a child, so a SIGKILL of this PID would orphan it; for one PID run node ${[...node, path.join(stubs, cmd === "bake" ? "bake-snapshot.mjs" : "snapshot-probe.mjs")].join(" ")}\n`;

// ---------- exec dispatch: the PID the caller started is the tool's ----------

for (const [cmd, execArgv] of IN_PID) {
  test(`\`lean4-wasm64 ${cmd}\` runs the tool in the PID its caller started, with its arguments and environment verbatim`, () => {
    const args = ["--name", "x", "--help", "--", "--y=1"];
    const r = dispatch([cmd, ...args, "--exit", "0"]);
    assert.equal(r.status, 0, r.stderr);
    const out = stubLine(r.stdout);
    assert.equal(out.mark, cmd);
    assert.equal(out.pid, r.pid); // execve: no process in between
    assert.equal(out.ppid, process.pid);
    assert.deepEqual(out.execArgv, execArgv); // the stack flag only for the runtime-booting probe
    assert.deepEqual(out.argv, [...args, "--exit", "0"]); // --help is the tool's
    assert.equal(out.env, "inherited");
    assert.equal(r.stderr, ""); // nothing printed by the dispatcher
  });

  test(`\`lean4-wasm64 ${cmd}\`: the exit status is the tool's own, a death by signal included (not 128+n)`, () => {
    let r = dispatch([cmd, "--exit", "7"]);
    assert.equal(r.status, 7);
    r = dispatch([cmd, "--die"]);
    assert.equal(r.status, null);
    assert.equal(r.signal, "SIGKILL");
    assert.equal(stubLine(r.stdout).pid, r.pid);
  });

  test(`\`lean4-wasm64 ${cmd}\`: a SIGKILL of the caller's PID kills the tool itself, nothing is orphaned`, async () => {
    const p = spawn(process.execPath, [path.join(stubs, "cli.mjs"), cmd, "--wait"], { stdio: ["ignore", "pipe", "pipe"], env: ENV });
    let out = "";
    let toolPid = null;
    try {
      await new Promise((resolve, reject) => {
        p.stdout.on("data", (d) => { out += d; if (out.includes("\n")) resolve(); });
        p.on("exit", () => reject(new Error(`exited before the tool started: ${out}`)));
      });
      toolPid = stubLine(out).pid;
      assert.equal(toolPid, p.pid);
      const exited = once(p, "exit");
      p.kill("SIGKILL");
      const [, signal] = await exited;
      assert.equal(signal, "SIGKILL");
      assert.equal(alive(toolPid), false, `tool ${toolPid} outlived the PID its caller killed`);
    } finally {
      if (toolPid && alive(toolPid)) process.kill(toolPid, "SIGKILL"); // only the PID this test recorded
      if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    }
  });
}

// ---------- the fallback: no execve here → one WARNING, then the child and its forwarding ----------

for (const [cmd, execArgv] of IN_PID) {
  test(`\`lean4-wasm64 ${cmd}\` under an IPC channel (fork) cannot exec: one WARNING, then it runs as a child`, async () => {
    const child = fork(path.join(stubs, "cli.mjs"), [cmd, "--exit", "5"], { execArgv: [], silent: true, env: ENV });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const [code] = await once(child, "exit");
    assert.equal(code, 5, stderr); // the child's status passes through
    const out = stubLine(stdout);
    assert.equal(out.mark, cmd);
    assert.notEqual(out.pid, child.pid);
    assert.equal(out.ppid, child.pid);
    assert.deepEqual(out.execArgv, execArgv);
    assert.equal(out.env, "inherited");
    assert.equal(stderr, warning(cmd, "an IPC channel, which an exec would drop", execArgv));
  });
}

test("the fallback still passes SIGTERM on: the dispatcher exits 143 and the tool is gone", async () => {
  const child = fork(path.join(stubs, "cli.mjs"), ["bake", "--wait"], { execArgv: [], silent: true, env: ENV });
  let stdout = "";
  let toolPid = null;
  try {
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (d) => { stdout += d; if (stdout.includes("\n")) resolve(); });
      child.on("exit", () => reject(new Error(`exited before the tool started: ${stdout}`)));
    });
    toolPid = stubLine(stdout).pid;
    assert.notEqual(toolPid, child.pid);
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    assert.equal(signal, null);
    assert.equal(code, 128 + os.constants.signals.SIGTERM);
    for (let i = 0; i < 100 && alive(toolPid); i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(alive(toolPid), false, `tool ${toolPid} outlived its dispatcher`);
  } finally {
    if (toolPid && alive(toolPid)) process.kill(toolPid, "SIGKILL"); // only the PID this test recorded
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("in a Worker thread the dispatcher cannot exec: one WARNING, then the child", () => {
  const driver = path.join(tmp(), "worker-driver.mjs"); // a file: a Worker inherits -e's --input-type
  fs.writeFileSync(driver, `import { Worker } from "node:worker_threads";
const w = new Worker(${JSON.stringify(path.join(stubs, "cli.mjs"))}, { argv: ["snapshot-probe", "--exit", "4"] });
w.on("exit", (code) => process.exit(code === 4 ? 0 : 10));
`);
  const r = spawnSync(process.execPath, [driver], { encoding: "utf8", env: ENV, timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = stubLine(r.stdout);
  assert.equal(out.ppid, r.pid); // a child of the process the Worker lives in
  assert.deepEqual(out.execArgv, STACK);
  assert.equal(r.stderr, warning("snapshot-probe", "a Worker thread", STACK));
});

test("under --permission without --allow-child-process: the WARNING, then one refusal line and exit 1, no stack", () => {
  const r = spawnSync(process.execPath, ["--permission", "--allow-fs-read=*", path.join(stubs, "cli.mjs"), "bake", "--exit", "0"], { encoding: "utf8", env: ENV, timeout: 30_000 });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  const [first, second, ...more] = r.stderr.split("\n").filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l) && l !== "");
  assert.equal(`${first}\n`, warning("bake", "--permission without --allow-child-process", []));
  assert.match(second, /^lean4-wasm64: .*--allow-child-process/);
  assert.deepEqual(more, []);
});

// ---------- every other command is unchanged: a child of the dispatcher ----------

test("`lean4-wasm64 probe` (and every command but the two) still runs as the dispatcher's child", () => {
  let r = dispatch(["probe", "--exit", "0"]);
  assert.equal(r.status, 0, r.stderr);
  const out = stubLine(r.stdout);
  assert.equal(out.mark, "probe");
  assert.notEqual(out.pid, r.pid);
  assert.equal(out.ppid, r.pid);
  assert.deepEqual(out.execArgv, STACK);
  assert.equal(r.stderr, "");
  r = dispatch(["probe", "--die"]);
  assert.equal(r.signal, null);
  assert.equal(r.status, 128 + os.constants.signals.SIGKILL); // the child's signal as 128+n, as before
});

test("`lean4-wasm64 --help` lists bake and snapshot-probe and says how each command is started", () => {
  const r = spawnSync(process.execPath, [path.join(pkg, "cli.mjs"), "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}bake +bake an environment snapshot/m);
  assert.match(r.stdout, /^ {2}snapshot-probe +load a baked snapshot/m);
  assert.match(r.stdout, /^`bake` and `snapshot-probe` replace this process \(the same PID\)/m);
});
