#!/usr/bin/env node
// Cut a release's library packs from kernel build directories, as packs.json says.
//
//   pack-set.mjs --build-dir <K> [--runtime-dir <R>] --out <dir> --lean-version <x.y.z>
//                [--only <id>,…] [--packs <packs.json>] [--record <file>] [--keep-raw]
//
// <K> is the import's build directory (import-release.sh build + native64.sh +
// mathlib-tree.sh): build/stage1/{bin/lean.wasm, lib/lean}, BUILT-COMMIT,
// native/NATIVE-COMMIT, mathlib/{essential-tree, extra-tree, MATHLIB-COMMIT}.
// <R> is the released runtime's build directory (default <K>; a kernel-only fix
// releases its own build with the import's packs). A pack's `build` says which
// of the two its source is in; `compiler` says whose compiler wrote its oleans:
// "wasm" = that build's wasm64 stage1 (its BUILT-COMMIT), "native64" = the
// import's native compiler (NATIVE-COMMIT).
//
// Each pack is packed by pack.mjs (in a child process, the same CLI a user
// runs) into <out>: <id>.manifest.json + its gzip transport parts; the raw
// <id>.pack is removed unless --keep-raw. The record (--record, default
// <out>/pack-set.json) lists, per pack, the build it came from and the commit
// whose compiler wrote the oleans — the `packs` entries of a release config.
//
// Refuses before packing when a source is missing, an Init-free tree holds
// Init, two packs that must be disjoint share a module (a module mounted
// twice resolves to whichever olean the mount order prefers — visible only in
// the browser), a root has no .olean in the tree (renamed or dropped
// upstream: the roots are packs.json's, not the selection's), or the tree's
// modules are not its `modulesList` (the selection mathlib-tree.sh wrote).
// After packing, every import of a pack with `closedOver` must be a module of
// the pack or of those packs (their manifests read from <out>, packed in this
// run or copied there first) — otherwise only a browser's import closure
// would notice. A pack refused then is removed from <out>.
// (These are the checks of QED64's import-packs.sh + stage-profiles --check-only.)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyCliContract } from "./cli-args.mjs";
import { buildIdOfArtifact } from "./artifact-id.mjs";

applyCliContract({
  tool: "pack-set",
  usage: "pack-set.mjs --build-dir <K> [--runtime-dir <R>] --out <dir> --lean-version <x.y.z> [--only <id>,…] [--packs <file>] [--record <file>] [--keep-raw]",
  flags: { "build-dir": 1, "runtime-dir": 1, out: 1, "lean-version": 1, only: 1, packs: 1, record: 1, "keep-raw": 0, "no-imports": 0 },
  required: [["build-dir"], ["out"], ["lean-version"]],
  passthrough: null,
  help: [
    "usage: pack-set.mjs --build-dir <K> [--runtime-dir <R>] --out <dir> --lean-version <x.y.z> [--only <id>,…] [--packs <file>] [--record <file>] [--keep-raw]",
    "Cut the library packs of a release from kernel build directories, as packs.json describes them.",
    "Refuses a pack whose roots, module list (modulesList) or import closure (closedOver) is not what packs.json says.",
    "run as: lean4-wasm64 pack-set   (or: node pack-set.mjs)",
    "",
    "flags:",
    "  --build-dir <K>         the import's build directory [required]",
    "  --runtime-dir <R>       the released runtime's build directory (default: <K>)",
    "  --out <dir>             where manifests + parts go (e.g. <release>/profiles) [required]",
    "  --lean-version <x.y.z>  the runtime's leanVersion [required]",
    "  --only <id>,…           pack only these ids (default: all of packs.json)",
    "  --packs <file>          pack definitions (default: packs.json beside this script)",
    "  --record <file>         where to write the compilers record (default: <out>/pack-set.json)",
    "  --keep-raw              keep <id>.pack (the raw pack) next to the parts",
    "  --no-imports            passed to pack.mjs (fixture trees whose .olean files are not real regions)",
    "  -h, --help              print this help and exit 0",
    "",
    "exit codes: 0 packed, 1 refused or a pack failed, 2 usage",
  ].join("\n"),
});

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const K = path.resolve(arg("build-dir"));
const R = path.resolve(arg("runtime-dir", K));
const out = path.resolve(arg("out"));
const leanVersion = arg("lean-version");
const defs = JSON.parse(fs.readFileSync(path.resolve(arg("packs", path.join(here, "packs.json"))), "utf8"));
const only = arg("only") ? new Set(arg("only").split(",")) : null;
const keepRaw = argv.includes("--keep-raw");
const HEX40 = /^[0-9a-f]{40}$/;
const problems = [];
const readCommit = (dir, rel) => {
  const p = path.join(dir, rel);
  const v = fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim() : "";
  return HEX40.test(v) ? v : null;
};

const packs = defs.packs.filter((d) => !only || only.has(d.id));
if (only) for (const id of only) if (!defs.packs.some((d) => d.id === id)) problems.push(`--only ${id}: not in packs.json`);
const dirOf = (d) => (d.build === "runtime" ? R : K);
const order = defs.packs.map((d) => d.id);
const manifestIn = (id) => path.join(out, `${id}.manifest.json`);
for (const d of packs) {
  if (!["import", "runtime"].includes(d.build)) problems.push(`${d.id}: build must be "import" or "runtime"`);
  if (!["wasm", "native64"].includes(d.compiler)) problems.push(`${d.id}: compiler must be "wasm" or "native64"`);
  if (d.modulesList !== undefined && typeof d.modulesList !== "string") problems.push(`${d.id}: modulesList must be a path`);
  if (d.closedOver !== undefined && !Array.isArray(d.closedOver)) { problems.push(`${d.id}: closedOver must be a list of pack ids`); continue; }
  // the closure is checked as each pack is packed: what it is closed over must
  // be in <out> by then — packed earlier in this run, or there already
  for (const dep of d.closedOver ?? []) {
    if (dep === d.id || !order.includes(dep)) problems.push(`${d.id}: closedOver ${dep} is not another pack of packs.json`);
    else if (packs.some((o) => o.id === dep)) {
      if (order.indexOf(dep) > order.indexOf(d.id)) problems.push(`${d.id}: closed over ${dep}, which packs.json lists after it`);
    } else if (!fs.existsSync(manifestIn(dep))) {
      problems.push(`${d.id}: closed over ${dep}, but ${manifestIn(dep)} is absent (pack ${dep} in this run, or copy its manifest there first)`);
    }
  }
}
// identity of each build dir a selected pack draws on
const builds = new Map();
for (const dir of new Set(packs.map(dirOf))) {
  const commit = readCommit(dir, "BUILT-COMMIT");
  if (!commit) problems.push(`${dir}/BUILT-COMMIT missing or not 40 hex`);
  let buildId = null;
  try { buildId = await buildIdOfArtifact(path.join(dir, "build", "stage1")); } catch (e) { problems.push(e.message); }
  builds.set(dir, { commit, buildId });
}
const native = packs.some((d) => d.compiler === "native64") ? readCommit(K, "native/NATIVE-COMMIT") : null;
if (packs.some((d) => d.compiler === "native64") && !native) problems.push(`${K}/native/NATIVE-COMMIT missing or not 40 hex`);
const mathlib = packs.some((d) => d.release.includes("{mathlib7}") || d.compiler === "native64") ? readCommit(K, "mathlib/MATHLIB-COMMIT") : null;
if (packs.some((d) => d.release.includes("{mathlib7}")) && !mathlib) problems.push(`${K}/mathlib/MATHLIB-COMMIT missing or not 40 hex`);

// The .olean paths ("/"-separated, relative) pack.mjs will pack from a source:
// the whole tree, or only its `include` entries.
const oleans = (root, include) => {
  const found = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.name.endsWith(".olean")) found.push(r);
    }
  };
  if (!include) walk(root, "");
  else for (const inc of include) {
    const rel = inc.replace(/\/+$/, "");
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) walk(p, rel);
    else if (rel.endsWith(".olean")) found.push(rel);
  }
  return found;
};
const moduleOf = (rel) => rel.slice(0, -".olean".length).split("/").join(".");
const few = (xs) => xs.slice(0, 5).join(", ") + (xs.length > 5 ? ", …" : "");
for (const d of packs) {
  const src = path.join(dirOf(d), d.from);
  if (!fs.existsSync(src)) { problems.push(`${d.id}: source ${src} missing`); continue; }
  if (d.excludesInit && (fs.existsSync(path.join(src, "Init.olean")) || fs.existsSync(path.join(src, "Init")))) {
    problems.push(`${d.id}: ${src} holds Init (lean-core carries it; both unpack into one tree)`);
  }
  const mine = oleans(src, d.include);
  const modules = new Set(mine.map(moduleOf));
  if (d.disjointFrom) {
    const other = defs.packs.find((o) => o.id === d.disjointFrom);
    const otherSrc = other && path.join(dirOf(other), other.from);
    if (!otherSrc || !fs.existsSync(otherSrc)) problems.push(`${d.id}: cannot check disjointness, ${d.disjointFrom}'s source is missing`);
    else {
      const paths = new Set(mine);
      const shared = oleans(otherSrc, other.include).filter((m) => paths.has(m));
      if (shared.length) problems.push(`${d.id}: shares ${shared.length} module(s) with ${d.disjointFrom}, e.g. ${shared.slice(0, 3).join(", ")}`);
      if (!paths.size) problems.push(`${d.id}: ${src} holds no .olean files`);
    }
  }
  for (const inc of d.include ?? []) if (!fs.existsSync(path.join(src, inc))) problems.push(`${d.id}: ${d.from}/${inc} missing`);
  // the roots are recorded in the manifest and are what a browser imports first
  const absentRoots = (d.roots ?? []).filter((r) => !modules.has(r));
  if (absentRoots.length) {
    problems.push(`${d.id}: root(s) with no .olean in ${src}${d.include ? " (its include selection)" : ""}: ` +
      `${few(absentRoots.map((r) => `${r} (${r.split(".").join("/")}.olean)`))} — renamed or dropped upstream?`);
  }
  if (typeof d.modulesList === "string") {
    const list = path.join(K, d.modulesList);
    if (!fs.existsSync(list)) problems.push(`${d.id}: ${list} missing (the module list the tree must equal)`);
    else {
      const listed = new Set(fs.readFileSync(list, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));
      const unpacked = [...listed].filter((m) => !modules.has(m)).sort();
      const unlisted = [...modules].filter((m) => !listed.has(m)).sort();
      if (unpacked.length) problems.push(`${d.id}: ${d.modulesList} lists ${unpacked.length} module(s) with no .olean in ${src}, e.g. ${few(unpacked)}`);
      if (unlisted.length) problems.push(`${d.id}: ${src} holds ${unlisted.length} module(s) ${d.modulesList} does not list, e.g. ${few(unlisted)}`);
    }
  }
}
const recordPath = path.resolve(arg("record", path.join(out, "pack-set.json")));
// a record from an earlier run must not outlive a refused one: it would list packs this run did not vouch for
fs.rmSync(recordPath, { force: true });
if (problems.length) {
  console.error(`pack-set: REFUSED —\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
if (argv.includes("--no-imports")) console.error("pack-set: WARNING --no-imports: import tables are not read, so no import closure is checked (fixtures only)");

fs.mkdirSync(out, { recursive: true });
const outputsOf = (id) => fs.readdirSync(out).filter((f) => f === `${id}.pack` || f === `${id}.manifest.json` || f.startsWith(`${id}.pack.gzip.`));
// A hard link cannot leave its filesystem (EXDEV: --out on another volume than
// the build) and some filesystems have none (EPERM, ENOTSUP): copy then, as a
// clone where the filesystem can.
const place = (from, to) => {
  try { fs.linkSync(from, to); } catch (e) {
    if (!["EXDEV", "EPERM", "ENOTSUP"].includes(e.code)) throw e;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
  }
};
// module names of the manifests in <out> a closure is checked against
const modulesOf = new Map();
const modulesIn = (id) => {
  if (!modulesOf.has(id)) {
    try { modulesOf.set(id, Object.keys(JSON.parse(fs.readFileSync(manifestIn(id), "utf8")).content.modules)); } catch { modulesOf.set(id, null); }
  }
  return modulesOf.get(id);
};
const record = [];
for (const d of packs) {
  const { commit, buildId } = builds.get(dirOf(d));
  const fill = (t) => t.replaceAll("{leanVersion}", leanVersion).replaceAll("{buildId}", buildId)
    .replaceAll("{commit12}", commit.slice(0, 12)).replaceAll("{mathlib7}", mathlib?.slice(0, 7) ?? "");
  let lib = path.join(dirOf(d), d.from);
  let side = null;
  if (d.include) {
    // pack.mjs packs everything under --lib: the selection is a hard-linked side tree
    side = path.join(out, `.select-${d.id}`);
    fs.rmSync(side, { recursive: true, force: true });
    const link = (from, to) => {
      if (fs.statSync(from).isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        for (const e of fs.readdirSync(from)) link(path.join(from, e), path.join(to, e));
      } else {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        place(from, to);
      }
    };
    try { for (const inc of d.include) link(path.join(lib, inc), path.join(side, inc)); } catch (e) {
      fs.rmSync(side, { recursive: true, force: true }); // a partial side tree is a stray file in <out>
      console.error(`pack-set: ${d.id}: selecting from ${lib} failed: ${e.message}`);
      process.exit(1);
    }
    lib = side;
  }
  for (const f of outputsOf(d.id)) fs.rmSync(path.join(out, f));
  const args = [path.join(here, "pack.mjs"), "--lib", lib, "--id", d.id, "--out", out, "--mount", d.mount,
    "--lean-version", leanVersion, "--revision", commit.slice(0, 12), "--release", fill(d.release)];
  if (d.roots.length) args.push("--roots", d.roots.join(","));
  if (d.urlPrefix) args.push("--url-prefix", d.urlPrefix);
  if (argv.includes("--no-imports")) args.push("--no-imports");
  console.log(`== ${d.id} ← ${path.join(dirOf(d), d.from)}`);
  const r = spawnSync(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  if (side) fs.rmSync(side, { recursive: true, force: true });
  process.stdout.write(r.stdout);
  if (r.status !== 0) { console.error(`pack-set: ${d.id} failed (pack.mjs exit ${r.status})`); process.exit(1); }
  if (!keepRaw) fs.rmSync(path.join(out, `${d.id}.pack`), { force: true });
  const m = JSON.parse(fs.readFileSync(path.join(out, `${d.id}.manifest.json`), "utf8")).content;
  modulesOf.set(d.id, Object.keys(m.modules));
  if (d.closedOver) {
    // pack.mjs leaves the implicit `Init` edge out of a pack without Init, so
    // every import left must be a module of this pack or of d.closedOver
    const known = new Set(Object.keys(m.modules));
    const bad = [];
    for (const dep of d.closedOver) {
      const names = modulesIn(dep);
      if (names) for (const n of names) known.add(n);
      else bad.push(`cannot read ${manifestIn(dep)} (${d.id} is closed over ${dep})`);
    }
    const dangling = [];
    let edges = 0;
    for (const [name, mod] of Object.entries(m.modules)) {
      for (const dep of mod.imports ?? []) { edges += 1; if (!known.has(dep)) dangling.push(`${name} → ${dep}`); }
    }
    if (!bad.length && dangling.length) {
      bad.push(`${dangling.length} dangling import(s), in none of ${[d.id, ...d.closedOver].join(" + ")}: e.g. ${dangling.slice(0, 5).join("; ")}`);
    }
    if (edges === 0 && Object.keys(m.modules).length > 1 && !argv.includes("--no-imports")) bad.push("no import edges at all (the .olean import tables read as empty)");
    if (bad.length) {
      for (const f of outputsOf(d.id)) fs.rmSync(path.join(out, f)); // never left looking packed
      console.error(`pack-set: REFUSED — ${d.id} after packing (its manifest and parts were removed from ${out}):\n  ${bad.join("\n  ")}`);
      process.exit(1);
    }
  }
  record.push({
    id: d.id,
    build: d.build,
    buildDir: dirOf(d),
    compiler: d.compiler === "wasm" ? commit : native,
    ...(d.compiler === "native64" && mathlib ? { mathlib: { commit: mathlib } } : {}),
    release: m.release,
    modules: Object.keys(m.modules).length,
    rawSha256: m.pack.digest.replace(/^sha256:/, ""),
  });
}
fs.writeFileSync(recordPath, `${JSON.stringify({ importDir: K, runtimeDir: R, leanVersion, packs: record }, null, 2)}\n`);
console.log(`pack-set: ${record.length} pack(s) → ${out} (${recordPath} lists the compilers for the release config)`);
