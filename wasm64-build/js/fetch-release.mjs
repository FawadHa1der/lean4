#!/usr/bin/env node
// Fetch a lean4-wasm64 release (or parts of it) and verify every byte.
//
//   fetch-release.mjs --from <url|dir> --out <dir> [--only <groups>] [--id <id>] [--digest sha256:<hex>] [--layout served|flat]
//
// --from   a base URL or a local directory holding the release:
//            served layout  https://<site>/lean4-wasm64/<id>/   or a release dir   (paths as in release.json)
//            flat layout    https://github.com/<owner>/<repo>/releases/download/<id>/   (GitHub assets, by basename)
//          The layout is inferred (GitHub URLs and dirs without runtime/ are flat); --layout overrides.
// --only   comma list of: all (default: every file of the release, served layout), runtime-chunks
//          (runtime/), a pack id (lean-core, …, lean-lib), packs, native64, lists, tools, and
//          runtime: the ARTIFACT layout <out>/bin/lean.js, lean.wasm + extras that `run`, `gate`
//          and bakes take as --artifact — never implied by `all`.
// --id     refuse unless release.json names this id.
// --digest refuse unless release.json's digest is this one — the pin: a self-digest
//          alone proves only consistency, so a consumer pins id AND digest.
//
// release.json is read first and checked structurally (release-record.mjs
// checkReleaseRecord: the id rule, the gate binding, safe paths, …) before
// anything is written; each file is streamed to disk while hashed and kept only
// if its sha256 and size match release.json, and every destination must lie
// inside --out. Files already present with the right digest are not fetched
// again (resume). `runtime` fetches the runtime manifest as a listed file,
// rebuilds lean.js / lean.wasm from its chunks, binds both to release.json and
// recomputes the build id. `--only all` (the default) also writes SHA256SUMS, so
// <out> is a complete release dir that `verify` accepts. Exit 0 = fetched and verified, 1 = a
// digest or identity check failed (nothing unverified is left in place), 2 = usage.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import { applyCliContract } from "./cli-args.mjs";
import { RELEASE_SCHEMA, buildIdFromSha256, checkRuntimeManifest, sha256File } from "./artifact-id.mjs";
import { CHUNK_URL, checkReleaseRecord, serializeRelease, servedPath, sha256sums } from "./release-record.mjs";

applyCliContract({
  tool: "fetch",
  usage: "fetch-release.mjs --from <url|dir> --out <dir> [--only <groups>] [--id <id>] [--digest sha256:<hex>] [--layout served|flat]",
  flags: { from: 1, out: 1, only: 1, id: 1, digest: 1, layout: 1 },
  required: [["from"], ["out"]],
  passthrough: null,
  help: [
    "usage: fetch-release.mjs --from <url|dir> --out <dir> [--only <groups>] [--id <id>] [--digest sha256:<hex>] [--layout served|flat]",
    "Fetch a lean4-wasm64 release, or parts of it, verifying every byte against release.json.",
    "run as: lean4-wasm64 fetch   (or: node fetch-release.mjs)",
    "",
    "flags:",
    "  --from <url|dir>   release base: served layout (R2 prefix, release dir) or flat (GitHub release download URL) [required]",
    "  --out <dir>        where to write [required]",
    "  --only <groups>    all (every release file; default) | runtime-chunks | <pack id> | packs | native64 | lists | tools,",
    "                     and runtime: the artifact layout <out>/bin (lean.js, lean.wasm, extras) — never part of all",
    "  --id <id>          refuse unless release.json names this release id",
    "  --digest <d>       refuse unless release.json's digest is <d> (pin id AND digest)",
    "  --layout <l>       served | flat (default: inferred from --from)",
    "  -h, --help         print this help and exit 0",
    "",
    "exit codes: 0 fetched and verified, 1 a check failed, 2 usage",
  ].join("\n"),
});
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
// A pin given without a usable value must not fail open (`--digest "$UNSET"` in CI).
for (const pin of ["id", "digest"]) {
  if (argv.some((a) => a === `--${pin}` || a.startsWith(`--${pin}=`)) && !arg(pin)) {
    console.error(`fetch: --${pin} was given without a value: refusing to fetch unpinned`);
    process.exit(2);
  }
}
if (arg("digest") && !/^sha256:[0-9a-f]{64}$/.test(arg("digest"))) {
  console.error(`fetch: --digest must be sha256:<64 lowercase hex>, got ${JSON.stringify(arg("digest"))}`);
  process.exit(2);
}
const from = arg("from");
const out = path.resolve(arg("out"));
const only = new Set(String(arg("only", "all")).split(",").map((s) => s.trim()).filter(Boolean));
const isUrl = /^https?:\/\//.test(from);
const layout = arg("layout") ?? (isUrl ? (/\/releases\/download\//.test(from) ? "flat" : "served")
  : (fs.existsSync(path.join(from, "runtime")) ? "served" : "flat"));
if (!["served", "flat"].includes(layout)) { console.error("fetch: --layout must be served or flat"); process.exit(2); }

const base = isUrl ? (from.endsWith("/") ? from : `${from}/`) : path.resolve(from);
const locate = (relPath) => {
  const name = layout === "flat" ? path.posix.basename(relPath) : relPath;
  return isUrl ? new URL(name, base).href : path.join(base, name);
};

async function openSource(relPath) {
  const where = locate(relPath);
  if (!isUrl) return fs.createReadStream(where);
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(where, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${where}`);
      return Readable.fromWeb(res.body);
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

/** <out>/<rel>, refusing anything that would land outside <out> (belt to checkReleaseRecord's braces). */
function inside(rel) {
  const target = path.resolve(out, rel);
  if (!target.startsWith(out + path.sep)) throw new Error(`${rel}: resolves outside --out`);
  return target;
}

// Temp files are `<target>.partial-<pid>`, so two fetches into one --out never share one;
// a signal removes this run's, and each target's leftovers from runs no longer alive are
// swept before it is written.
const temps = new Set();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
function tempFor(target) {
  const dir = path.dirname(target), base = path.basename(target);
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const m = f.startsWith(`${base}.partial-`) && /^\d+$/.exec(f.slice(base.length + 9));
    if (m && Number(m[0]) !== process.pid && !alive(Number(m[0]))) fs.rmSync(path.join(dir, f), { force: true });
  }
  const tmp = `${target}.partial-${process.pid}`;
  temps.add(tmp);
  return tmp;
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    for (const t of temps) fs.rmSync(t, { force: true });
    process.exit(128 + os.constants.signals[sig]);
  });
}

/** Fetch one file to <out>/<dest>, verified against {bytes, sha256}; resume-aware. */
async function fetchVerified(relPath, expect, dest = relPath) {
  const target = inside(dest);
  if (fs.existsSync(target) && fs.statSync(target).size === expect.bytes && (await sha256File(target)) === expect.sha256) return "kept";
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = tempFor(target);
  try {
    const h = createHash("sha256");
    let n = 0;
    const src = await openSource(relPath);
    src.on("data", (d) => { h.update(d); n += d.length; });
    await pipeline(src, fs.createWriteStream(tmp));
    const hex = h.digest("hex");
    if (n !== expect.bytes || hex !== expect.sha256) {
      throw new Error(`${relPath}: expected ${expect.bytes} bytes sha256 ${expect.sha256.slice(0, 16)}…, got ${n} bytes ${hex.slice(0, 16)}…`);
    }
    fs.renameSync(tmp, target);
    return "fetched";
  } finally {
    fs.rmSync(tmp, { force: true }); // gone after a rename; removed after any failure
    temps.delete(tmp);
  }
}

async function readText(relPath) {
  const chunks = [];
  for await (const c of await openSource(relPath)) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

// ---------- release.json ----------
let record;
try {
  record = JSON.parse(await readText("release.json"));
} catch (e) {
  console.error(`fetch: cannot read release.json from ${locate("release.json")}: ${e.message}`);
  process.exit(1);
}
if (record?.schema !== RELEASE_SCHEMA) { console.error(`fetch: release.json schema ${record?.schema} is not ${RELEASE_SCHEMA}`); process.exit(1); }
const recordProblems = checkReleaseRecord(record);
if (recordProblems.length) { console.error(`fetch: release.json refused — ${recordProblems.length} problem(s):\n  ${recordProblems.join("\n  ")}`); process.exit(1); }
if (arg("id") && record.id !== arg("id")) { console.error(`fetch: release is ${record.id}, expected ${arg("id")}`); process.exit(1); }
if (arg("digest") && record.digest !== arg("digest")) { console.error(`fetch: release.json digest is ${record.digest}, pinned ${arg("digest")}`); process.exit(1); }
fs.mkdirSync(out, { recursive: true });
const recordText = serializeRelease(record);
fs.writeFileSync(path.join(out, "release.json"), recordText);
console.log(`release ${record.id} (${record.digest.slice(0, 23)}…): Lean ${record.lean.version}, runtime ${record.runtime.buildId}, kernel ${record.kernel.commit.slice(0, 10)} (${record.kernel.patch}) — ${layout} layout from ${isUrl ? base : from}`);

const byPath = new Map(record.files.map((f) => [f.path, f]));
// `all` is every release file (the served layout, a release dir); the artifact layout
// (`runtime`: <out>/bin rebuilt from the chunks) is never implied — ask for it
const want = (g) => only.has(g) || (g !== "runtime" && only.has("all"));
const selected = new Set();
const add = (p) => { if (byPath.has(p)) selected.add(p); else throw new Error(`release.json lists no ${p}`); };
const packFiles = (packId) => record.files.filter((f) => f.path.startsWith(`profiles/${packId}.`)).map((f) => f.path);
const under = (dir) => record.files.filter((f) => f.path.startsWith(`${dir}/`)).map((f) => f.path);

let failures = 0;
try {
  if (only.has("all")) record.files.forEach((f) => add(f.path)); // everything listed, whatever its group
  if (want("runtime-chunks")) under("runtime").forEach(add);
  for (const pk of record.packs ?? []) if (want("packs") || want(pk.id)) packFiles(pk.id).forEach(add);
  if (want("native64")) under("native64").forEach(add);
  if (want("lists")) under("lists").forEach(add);
  if (want("tools")) under("tools").forEach(add);
  const unknown = [...only].filter((g) => !["all", "runtime", "runtime-chunks", "packs", "native64", "lists", "tools"].includes(g) && !(record.packs ?? []).some((p) => p.id === g));
  if (unknown.length) { console.error(`fetch: unknown --only group(s): ${unknown.join(", ")}`); process.exit(2); }
  // a group asked for by name must bring something: a release without it is not what was asked
  const groupFiles = { "runtime-chunks": under("runtime"), packs: (record.packs ?? []).flatMap((k) => packFiles(k.id)), native64: under("native64"), lists: under("lists"), tools: under("tools") };
  const empty = [...only].filter((g) => groupFiles[g] && groupFiles[g].length === 0);
  if (empty.length) throw new Error(`this release has no files for --only ${empty.join(", ")}`);

  let fetched = 0, kept = 0;
  for (const p of [...selected].sort()) {
    const r = await fetchVerified(p, byPath.get(p));
    if (r === "fetched") fetched++; else kept++;
  }
  if (selected.size) console.log(`${selected.size} files verified (${fetched} fetched, ${kept} already present)`);

  if (want("runtime")) {
    // the artifact layout: <out>/bin/lean.js + lean.wasm rebuilt from verified chunks. The
    // manifest is itself a listed file: fetched against its digest, never read unverified.
    const rt = record.runtime;
    await fetchVerified(rt.manifest, byPath.get(rt.manifest));
    const manifest = JSON.parse(fs.readFileSync(inside(rt.manifest), "utf8"));
    const problems = checkRuntimeManifest(manifest);
    if (problems.length) throw new Error(`runtime manifest: ${problems.join("; ")}`);
    if (manifest.buildId !== rt.buildId) throw new Error(`runtime manifest ${manifest.buildId} ≠ release ${rt.buildId}`);
    const bin = inside("bin");
    fs.mkdirSync(bin, { recursive: true });
    for (const name of ["lean.js", "lean.wasm"]) {
      const file = manifest.files[name];
      const expected = rt.files[name];
      if (file.bytes !== expected.bytes || file.sha256 !== expected.sha256 || file.chunks.length !== expected.chunks) {
        throw new Error(`runtime manifest's ${name} (${file.bytes} bytes, ${file.chunks.length} chunks) is not release.json's (${expected.bytes} bytes, ${expected.chunks} chunks)`);
      }
      // every chunk is checked against release.json before anything is written
      const chunks = file.chunks.map((c) => {
        if (!CHUNK_URL.test(c.url)) throw new Error(`${name}: chunk url ${c.url} is not /runtime/chunks/<name>`);
        const relPath = servedPath(c.url, rt.manifest);
        const exp = byPath.get(relPath);
        if (!exp || exp.bytes !== c.bytes || exp.sha256 !== c.sha256) throw new Error(`${relPath}: chunk is not listed in release.json with these bytes`);
        return { c, relPath, exp };
      });
      const target = path.join(bin, name);
      if (fs.existsSync(target) && fs.statSync(target).size === file.bytes && (await sha256File(target)) === file.sha256) continue;
      const tmp = tempFor(target);
      const ws = fs.createWriteStream(tmp);
      try {
        await once(ws, "open");
        const whole = createHash("sha256");
        for (const { c, relPath, exp } of chunks) {
          const staged = inside(relPath);
          let data;
          if (fs.existsSync(staged) && (await sha256File(staged)) === c.sha256) data = fs.readFileSync(staged);
          else {
            const parts = [];
            for await (const d of await openSource(relPath)) parts.push(Buffer.from(d));
            data = Buffer.concat(parts);
          }
          if (data.length !== exp.bytes || createHash("sha256").update(data).digest("hex") !== c.sha256) throw new Error(`${relPath}: chunk failed verification`);
          whole.update(data);
          if (!ws.write(data)) await once(ws, "drain");
        }
        await new Promise((r, j) => ws.end((e) => (e ? j(e) : r())));
        if (whole.digest("hex") !== expected.sha256) throw new Error(`${name}: whole-file digest mismatch`);
        fs.renameSync(tmp, target);
      } finally {
        if (!ws.closed) { ws.destroy(); await once(ws, "close").catch(() => {}); }
        fs.rmSync(tmp, { force: true });
        temps.delete(tmp);
      }
    }
    for (const extra of rt.bin ?? []) await fetchVerified(extra.path, byPath.get(extra.path), `bin/${extra.name}`);
    for (const extra of rt.bin ?? []) if (/^lean(make)?$/.test(extra.name)) fs.chmodSync(path.join(bin, extra.name), 0o755);
    // The glue is CommonJS and every pthread re-loads lean.js as a Worker script: under a
    // "type": "module" package.json (this package's own, say) that is ESM and each pthread dies
    // with "require is not defined". Pin the nearest package.json (EMBED-RUNTIME.md, Node).
    if (!(rt.bin ?? []).some((e) => e.name === "package.json")) {
      fs.writeFileSync(path.join(bin, "package.json"), '{ "type": "commonjs" }\n');
    }
    // both files once more, after the extras: nothing written since may stand in for them
    if ((await sha256File(path.join(bin, "lean.js"))) !== rt.files["lean.js"].sha256) throw new Error("bin/lean.js changed after it was verified");
    const recomputed = buildIdFromSha256(await sha256File(path.join(bin, "lean.wasm")));
    if (recomputed !== rt.buildId) throw new Error(`build id recomputed from bin/lean.wasm is ${recomputed}, release says ${rt.buildId}`);
    console.log(`runtime ${recomputed} → ${bin} (use --artifact ${out})`);
  }
  if (only.has("all") && !only.has("runtime")) {
    // every listed file is in place and verified: the sums make <out> a release dir `verify` accepts
    // (not with `runtime`: its bin/ is no release file, so that dir is no release dir)
    const absent = record.files.filter((f) => !fs.existsSync(inside(f.path))).map((f) => f.path);
    if (absent.length) throw new Error(`not fetched: ${absent.slice(0, 5).join(", ")}`);
    fs.writeFileSync(path.join(out, "SHA256SUMS"), sha256sums([...record.files, { path: "release.json", sha256: createHash("sha256").update(recordText).digest("hex") }]));
  }
} catch (e) {
  failures++;
  console.error(`fetch: FAILED — ${e.message}`);
}
console.log(failures ? "\nFETCH FAILED" : "\nFETCH VERIFIED");
// exitCode, not process.exit(): exiting while V8 compiles in the background can deadlock
// Node's platform shutdown (seen on Node 26.3: a Maglev job waits for a GC the exiting
// main thread never runs). Nothing is left on the event loop here, so the process ends.
process.exitCode = failures ? 1 : 0;
