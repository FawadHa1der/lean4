// r2 (tools only): node-runner and persistent-probe follow QED64's argument grammar exactly
// (its SPECS["node-runner"] passthrough "implicit", SPECS["persistent-probe"] / ["snapshot-probe"]
// passthrough null, the one cliContract) and re-exec themselves with --stack-size=8192.
// Every script runs as a separate process on a fake artifact whose bin/lean.js echoes what
// it was given as JSON and exits: no runtime boots.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cliContract } from "../cli-args.mjs";

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STACK = ["--stack-size=8192"];
// hermetic: no artifact from the environment unless a test sets one ("" counts as unset)
const ENV = { ...process.env, LEAN4_WASM64_ARTIFACT: "", QED64_LEAN_ARTIFACT: "" };
const run = (script, args, opts = {}) => spawnSync(process.execPath, [...(opts.node ?? STACK), path.join(pkg, script), ...args], { encoding: "utf8", env: ENV, timeout: 60_000, ...opts });
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "l4w-args-")); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };

/** An artifact dir whose bin/lean.js prints {mark, leanArgs, pid, execArgv} and exits 0. */
function echoArtifact(mark) {
  const a = tmp();
  write(path.join(a, "bin", "lean.js"),
    `console.log(JSON.stringify({ mark: ${JSON.stringify(mark)}, leanArgs: globalThis.Module.arguments ?? null, pid: process.pid, execArgv: process.execArgv }));\nprocess.exit(0);\n`);
  write(path.join(a, "bin", "lean.wasm"), Buffer.from("not wasm"));
  fs.mkdirSync(path.join(a, "lib", "lean"), { recursive: true });
  return a;
}
const echoed = (r) => {
  assert.equal(r.status, 0, `${r.stderr}${r.stdout}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
};
const W = (name) => `node-runner: WARNING — ${name}`;
const P = (name) => `persistent-probe: WARNING — ${name}`;
const lines = (...l) => l.map((x) => `${x}\n`).join("");

// ---------- the grammar itself (QED64 tests/unit/cli-contract.test.ts, node-runner cases) ----------

test("cliContract with node-runner's spec reproduces QED64's grammar cases", () => {
  const spec = { tool: "node-runner", usage: "u", help: "H", flags: { artifact: 1, work: 1, lib: 1 }, required: [], passthrough: "implicit", passthroughRequired: false };
  const captured = (args) => {
    const io = { out: [], err: [], code: null };
    const result = cliContract(spec, args, { out: (s) => io.out.push(s), err: (s) => io.err.push(s), exit: (c) => { io.code = c; } });
    return { ...io, result };
  };
  assert.deepEqual(captured(["--artifact=/A", "--artifact", "/B", "--", "x.lean"]).result.args, ["--artifact", "/A", "--", "x.lean"]);
  const n = captured(["--work=w", "-o", "/work/x.olean", "--help"]);
  assert.equal(n.code, null);
  assert.deepEqual(n.err, []);
  assert.deepEqual(n.result.values, { work: "w" });
  assert.deepEqual(n.result.passthrough, ["-o", "/work/x.olean", "--help"]);
  assert.deepEqual(n.result.args, ["--work", "w", "-o", "/work/x.olean", "--help"]);
  assert.deepEqual(captured(["--", "--help"]).result.passthrough, ["--help"]);
  assert.equal(captured(["--artifact", "a", "--help", "/work/x.lean"]).code, 0);
  const u = captured(["--bogus", "x"]);
  assert.deepEqual(u.err, []);
  assert.deepEqual(u.result.passthrough, ["--bogus", "x"]);
  // the r2 promises, at the function level
  assert.deepEqual(captured(["--lib=l", "--x=y", "--lib", "m"]).result, { values: { lib: "l" }, passthrough: ["--x=y", "--lib", "m"], args: ["--lib", "l", "--x=y", "--lib", "m"] });
  const twice = captured(["--work", "a", "--work=b", "--lib", "", "p"]);
  assert.deepEqual(twice.err, ["node-runner: WARNING — flag --work repeated; the first value wins", "node-runner: WARNING — flag --lib has no value; ignored"]);
  assert.deepEqual(twice.result.values, { work: "a" });
  assert.deepEqual(twice.result.passthrough, ["p"]);
  assert.equal(captured(["--artifact", "--help"]).code, 0);
  assert.deepEqual(captured(["--lib", "--", "x"]).result.values, { lib: "--" }); // a value flag takes the next token, even `--` (as QED64)
});

// ---------- (a) node-runner ----------

test("node-runner: Lean's argv starts after `--`, or silently at the first token that is not a runner flag", () => {
  const a = echoArtifact("A");
  const w = tmp();
  for (const [args, leanArgs] of [
    [["--artifact", a, "--work", w, "--", "--help"], ["--help"]],
    [["--artifact", a, "--work", w, "--", "--", "x"], ["--", "x"]],
    [["--artifact", a, "--work", w, "--"], []],
    [["--artifact", a, "--work", w], []],
    [["--artifact", a, "--work", w, "-o", "/work/x.olean", "/work/x.lean"], ["-o", "/work/x.olean", "/work/x.lean"]],
    [["--artifact", a, "--work", w, "-D", "maxHeartbeats=0", "x.lean"], ["-D", "maxHeartbeats=0", "x.lean"]],
    [["--artifact", a, "--work", w, "--bogus", "x"], ["--bogus", "x"]],
    [["--artifact", a, "--work", w, "--bogus=1", "x"], ["--bogus=1", "x"]],
    [["--artifact", a, "--work", w, "--incr-header-save=/work/init.snap", "/work/probe.lean"], ["--incr-header-save=/work/init.snap", "/work/probe.lean"]],
    [[`--artifact=${a}`, `--work=${w}`, "/work/x.lean", "--help", "--artifact", "B", "--", "-h"], ["/work/x.lean", "--help", "--artifact", "B", "--", "-h"]],
    [["--work", w, "--artifact", a, "--lib", path.join(a, "lib", "lean"), "/work/x.lean"], ["/work/x.lean"]],
  ]) {
    const r = run("node-runner.mjs", args);
    assert.deepEqual(echoed(r).leanArgs, leanArgs, args.join(" "));
    assert.equal(r.stderr, "", args.join(" "));
  }
});

test("node-runner: a repeated flag keeps its first value, a flag without a value is ignored — one WARNING each", () => {
  const [a, b] = [echoArtifact("A"), echoArtifact("B")];
  const w = tmp();
  let r = run("node-runner.mjs", ["--artifact", a, `--artifact=${b}`, "--work", w, "--", "x"]);
  assert.equal(echoed(r).mark, "A");
  assert.equal(r.stderr, lines(W("flag --artifact repeated; the first value wins")));
  const w2 = path.join(tmp(), "second-work");
  r = run("node-runner.mjs", ["--artifact", a, "--work", w, "--work", w2, "x"]);
  assert.deepEqual(echoed(r).leanArgs, ["x"]);
  assert.equal(r.stderr, lines(W("flag --work repeated; the first value wins")));
  assert.equal(fs.existsSync(w2), false);
  r = run("node-runner.mjs", ["--artifact", a, "--work", w, "--lib"]); // the default library: <artifact>/lib/lean
  assert.deepEqual(echoed(r).leanArgs, []);
  assert.equal(r.stderr, lines(W("flag --lib has no value; ignored")));
  r = run("node-runner.mjs", ["--artifact", a, "--work", w, "--lib=", "x"]);
  assert.deepEqual(echoed(r).leanArgs, ["x"]);
  assert.equal(r.stderr, lines(W("flag --lib has no value; ignored")));
  r = run("node-runner.mjs", ["--artifact=", "--work", w, "x"], { env: { ...ENV, LEAN4_WASM64_ARTIFACT: b } }); // ignored: the variable applies
  assert.equal(echoed(r).mark, "B");
  assert.equal(r.stderr, lines(W("flag --artifact has no value; ignored")));
});

test("node-runner: --help/-h among the runner's flags prints the help, exit 0, before any side effect; among Lean's it is Lean's", () => {
  const a = echoArtifact("A");
  const d = tmp();
  const fresh = path.join(d, "fresh-work");
  for (const args of [["--help"], ["-h"], ["--artifact", "--help"], ["--artifact=-h"], ["--work", fresh, "--lib", "-h"],
    ["--artifact", a, "--work", fresh, "--help", "/work/x.lean"], ["--work", fresh, "-h", "--", "x"]]) {
    const r = run("node-runner.mjs", args, { env: { ...ENV, TMPDIR: d } });
    assert.equal(r.status, 0, args.join(" "));
    assert.match(r.stdout, /^usage: node-runner\.mjs --artifact <dir>/, args.join(" "));
    assert.equal(r.stderr, "", args.join(" "));
    assert.deepEqual(fs.readdirSync(d), [], `${args.join(" ")} touched the filesystem`);
  }
  for (const [args, leanArgs] of [[["--artifact", a, "--work", d, "x.lean", "--help"], ["x.lean", "--help"]], [["--artifact", a, "--work", d, "--", "-h"], ["-h"]]]) {
    assert.deepEqual(echoed(run("node-runner.mjs", args)).leanArgs, leanArgs);
  }
});

test("node-runner: a refused run (exit 2) creates neither --work nor the default temporary directory", () => {
  const d = tmp();
  const missing = path.join(d, "missing");
  const fresh = path.join(d, "fresh-work");
  const env = { ...ENV, TMPDIR: path.join(d, "tmpdir") };
  fs.mkdirSync(env.TMPDIR);
  const refused = (args, stderr) => {
    const r = run("node-runner.mjs", args, { env, cwd: d });
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, stderr, args.join(" "));
    assert.equal(fs.existsSync(fresh), false, `${args.join(" ")} created --work`);
    assert.deepEqual(fs.readdirSync(env.TMPDIR), [], `${args.join(" ")} created a temporary work dir`);
  };
  const noLeanJs = (dir) => `error: ${path.join(dir, "bin/lean.js")} not found — pass --artifact or set QED64_LEAN_ARTIFACT`;
  refused([`--artifact=${missing}`, "--work", fresh, "--bogus"], lines(noLeanJs(missing))); // QED64's own case
  refused([`--artifact=${missing}`, "--bogus"], lines(noLeanJs(missing))); // no --work: no temp dir, no "work dir" line
  refused(["--work", fresh, "x.lean"], lines("error: no runtime artifact — pass --artifact <dir> (bin/lean.js, bin/lean.wasm) or set LEAN4_WASM64_ARTIFACT"));
  const [first, second] = [path.join(missing, "first"), path.join(missing, "second")];
  refused(["--artifact", first, `--artifact=${second}`, "--work", fresh, "--", "x.lean"],
    lines(W("flag --artifact repeated; the first value wins"), noLeanJs(first))); // QED64's own case
  const a = echoArtifact("A");
  refused(["--artifact", a, "--lib", path.join(missing, "lib"), "--work", fresh], lines(`error: ${path.join(missing, "lib")} not found`));
  refused(["--artifact", a, "--work", fresh, "--lib", "--", "/work/x.lean"], lines(`error: ${path.join(fs.realpathSync(d), "--")} not found`));
});

// ---------- (b) persistent-probe ----------

test("persistent-probe: unknown flags and stray arguments are WARNINGs, the first value wins, --flag=value works", () => {
  const [a, b] = [echoArtifact("A"), echoArtifact("B")];
  const d = tmp();
  const good = path.join(d, "good.lean");
  fs.writeFileSync(good, "example : True := trivial\n");
  const missingCase = path.join(d, "missing.lean");
  let r = run("persistent-probe.mjs", [`--artifact=${a}`]);
  assert.equal(echoed(r).mark, "A");
  assert.equal(r.stderr, "");
  r = run("persistent-probe.mjs", ["stray", "--artifact", a, "--bogus", "--x=y", "--"]);
  assert.equal(echoed(r).mark, "A");
  assert.equal(r.stderr, lines(P("unexpected argument stray ignored"), P("unknown flag --bogus ignored"), P("unknown flag --x=y ignored"), P("unknown flag -- ignored")));
  r = run("persistent-probe.mjs", ["--artifact", a, "--artifact", b]);
  assert.equal(echoed(r).mark, "A");
  assert.equal(r.stderr, lines(P("flag --artifact repeated; the first value wins")));
  r = run("persistent-probe.mjs", ["--artifact"]);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, lines(P("flag --artifact has no value; ignored"), "error: no runtime artifact — pass --artifact <dir> or set LEAN4_WASM64_ARTIFACT"));
  // --cases is read at startup: the first of two values is the one read
  r = run("persistent-probe.mjs", ["--cases", good, `--cases=${missingCase}`, "--artifact", a, "--passes=3"]);
  assert.equal(echoed(r).mark, "A");
  assert.equal(r.stderr, lines(P("flag --cases repeated; the first value wins")));
  r = run("persistent-probe.mjs", ["--cases", missingCase, "--cases", good, "--artifact", a]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.startsWith(lines(P("flag --cases repeated; the first value wins"))), r.stderr);
  assert.match(r.stderr, /ENOENT[^\n]*missing\.lean/);
  // a value spelled like a flag is a value, not that flag (values from the contract, not indexOf)
  r = run("persistent-probe.mjs", ["--passes", "--artifact", "--artifact", a]);
  assert.equal(echoed(r).mark, "A");
});

test("persistent-probe: --help/-h anywhere, a value position included, prints the help, exit 0, before reading anything", () => {
  const d = tmp();
  const missingCase = path.join(d, "missing.lean");
  for (const args of [["--help"], ["-h"], ["--artifact", "--help"], ["--artifact=-h"], ["stray", "-h"], ["--cases", missingCase, "--help"], ["--", "--help"], ["--bogus", "--artifact", "--help"]]) {
    const r = run("persistent-probe.mjs", args);
    assert.equal(r.status, 0, args.join(" "));
    assert.match(r.stdout, /^usage: persistent-probe\.mjs --artifact <dir>/, args.join(" "));
    assert.equal(r.stderr, "", args.join(" "));
  }
});

// ---------- --stack-size ----------

for (const script of ["node-runner.mjs", "persistent-probe.mjs"]) {
  const tool = path.basename(script, ".mjs");
  test(`${tool}: started without --stack-size it re-execs itself with --stack-size=8192 (same PID); an explicit one is kept`, () => {
    const a = echoArtifact("A");
    const w = tmp();
    const args = script === "node-runner.mjs" ? ["--artifact", a, "--work", w, "--", "x"] : ["--artifact", a];
    let r = run(script, args, { node: [] });
    let out = echoed(r);
    assert.equal(out.pid, r.pid);
    assert.deepEqual(out.execArgv, ["--stack-size=8192"]);
    assert.equal(r.stderr, "");
    for (const flag of ["--stack-size=4000", "--stack_size=4000"]) {
      r = run(script, args, { node: [flag] });
      out = echoed(r);
      assert.deepEqual(out.execArgv, [flag]);
      assert.equal(out.pid, r.pid);
    }
    // the contract's WARNING is printed once, by the re-executed image
    r = run(script, ["--artifact", a, `--artifact=${a}`, ...args.slice(2)], { node: [] });
    assert.equal(echoed(r).pid, r.pid);
    assert.equal(r.stderr, `${tool}: WARNING — flag --artifact repeated; the first value wins\n`);
  });

  test(`${tool}: under an IPC channel (fork) it cannot re-exec: one WARNING, and it runs as started`, async () => {
    const a = echoArtifact("A");
    const w = tmp();
    const args = script === "node-runner.mjs" ? ["--artifact", a, "--work", w, "--", "x"] : ["--artifact", a];
    const child = fork(path.join(pkg, script), args, { execArgv: [], silent: true, env: ENV });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const [code] = await once(child, "exit");
    assert.equal(code, 0, stderr);
    const out = JSON.parse(stdout.trim());
    assert.equal(out.pid, child.pid);
    assert.deepEqual(out.execArgv, []);
    assert.equal(stderr, `${tool}: WARNING — started without --stack-size and cannot re-exec itself with it; run it as node --stack-size=8192 ${script} (formats/HOSTING.md)\n`);
  });
}

test("`lean4-wasm64 run` and `probe` pass --stack-size=8192 themselves: no re-exec, the same flags", () => {
  const a = echoArtifact("A");
  const w = tmp();
  for (const args of [["run", "--artifact", a, "--work", w, "--bogus", "x"], ["probe", "--artifact", a]]) {
    const r = run("cli.mjs", args, { node: [] });
    const out = echoed(r);
    assert.deepEqual(out.execArgv, ["--stack-size=8192"]);
    assert.notEqual(out.pid, r.pid); // the dispatcher spawns; the tool itself did not re-exec
    if (args[0] === "run") assert.deepEqual(out.leanArgs, ["--bogus", "x"]);
    assert.equal(r.stderr, "");
  }
});
