#!/usr/bin/env bash
# Stage a lean4-wasm64 release (js/formats/release.md) from kernel build
# directories, write its release.json and verify it. LOCAL only: it does not
# commit, tag, push, upload or publish — it prints those commands for the
# repository owner (RELEASE.md).
#
#   wasm64-build/stage-release.sh <tag> [options]
#
#   --runtime <dir>         build dir of the runtime to release (default: the tag's
#                           build dir). A kernel-only fix releases its own build
#                           with the import's packs, native64 and lists.
#   --packs-from <dir>      copy the packs whose manifests <dir> holds (with exactly
#                           the parts they name; repeatable, searched in order;
#                           clones where the filesystem can) instead of packing
#                           them. Every other pack of js/packs.json is cut by pack-set.mjs.
#   --match-runtime <file>  a runtime manifest the release must reproduce byte for
#                           byte (e.g. the one a site serves): its sourceRevision is
#                           used, and staging stops unless the staged manifest equals it
#   --revision <text>       runtime manifest sourceRevision (default: from
#                           --match-runtime, else "qed64-wasm64@<commit10> (upstream <tag>)")
#   --note <text>           a release note (repeatable)
#   --recut <n>             a tools-only re-cut of the same runtime: id suffix -r<n> (n ≥ 2)
#   --out <dir>             parent of the release dir (default ../wasm64-lean-kernel-release)
#
# The release dir is <out>/<id>; beside it sit <id>.config.json (the release
# config), <id>.pack-set.json (where each pack came from), <id>.native64.stamp
# and <id>.verify.json — inputs and provenance, not release files. Re-running
# restages: runtime, lists and tools are rebuilt; the native64 tarball and packs
# packed by an earlier run are kept only if their recorded fingerprints of the
# inputs still match. A release is immutable once its tag exists; until then a
# re-run replaces it.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
JS="$REPO/wasm64-build/js"
LINE=qed64-wasm64
IMG=qed64-toolchain:emsdk-6.0.5
BASE_IMG=emscripten/emsdk:6.0.5
if ! git --version >/dev/null 2>&1 && [ -d /Library/Developer/CommandLineTools ]; then
  export DEVELOPER_DIR=/Library/Developer/CommandLineTools
fi
# relative paths are the caller's (import-release.sh cd's to the repo first and passes its cwd on)
CALLER="${LEAN4_WASM64_CALLER_CWD:-$PWD}"
abs() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s' "$CALLER/$1" ;; esac; }
cd "$REPO"
say() { printf '%s\n' "$*"; }
die() { printf 'stage-release: %s\n' "$1" >&2; exit "${2:-1}"; }
size_of() { wc -c < "$1" | tr -d ' '; }

TAG="${1:-}"; [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
shift
K="$(abs "${QED64_BUILD_DIR:-$REPO/../wasm64-lean-kernel-build-$TAG}")"
R="$K"; OUT="$REPO/../wasm64-lean-kernel-release"; REVISION=""; RECUT=""; MATCH_RUNTIME=""
PACKS_FROM=(); NOTES=()
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || die "$1 needs a value" 2
  case "$1" in
    --runtime) R="$(abs "$2")" ;;
    --packs-from) d="$(abs "$2")"; [ -d "$d" ] || die "--packs-from $2: not a directory" 2; PACKS_FROM+=("$(cd "$d" && pwd)") ;;
    --match-runtime) f="$(abs "$2")"; [ -f "$f" ] || die "--match-runtime $2: not a file" 2; MATCH_RUNTIME="$(cd "$(dirname "$f")" && pwd)/$(basename "$f")" ;;
    --revision) REVISION="$2" ;;
    --note) NOTES+=("$2") ;;
    --recut) [[ "$2" =~ ^([2-9]|[1-9][0-9]+)$ ]] || die "--recut must be an integer ≥ 2 (the first cut has no suffix)" 2; RECUT="$2" ;;
    --out) OUT="$(abs "$2")" ;;
    *) die "unknown option $1" 2 ;;
  esac
  shift 2
done
[ -d "$K" ] || die "import build dir $K missing"; [ -d "$R" ] || die "runtime build dir $R missing"
K="$(cd "$K" && pwd)"; R="$(cd "$R" && pwd)"
# a tools-only re-cut must reproduce the base release's runtime manifest byte for byte
[ -z "$RECUT" ] || [ -n "$MATCH_RUNTIME" ] || die "--recut needs --match-runtime <the base release's runtime/runtime-manifest.json>: a re-cut keeps the runtime" 2
V="${TAG#v}"
hex40() { [[ "$(tr -d ' \n\r' < "$1" 2>/dev/null)" =~ ^[0-9a-f]{40}$ ]]; }

# ---------- what is being released ----------
hex40 "$R/BUILT-COMMIT" || die "$R/BUILT-COMMIT missing or not 40 hex"
C="$(tr -d ' \n\r' < "$R/BUILT-COMMIT")"
WASM="$R/build/stage1/bin/lean.wasm"; [ -s "$WASM" ] || die "$WASM missing"
WASM_SHA="$(shasum -a 256 "$WASM" | cut -c1-64)"
[ -f "$R/GATE-PASSED" ] && [ "$(sed -n 1p "$R/GATE-PASSED")" = "$C" ] && [ "$(sed -n 2p "$R/GATE-PASSED")" = "$WASM_SHA" ] \
  || die "$R has no passing gate for commit ${C:0:10} and this lean.wasm (GATE-PASSED; import-release.sh gate / gate-dir)" 31
CHECKS="$(grep -c '^ ok ' "$R/gate.log" 2>/dev/null || true)"; [[ "$CHECKS" =~ ^[0-9]+$ ]] || CHECKS=""
git cat-file -e "$C^{commit}" 2>/dev/null || die "kernel commit $C is not in this repository"
git merge-base --is-ancestor "$C" "$LINE" || die "kernel commit $C is not on $LINE"
git merge-base --is-ancestor "$C" HEAD || die "HEAD does not contain kernel commit $C (stage from $LINE or a descendant)"
ON_ORIGIN=yes; git merge-base --is-ancestor "$C" "origin/$LINE" 2>/dev/null || ON_ORIGIN=no
# the upstream release a kernel commit carries is the NEWEST stable tag it contains
NEWEST="$(git tag --merged "$C" 'v[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1 || true)"
[ "$NEWEST" = "$TAG" ] || die "kernel commit ${C:0:10} carries upstream ${NEWEST:-no stable tag}, not $TAG"
# patch id (formats/README.md rule 4): the last PATCHES.md heading — read at HEAD, since an
# entry is often written after its code — whose named commit is C or an ancestor of C
PATCH="$(node --input-type=module - "$JS/artifact-id.mjs" "$C" <<'JS'
import fs from "node:fs"; import { execFileSync, spawnSync } from "node:child_process";
const [lib, C] = process.argv.slice(2);
const { patchIdOf } = await import(lib);
const { patchHeadings } = await import(lib);
const md = execFileSync("git", ["show", "HEAD:wasm64-build/PATCHES.md"], { encoding: "utf8" });
// every heading must name a commit of this line, once, in order — a typo, an amended or
// rebased hash, a feature-branch original or a copy-paste would silently record a wrong id
const isAnc = (a, b) => spawnSync("git", ["merge-base", "--is-ancestor", a, b]).status === 0;
const hs = patchHeadings(md);
const bad = [];
// a heading meant as a patch entry but not spelled "## NNNN[a-z] …" would be skipped
for (const line of md.split("\n")) if (/^#{1,6}\s*\d{3,}/.test(line) && !/^## \d{4}[a-z]?\b/.test(line)) bad.push(`malformed patch heading "${line.slice(0, 40)}"`);
hs.forEach((h, i) => {
  if (!h.commit) return; // patchIdOf refuses those
  if (spawnSync("git", ["cat-file", "-e", `${h.commit}^{commit}`]).status !== 0) bad.push(`${h.id} names unknown commit ${h.commit}`);
  else if (!isAnc(h.commit, "HEAD")) bad.push(`${h.id} names ${h.commit}, which is not on this line`);
  else if (hs.slice(0, i).some((g) => g.commit === h.commit)) bad.push(`${h.id} repeats ${h.commit}`);
  else if (i > 0 && hs[i - 1].commit && !isAnc(hs[i - 1].commit, h.commit)) bad.push(`${h.id} (${h.commit}) does not descend from ${hs[i - 1].id} (${hs[i - 1].commit})`);
});
if (bad.length) throw new Error(`PATCHES.md: ${bad.join("; ")}`);
console.log(patchIdOf(md, (c) => spawnSync("git", ["merge-base", "--is-ancestor", c, C]).status === 0));
JS
)" || die "the patch id of $C cannot be placed from PATCHES.md at HEAD (reason above)"
K7="${C:0:7}"; ID="lean-$TAG-$K7${RECUT:+-r$RECUT}"
! git rev-parse -q --verify "refs/tags/$ID" >/dev/null || die "tag $ID exists: that release is cut and immutable (re-cut with --recut <n>)"
for f in native/NATIVE-COMMIT mathlib/MATHLIB-COMMIT; do hex40 "$K/$f" || die "$K/$f missing or not 40 hex"; done
NATIVE="$(tr -d ' \n\r' < "$K/native/NATIVE-COMMIT")"; MATHLIB="$(tr -d ' \n\r' < "$K/mathlib/MATHLIB-COMMIT")"
[ -x "$K/native/stage1/bin/lean" ] || die "$K/native/stage1/bin/lean missing (native64.sh $TAG)"
git cat-file -e "$NATIVE^{commit}" 2>/dev/null || die "native commit $NATIVE is not in this repository"
[ -z "$(git status --porcelain -- wasm64-build/js wasm64-build/PATCHES.md)" ] || die "wasm64-build/js or PATCHES.md has uncommitted changes: the tools tarball and the patch id come from HEAD — commit them first"
TOOLS_COMMIT="$(git rev-parse HEAD)"
PKG_VERSION="$(node -p 'require(process.argv[1]).version' "$JS/package.json")"
[ "$PKG_VERSION" = "$V-$K7${RECUT:+-r$RECUT}" ] || die "wasm64-build/js/package.json version is $PKG_VERSION, the release needs $V-$K7${RECUT:+-r$RECUT} (bump and commit it first)"
IMAGE_ID="$(docker image inspect "$IMG" --format '{{.Id}}' 2>/dev/null)" || die "toolchain image $IMG is not local (docker build docker-wasm64)"
BASE_DIGEST="$(docker image inspect "$BASE_IMG" --format '{{index .RepoDigests 0}}' 2>/dev/null)" || die "base image $BASE_IMG is not local: its digest is part of the release's identity"
BASE="$BASE_IMG@${BASE_DIGEST#*@}"
RECIPE="$(git log -1 --format=%H "$C" -- docker-wasm64)"
say "release $ID: kernel $C (patch $PATCH, gate ${CHECKS:-?} checks), runtime $R, packs/native64/lists $K"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"; REL="$OUT/$ID"   # only now: every refusal comes first
mkdir -p "$REL"
rm -f "$REL/release.json" "$REL/SHA256SUMS"   # derived; written again below

# ---------- runtime ----------
say "== runtime"
REV="$REVISION"
[ -n "$REV" ] || [ -z "$MATCH_RUNTIME" ] || REV="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).sourceRevision' "$MATCH_RUNTIME")"
[ -n "$REV" ] || REV="qed64-wasm64@${C:0:10} (upstream $TAG)"
rm -rf "$REL/runtime"
node "$JS/chunk-runtime.mjs" --bin "$R/build/stage1/bin" --out "$REL/runtime" --lean-version "$V" --revision "$REV" | tail -2
if [ -n "$MATCH_RUNTIME" ]; then
  cmp -s "$REL/runtime/runtime-manifest.json" "$MATCH_RUNTIME" \
    || die "the staged runtime manifest differs from $MATCH_RUNTIME (sourceRevision, chunking or the binary): the per-build manifest name would get a second content"
  say "runtime manifest byte-identical to $MATCH_RUNTIME"
fi
mkdir -p "$REL/runtime/bin"
for f in "$R/build/stage1/bin/"*; do
  case "$(basename "$f")" in lean.js|lean.wasm|package.json) ;; *) cp -p "$f" "$REL/runtime/bin/" ;; esac
done

# ---------- packs ----------
say "== packs"
mkdir -p "$REL/profiles"
# Each pack of js/packs.json is COPIED when a --packs-from dir holds its manifest (a served
# pack keeps its transport bytes, so caches and R2 objects stay valid) and PACKED otherwise.
# A pack packed by an earlier run is kept only if its fingerprint (definition, tools, build
# binary, source tree, Mathlib, module list, dependencies' fingerprints) is unchanged and every
# part is present. Either way it must come from the build packs.json names.
TO_PACK="$(node --input-type=module - "$JS" "$REL/profiles" "$OUT/$ID" "$K" "$R" "$V" "$NATIVE" "$MATHLIB" ${PACKS_FROM[@]+"${PACKS_FROM[@]}"} <<'JS'
import fs from "node:fs"; import path from "node:path"; import { createHash } from "node:crypto";
const [js, dest, base, K, R, V, NATIVE, MATHLIB, ...dirs] = process.argv.slice(2);
const defsPath = path.join(js, "packs.json");
const defs = JSON.parse(fs.readFileSync(defsPath, "utf8")).packs;
const commitOf = (dir) => fs.readFileSync(path.join(dir, "BUILT-COMMIT"), "utf8").trim();
const partsOf = (c) => c.pack.transport.parts.map((p) => path.posix.basename(new URL(p.url, "https://x/").pathname));
let packed = fs.existsSync(`${base}.packed.json`) ? JSON.parse(fs.readFileSync(`${base}.packed.json`, "utf8")).packs : [];
// a --packs-from dir must hold some pack of packs.json (checked before anything is copied)
const useless = dirs.filter((x) => !defs.some((d) => fs.existsSync(path.join(x, `${d.id}.manifest.json`))));
if (useless.length) throw new Error(`--packs-from ${useless.join(", ")}: holds no manifest of js/packs.json`);
const ids = new Set(defs.map((d) => d.id));
// nothing in profiles/ that no pack of packs.json owns
for (const f of fs.readdirSync(dest)) if (!ids.has(f.split(".")[0])) fs.rmSync(path.join(dest, f), { recursive: true, force: true });
// what a packed pack is made of: a pack from an earlier run is kept only if all of it is unchanged
const sha = (b) => createHash("sha256").update(b).digest("hex");
// all of the tools (any of them can change what a pack holds) …
const tools = sha(fs.readdirSync(js).filter((f) => f.endsWith(".mjs") || f === "packs.json").sort().map((f) => `${f}\0${sha(fs.readFileSync(path.join(js, f)))}`).join("\n"));
// … each build's binary, and the source tree's paths, sizes and mtimes
const tree = (root) => { const h = createHash("sha256");
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const q = path.join(d, e.name); if (e.isDirectory()) walk(q); else { const st = fs.lstatSync(q); h.update(`${path.relative(root, q)}\0${st.size}\0${st.mtimeMs}\n`); } } })(root);
  return h.digest("hex"); };
const wasmOf = (B) => sha(fs.readFileSync(path.join(B, "build", "stage1", "bin", "lean.wasm")));
const fingerprints = {};
const fingerprint = (d, B) => sha(JSON.stringify({ def: d, tools, build: commitOf(B), wasm: wasmOf(B), tree: tree(path.join(B, d.from)),
  native: NATIVE, mathlib: MATHLIB, V, list: d.modulesList ? sha(fs.readFileSync(path.join(K, d.modulesList))) : null,
  deps: (d.closedOver ?? []).map((id) => fingerprints[id] ?? null) }));
const copied = [], toPack = [];
for (const d of defs) {
  const B = d.build === "runtime" ? R : K;
  const compiler = d.compiler === "wasm" ? commitOf(B) : NATIVE;
  fingerprints[d.id] = fingerprint(d, B);
  const dir = dirs.find((x) => fs.existsSync(path.join(x, `${d.id}.manifest.json`)));
  if (!dir) {
    const prev = packed.find((p) => p.id === d.id);
    const mf = path.join(dest, `${d.id}.manifest.json`);
    const done = prev && prev.fingerprint === fingerprints[d.id] && prev.buildDir === B && fs.existsSync(mf)
      && partsOf(JSON.parse(fs.readFileSync(mf, "utf8")).content).every((f) => fs.existsSync(path.join(dest, f)));
    if (done) console.error(`${d.id}: kept from an earlier run (same definition, tools, build binary, source tree, Mathlib, module list and dependencies)`); else toPack.push(d.id);
    continue;
  }
  const mf = path.join(dir, `${d.id}.manifest.json`);
  const c = JSON.parse(fs.readFileSync(mf, "utf8")).content;
  const bc = commitOf(B);
  if (c.lean.version !== V) throw new Error(`${mf}: Lean ${c.lean.version}, releasing ${V}`);
  if (c.lean.gitRevision !== bc.slice(0, 12)) throw new Error(`${mf}: gitRevision ${c.lean.gitRevision}, but packs.json cuts ${d.id} from ${B} (${bc.slice(0, 12)})`);
  for (const f of fs.readdirSync(dest)) if (f.startsWith(`${d.id}.`)) fs.rmSync(path.join(dest, f)); // nothing stale
  const files = [`${d.id}.manifest.json`, ...partsOf(c)];
  // a clone where the filesystem can (APFS, btrfs, XFS), a copy elsewhere
  for (const f of files) fs.copyFileSync(path.join(dir, f), path.join(dest, f), fs.constants.COPYFILE_FICLONE);
  packed = packed.filter((p) => p.id !== d.id); // copied now: no packed record may claim these bytes
  copied.push({ id: d.id, build: d.build, buildDir: B, compiler,
    ...(d.compiler === "native64" ? { mathlib: { commit: MATHLIB } } : {}),
    release: c.release, modules: Object.keys(c.modules).length, rawSha256: c.pack.digest.replace(/^sha256:/, ""), copiedFrom: dir });
  console.error(`${d.id}: manifest + ${files.length - 1} parts copied from ${dir}`);
}
for (const x of dirs.filter((x) => !copied.some((c) => c.copiedFrom === x))) console.error(`note: every manifest in --packs-from ${x} was taken from an earlier --packs-from`);
// packs about to be packed lose their old records first (a failed pack-set must not leave them claimable)
packed = packed.filter((p) => !toPack.includes(p.id));
fs.writeFileSync(`${base}.packed.json`, JSON.stringify({ packs: packed }, null, 2) + "\n");
fs.writeFileSync(`${base}.copied.json`, JSON.stringify({ packs: copied }, null, 2) + "\n");
fs.writeFileSync(`${base}.fingerprints.json`, JSON.stringify(fingerprints, null, 2) + "\n");
console.log(toPack.join(","));
JS
)"
if [ -n "$TO_PACK" ]; then
  node "$JS/pack-set.mjs" --build-dir "$K" --runtime-dir "$R" --out "$REL/profiles" --lean-version "$V" \
    --only "$TO_PACK" --record "$OUT/$ID.packed.json.new"
  # merge with the packs an earlier run kept
  node -e '
    const fs = require("fs"); const [prev, next, fps] = process.argv.slice(1);
    const old = fs.existsSync(prev) ? JSON.parse(fs.readFileSync(prev, "utf8")).packs : [];
    const fingerprints = JSON.parse(fs.readFileSync(fps, "utf8"));
    const fresh = JSON.parse(fs.readFileSync(next, "utf8")).packs.map((p) => ({ ...p, fingerprint: fingerprints[p.id] }));
    const ids = new Set(fresh.map((p) => p.id));
    fs.writeFileSync(prev, JSON.stringify({ packs: [...old.filter((p) => !ids.has(p.id)), ...fresh] }, null, 2) + "\n");
    fs.rmSync(next);' "$OUT/$ID.packed.json" "$OUT/$ID.packed.json.new" "$OUT/$ID.fingerprints.json"
fi
# one record, in packs.json order
node -e '
  const fs = require("fs"); const [defs, base] = process.argv.slice(1);
  const all = ["copied", "packed"].flatMap((k) => fs.existsSync(`${base}.${k}.json`) ? JSON.parse(fs.readFileSync(`${base}.${k}.json`, "utf8")).packs : []);
  const order = JSON.parse(fs.readFileSync(defs, "utf8")).packs.map((d) => d.id);
  const packs = order.map((id) => { const p = all.find((x) => x.id === id); if (!p) throw new Error(`no record for ${id}`); return p; });
  fs.writeFileSync(`${base}.pack-set.json`, JSON.stringify({ packs }, null, 2) + "\n");' "$JS/packs.json" "$OUT/$ID"

# ---------- native64 ----------
say "== native64"
mkdir -p "$REL/native64"
MTIME="$(git show -s --format=%ct "$NATIVE")"
# the tree's fingerprint: every file's path, size and mtime (a rebuild at the same commit changes it)
TREE="$(node -e '
  const fs = require("fs"), path = require("path"), h = require("crypto").createHash("sha256");
  const root = process.argv[1];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(d, e.name); const st = fs.lstatSync(p);
    if (e.isDirectory()) walk(p); else h.update(`${path.relative(root, p)}\0${st.size}\0${st.mtimeMs}\n`);
  } })(root);
  console.log(h.digest("hex"));' "$K/native/stage1")"
STAMP="native=$NATIVE tree=$TREE mtime=$MTIME image=$IMAGE_ID"
if [ ! -s "$REL/native64/native64.tar.gz" ] || [ "$(cat "$OUT/$ID.native64.stamp" 2>/dev/null)" != "$STAMP" ]; then
  rm -f "$REL/native64/native64.tar.gz" "$OUT/$ID.native64.stamp"
  # GNU tar in the toolchain image: sorted names, one mtime (the native commit's), numeric
  # root ownership, gzip -n — the tarball depends on the tree's bytes only. bin, include,
  # share and all of lib/lean (the static archives are native aarch64; the shipped leanc
  # defaults to emcc, so a native link needs LEAN_CC=gcc). Then a smoke, one command per
  # line so set -e sees each: unpack fresh, run lean, elaborate a file against its own Init.
  docker run --rm -e PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    -v "$K/native/stage1":/n:ro -v "$REL/native64":/o "$IMG" bash -c "
      set -euo pipefail; export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
      cd /n && tar --sort=name --mtime=@$MTIME --owner=0 --group=0 --numeric-owner --format=gnu \
        -cf - bin include share lib/lean | gzip -n -9 > /o/native64.tar.gz.partial
      mkdir /t && tar -xzf /o/native64.tar.gz.partial -C /t
      printf 'theorem two : 1 + 1 = 2 := rfl\n#eval Lean.versionString\n' > /tmp/x.lean
      /t/bin/lean --version
      /t/bin/lean /tmp/x.lean
      mv /o/native64.tar.gz.partial /o/native64.tar.gz"
  printf '%s' "$STAMP" > "$OUT/$ID.native64.stamp"
else
  say "native64.tar.gz kept (same native commit, tree contents and image)"
fi
NBYTES="$(size_of "$REL/native64/native64.tar.gz")"
[ "$NBYTES" -lt 2000000000 ] || die "native64.tar.gz is $NBYTES bytes: a GitHub release asset must stay under 2 GiB"
say "native64.tar.gz: $NBYTES bytes"

# ---------- lists ----------
rm -rf "$REL/lists"; mkdir -p "$REL/lists"
for f in essential-modules.txt extra-modules.txt essential-selection.json extra-selection.json; do
  if [ -f "$K/mathlib/$f" ]; then cp -p "$K/mathlib/$f" "$REL/lists/"; fi
done

# ---------- tools (always from the committed tree at HEAD) ----------
say "== tools"
rm -rf "$REL/tools"; mkdir -p "$REL/tools"
TGZ="lean4-wasm64-$PKG_VERSION.tgz"
(cd "$JS" && npm pack --silent --pack-destination "$REL/tools" >/dev/null)
[ -s "$REL/tools/$TGZ" ] || die "npm pack did not produce tools/$TGZ"

# ---------- release.json ----------
say "== release.json"
CONFIG="$OUT/$ID.config.json"
node --input-type=module - "$CONFIG" "$OUT/$ID.pack-set.json" "$REL/lists" ${NOTES[@]+"${NOTES[@]}"} <<EOF
import fs from "node:fs";
const [config, packSet, listsDir, ...notes] = process.argv.slice(2);
const lists = fs.readdirSync(listsDir);
const modules = Object.fromEntries(lists.filter((f) => f.endsWith("-modules.txt")).map((f) => [f.replace(/-modules\.txt$/, ""), "lists/" + f]));
fs.writeFileSync(config, JSON.stringify({
  upstreamTag: "$TAG", kernelCommit: "$C", kernelPatch: "$PATCH", ${RECUT:+recut: $RECUT,}
  leanVersion: "$V",
  gate: { commit: "$C", wasmSha256: "$WASM_SHA", checks: ${CHECKS:-null} },
  packs: JSON.parse(fs.readFileSync(packSet, "utf8")).packs.map(({ id, compiler, mathlib, copiedFrom }) => ({ id, compiler,
    ...(mathlib ? { mathlib: { ...mathlib, tag: "$TAG" } } : {}),
    ...(copiedFrom ? { note: "transport copied from served bytes, not re-packed" } : {}) })),
  native64: { commit: "$NATIVE", os: "linux", arch: "aarch64", tar: "native64/native64.tar.gz" },
  docker: { tag: "$IMG", recipeCommit: "$RECIPE", imageId: "$IMAGE_ID", base: "$BASE" },
  mathlib: { commit: "$MATHLIB", tag: "$TAG" },
  modules,
  hosting: {
    layout: "served",
    mount: { "/runtime/": "runtime/", "/profiles/": "profiles/" },
    siteOwned: ["/profiles/index.json", "/snapshots/"],
    crossOriginIsolation: { coop: "same-origin", coep: "require-corp", corp: "same-origin" },
    contentEncoding: "identity on *.part-NNN",
    spec: "wasm64-build/js/formats/HOSTING.md",
  },
  tools: { package: "lean4-wasm64", version: "$PKG_VERSION", tgz: "tools/$TGZ", commit: "$TOOLS_COMMIT" },
  notes,
}, null, 2) + "\n");
EOF
node "$JS/release.mjs" --release "$REL" --config "$CONFIG"
if ! node "$JS/verify-release.mjs" --release "$REL" --deep --json "$OUT/$ID.verify.json" > "$OUT/$ID.verify.log"; then
  grep -E "^FAIL" "$OUT/$ID.verify.log" | head -20 >&2 || true
  rm -f "$REL/release.json" "$REL/SHA256SUMS"
  die "verify-release failed ($OUT/$ID.verify.log); release.json removed — fix and re-run"
fi
tail -1 "$OUT/$ID.verify.log"
DIGEST="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).digest' "$REL/release.json")"

cat <<EOF

Staged and verified: $REL   (digest $DIGEST)
$( [ "$ON_ORIGIN" = no ] && echo "NOTE: $C is not on origin/$LINE yet — push the line before publishing." )
Next (RELEASE.md): commit the record, tag it, then the owner publishes —
  mkdir -p $REPO/wasm64-build/releases && cp $REL/release.json $REPO/wasm64-build/releases/$ID.json
  git -C $REPO add wasm64-build/releases/$ID.json && git -C $REPO commit -m "release $ID"
  git -C $REPO tag -a $ID -m "lean4-wasm64 $ID ($DIGEST)"
  # repository owner — the line and the tag first, then the bytes:
  git -C $REPO push origin $LINE $ID
  gh release create $ID --repo FawadHa1der/lean4 --draft --verify-tag --title "lean4-wasm64 $ID" --notes "Toolchain release $ID. Pin: --id $ID --digest $DIGEST. Contents and digests: release.json"
  (cd $REL && find . -type f | sed 's|^\./||' | xargs -n 25 gh release upload $ID --repo FawadHa1der/lean4)   # flat, by basename
  gh release edit $ID --repo FawadHa1der/lean4 --draft=false
  # R2 (served layout; objects, then manifests, then release.json — js/formats/HOSTING.md):
  rclone copy $REL qed64-r2:qed64-artifacts/lean4-wasm64/$ID/ --immutable --s3-no-check-bucket --checksum --filter '- *.json' --filter '- SHA256SUMS' --header-upload "Content-Type: application/octet-stream" --transfers 4 --s3-chunk-size 64M
  rclone copy $REL qed64-r2:qed64-artifacts/lean4-wasm64/$ID/ --immutable --s3-no-check-bucket --checksum --filter '- /release.json' --filter '+ *.json' --filter '+ /SHA256SUMS' --filter '- *' --header-upload "Content-Type: application/json"
  rclone copyto $REL/release.json qed64-r2:qed64-artifacts/lean4-wasm64/$ID/release.json --immutable --s3-no-check-bucket --header-upload "Content-Type: application/json"
EOF
