#!/usr/bin/env bash
# Import an upstream Lean release into the wasm64 kernel line (branch
# qed64-wasm64), build + gate it, and hand the artifact to the two apps.
#
#   wasm64-build/import-release.sh watch             # is there a release we have not imported?
#   wasm64-build/import-release.sh import  <tag>     # branch import/<tag>, merge the tag (stops on conflicts)
#   wasm64-build/import-release.sh drift   <tag>     # files BOTH sides changed: the semantic-drift review list
#   wasm64-build/import-release.sh delta   <tag> [<rev>]
#                                                    # paths where <rev> (import/<tag>) is not the tag merged with
#                                                    # the line's own changes: run it before the first build, and
#                                                    # again before accept
#   wasm64-build/import-release.sh build   <tag>     # Docker stage1 build into ../wasm64-lean-kernel-build-<tag>
#   wasm64-build/import-release.sh gate    <tag>     # release gate on that artifact (writes GATE-PASSED)
#   wasm64-build/import-release.sh gate-dir <build dir>
#                                                    # the same gate on any build dir (a kernel-only fix)
#   wasm64-build/import-release.sh accept  <tag>     # fast-forward qed64-wasm64 to import/<tag> (LOCAL only)
#   wasm64-build/import-release.sh release <tag> [--base <base mirror> (--recut <n> | --runtime <build dir>) --note …]
#                                                    [stage-release.sh options]
#                                                    # stage + verify the lean4-wasm64 release (RELEASE.md);
#                                                    # --base: a release by reference of a first cut — a tools
#                                                    # re-cut (--recut) or a new runtime (--runtime)
#   wasm64-build/import-release.sh publish <id> [publish-release.mjs options]
#                                                    # the owner's step: record + tag, push, GitHub release,
#                                                    # R2, each verified; resumable (--dry-run to preview)
#   wasm64-build/import-release.sh status  [<tag>]   # where an import stands
#   wasm64-build/import-release.sh run     <tag>     # import, then stop before the build: on conflicts, or
#                                                    # with drift's and delta's lists after a clean merge.
#                                                    # Run again once they are accounted for: delta (prints)
#                                                    # -> build -> gate, stopping on a build break or a gate
#                                                    # failure
#
# Only `publish` pushes or uploads, and the repository owner runs it. Otherwise
# nothing here pushes, uploads or deploys: `accept` prints the push command and
# the downstream lanes (RELEASE-PIPELINE.md) end at a ship gate the repository
# owner runs by hand. The version imported so far is not stored anywhere — it
# is the newest upstream stable tag that is an ancestor of the branch.
#
# Exit codes: 0 done / up to date; 10 a new release is ready to import;
# 11 a new release exists but Mathlib/Batteries have not tagged it yet;
# 20 merge conflicts left in the tree; 21 run committed the merge and stopped
# before the build, for drift and delta; 30 build failed; 31 gate failed; 2 usage.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LINE=qed64-wasm64                     # the branch both apps pin
UPSTREAM_URL=https://github.com/leanprover/lean4
MATHLIB_URL=https://github.com/leanprover-community/mathlib4
BATTERIES_URL=https://github.com/leanprover-community/batteries

# A machine whose Xcode licence is unaccepted breaks /usr/bin/git; the
# CommandLineTools git works. Harmless elsewhere.
if ! git --version >/dev/null 2>&1 && [ -d /Library/Developer/CommandLineTools ]; then
  export DEVELOPER_DIR=/Library/Developer/CommandLineTools
fi
export LEAN4_WASM64_CALLER_CWD="$PWD"   # stage-release.sh resolves relative paths against it
cd "$REPO"

say()  { printf '%s\n' "$*"; }
die()  { printf 'import-release: %s\n' "$1" >&2; exit "${2:-1}"; }
# a relative QED64_BUILD_DIR or gate-dir argument is the caller's (we cd to the repo)
abs_path() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s' "$LEAN4_WASM64_CALLER_CWD/$1" ;; esac; }
build_dir() { abs_path "${QED64_BUILD_DIR:-$REPO/../wasm64-lean-kernel-build-$1}"; }
SRC_PATHS=(src stage0 docker-wasm64 CMakeLists.txt CMakePresets.json wasm64-build/gen-exports.py)
need_tag() { [[ "${1:-}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "expected a stable tag like v4.34.0, got '${1:-}'" 2; }

ensure_upstream() {
  git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_URL"
}

# Newest stable upstream tag (vX.Y.Z, no -rc) — from the remote, no fetch.
latest_stable() {
  git ls-remote --tags --refs "$UPSTREAM_URL" 'v[0-9]*' \
    | sed -E 's#.*refs/tags/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1
}

# Newest stable upstream tag already merged into a ref (needs the tags locally).
# Upstream cuts stable tags on release branches, so a line based on master
# contains none until its first import (Lean 3's v3.* tags do not count).
imported_tag() {
  git tag --merged "${1:-$LINE}" 'v[0-9]*' | grep -E '^v([4-9]|[1-9][0-9]+)\.[0-9]+\.[0-9]+$' | sort -V | tail -1
}

has_remote_tag() { [ -n "$(git ls-remote --tags --refs "$1" "$2")" ]; }

cmd_watch() {
  ensure_upstream
  local latest have
  latest="$(latest_stable)"; have="$(imported_tag "$LINE" || true)"
  say "line:      $LINE @ $(git rev-parse --short "$LINE")"
  say "imported:  ${have:-<none — base predates every stable tag on the line>}"
  say "upstream:  $latest"
  if [ "$latest" = "$have" ]; then say "up to date"; return 0; fi
  local ok=0
  for pair in "mathlib4 $MATHLIB_URL" "batteries $BATTERIES_URL"; do
    set -- $pair
    if has_remote_tag "$2" "$latest"; then say "$1:  tagged $latest"; else say "$1:  NOT tagged $latest yet"; ok=1; fi
  done
  if [ "$ok" = 1 ]; then
    say "new release $latest, but the libraries the apps ship are not tagged for it — wait"; return 11
  fi
  say "NEW RELEASE READY: $0 run $latest"; return 10
}

# The artifact is current when nothing that feeds the build changed since it
# was built (docs and pipeline scripts may move on).
built_from_head() {
  local bd; bd="$(build_dir "$1")"
  [ -f "$bd/BUILT-COMMIT" ] && git diff --quiet "$(cat "$bd/BUILT-COMMIT")" "import/$1" -- "${SRC_PATHS[@]}"
}

both_sides() { # files changed on the line AND upstream since their merge base
  local base; base="$(git merge-base "$1" "$2")"
  comm -12 <(git diff --name-only "$base" "$1" | sort) <(git diff --name-only "$base" "$2" | sort)
}

cmd_drift() {
  need_tag "$1"
  local ours="$LINE"
  # after the merge the two sides are the merge commit's parents
  if git rev-parse -q --verify "import/$1^2" >/dev/null 2>&1; then ours="import/$1^1"; fi
  say "# files changed by BOTH the wasm64 line and upstream up to $1."
  say "# Textually merged is not semantically merged: review each (RELEASE-PIPELINE.md, 'Drift review')."
  both_sides "$ours" "$1" | grep -v '^stage0/' || true
}

# Is <rev> the tag plus the line's own changes? Stable tags sit on release
# branches and the merge base is on master, so git's merge keeps the previous
# tag's release-branch copies wherever master's side looks unchanged (v4.36.0:
# a module and three checker pins that v4.35.0 had and v4.36.0 does not).
# delta redoes the merge over the previous tag instead: git merge-tree of the
# tag and the line before the merge (<merge>^1) with <prev> as the base, by
# path (no rename detection) and with the line's attributes, so a release-
# branch copy is the base and cannot win. That merge writes into a throwaway
# object store: delta adds no object to the repository (git may refresh the
# timestamps of objects or packs the merge recomputes). It then lists each
# path outside stage0 (taken whole) where <rev> (default import/<tag>) is not
# that merge's result: CONFLICT where the merge conflicts (always listed),
# DEVIATES where the line had changed the path since <prev> (by name), NOT-TAG
# where it had not, so the tag's file was due. A path neither tag has is the
# line's own: what commits after the merge do to it is not delta's business,
# but a path the merge commit itself added or dropped is (LINE-ONLY: git moves
# a line-only file into a directory upstream renamed; a conflict's side file
# committed). Each entry needs a reason (the merge message, a fix commit) or
# a fix.
merge_of() { # the first-parent commit of <rev> whose second parent is <tag>
  local t c; t="$(git rev-parse "$1^{commit}")"
  for c in $(git rev-list --first-parent --merges "$2"); do
    [ "$(git rev-parse "$c^2")" = "$t" ] && { printf '%s' "$c"; return 0; }
  done
  return 1
}
in_list() { local x="$1" e; shift; for e in "$@"; do [ "$e" = "$x" ] && return 0; done; return 1; }
has() { git cat-file -e "$1:$2" 2>/dev/null; }   # does tree-ish $1 have path $2?

cmd_delta() {
  need_tag "$1"; local tag="$1" rev="${2:-import/$1}" merge ours prev objs tmp rc=0 n=0 want f how
  local -a conflicted=()
  for f in "$tag" "$rev"; do git rev-parse -q --verify "$f^{commit}" >/dev/null || die "no commit $f here (fetched?)"; done
  merge="$(merge_of "$tag" "$rev")" || die "no first-parent commit of $rev merges $tag"
  ours="$(git rev-parse "$merge^1")"
  # imported_tag fails when no stable tag is merged (cmd_status relies on that)
  prev="$(imported_tag "$ours")" \
    || die "the line before the merge ($(git rev-parse --short "$ours")) has no stable tag (is the previous tag fetched?)"
  objs="$(cd "$(git rev-parse --git-path objects)" && pwd)"
  tmp="$(mktemp -d)"; trap "rm -rf $(printf %q "$tmp")" EXIT   # expanded now: tmp is local, and set -u
  mkdir "$tmp/objects"
  say "# $rev against $tag merged with the line's changes $prev..$(git rev-parse --short "$ours") (by path); stage0 is taken whole, not checked"
  ( # every git here writes into the throwaway store and reads the repository's objects through it
    export GIT_OBJECT_DIRECTORY="$tmp/objects" GIT_ALTERNATE_OBJECT_DIRECTORIES="$objs"
    # line 1: the merge's tree; then the conflicted paths. Exit 1 only means conflicts.
    git --attr-source="$ours" merge-tree --write-tree -z --name-only --no-messages -X no-renames \
      --merge-base="$prev" "$ours" "$tag" >"$tmp/merge" || rc=$?
    [ "$rc" -le 1 ] || die "git merge-tree of $tag and $ours over $prev failed (exit $rc)"
    { IFS= read -r -d '' want
      while IFS= read -r -d '' f; do case "$f" in stage0/*) ;; *) conflicted+=("$f") ;; esac; done; } <"$tmp/merge"
    for f in ${conflicted[@]+"${conflicted[@]}"}; do
      if git diff-tree -r --quiet "$want" "$rev" -- ":(literal)$f"; then
        say "CONFLICT  $f  (that merge conflicts here, and $rev has its unresolved entry: markers, or one side)"
      else
        say "CONFLICT  $f  (that merge conflicts here: review the resolution)"
      fi; n=$((n + 1))
    done
    git diff-tree -r -z --name-only "$want" "$rev" -- ':!stage0' >"$tmp/differs"
    while IFS= read -r -d '' f; do
      in_list "$f" ${conflicted[@]+"${conflicted[@]}"} && continue
      if ! has "$prev" "$f" && ! has "$tag" "$f"; then
        # the line's own path: listed only where the merge commit added it, or dropped it and <rev> still lacks it
        git diff-tree -r --quiet "$ours" "$merge" -- ":(literal)$f" && continue
        if has "$merge" "$f" && ! has "$ours" "$f"; then how=added
        elif ! has "$merge" "$f" && ! has "$rev" "$f"; then how=dropped
        else continue; fi
        say "LINE-ONLY $f  (neither tag has it, and the merge commit $how it)"; n=$((n + 1)); continue
      fi
      if ! git diff-tree -r --quiet "$prev" "$ours" -- ":(literal)$f"; then
        say "DEVIATES  $f  (the line changed it since $prev, and $rev's is not that merge's)"
      elif ! has "$tag" "$f"; then
        say "NOT-TAG   $f  (the line had not changed it since $prev, and $tag does not have it)"
      elif ! has "$rev" "$f"; then
        say "NOT-TAG   $f  (the line had not changed it since $prev, and $rev does not have it)"
      else
        say "NOT-TAG   $f  (the line had not changed it since $prev, and $rev's is not $tag's)"
      fi; n=$((n + 1))
    done <"$tmp/differs"
    say "# $n path(s) to account for"
  )
  rm -rf "$tmp"; trap - EXIT
}

cmd_import() {
  need_tag "$1"; local tag="$1" br="import/$1"
  ensure_upstream
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "working tree not clean"
  git fetch --quiet upstream "refs/tags/$tag:refs/tags/$tag"
  if git merge-base --is-ancestor "$tag" "$LINE"; then say "$tag is already on $LINE"; return 0; fi
  if git rev-parse -q --verify "$br" >/dev/null; then
    git merge-base --is-ancestor "$tag" "$br" && { say "$br already contains $tag"; return 0; }
    die "$br exists without $tag merged — finish or delete it"
  fi
  git config rerere.enabled true        # remember resolutions across imports
  local from; from="$(git symbolic-ref -q --short HEAD || git rev-parse HEAD)"   # where HEAD was
  git switch -c "$br" "$LINE"
  say "merging $tag ($(git rev-list --count "$LINE..$tag") upstream commits) into $br"
  # exit 1 = conflicts, left in the tree. Anything else (2: an untracked file in
  # the way, say) means no merge started, and nothing below may commit: the
  # stage0 step would stage the tag's stage0 and `git commit` would record it as
  # a one-parent "Merge tag" commit. MERGE_HEAD holds what was merged (the tag
  # object for an annotated tag: compare commits). The new branch is then all
  # there is to undo: back to where HEAD was, and the branch goes, unless the
  # merge left the tree changed.
  local mrc=0; git merge --no-ff --no-commit "$tag" >/dev/null || mrc=$?
  if [ "$mrc" -gt 1 ] || [ "$(git rev-parse -q --verify 'MERGE_HEAD^{commit}' || :)" != "$(git rev-parse "$tag^{commit}")" ]; then
    [ -z "$(git status --porcelain --untracked-files=no)" ] \
      && { git switch -q "$from" 2>/dev/null || git switch -q --detach "$from"; } && git branch -q -D "$br" \
      && die "git merge $tag did not start (exit $mrc, git's message above): $br is deleted, HEAD is back where it was. Fix that and rerun"
    die "git merge $tag did not start (exit $mrc, git's message above): nothing was committed. Fix that, leave $br (git switch --detach), delete it (git branch -D $br) and rerun"
  fi
  # stage0/ is upstream's bootstrap compiler, built natively (64-bit): never
  # merge it, take the tag's tree whole (files it dropped go too). The line
  # keeps no edits there (v4.36.0's build confirmed upstream's stage0 builds it).
  # Out of the index and the tree first: restore refuses an unmerged path the tag
  # does not have (modify/delete, the side files of a file/directory swap).
  git rm -r -q -f --ignore-unmatch -- stage0 && git restore --source="$tag" --staged --worktree -- stage0 \
    || die "could not take $tag's stage0 (above): the merge is left in the tree, nothing was committed"
  local unmerged; unmerged="$(git diff --name-only --diff-filter=U)"
  if [ -n "$unmerged" ]; then
    say "CONFLICTS — resolve, 'git add', 'git commit', then: $0 drift $tag; $0 delta $tag; $0 build $tag"
    say "$unmerged" | sed 's/^/  U /'
    return 20
  fi
  git commit --quiet -m "Merge tag '$tag' into the wasm64 kernel line"
  say "merged cleanly: $(git rev-parse --short HEAD). Before the first build: $0 drift $tag; $0 delta $tag"
}

cmd_build() {
  need_tag "$1"; local tag="$1" bd; bd="$(build_dir "$1")"
  [ "$(git rev-parse --abbrev-ref HEAD)" = "import/$tag" ] || die "check out import/$tag first"
  [ -z "$(git diff --name-only --diff-filter=U)" ] || die "unresolved conflicts" 20
  docker info >/dev/null 2>&1 || die "Docker is not running (open -a Docker)" 30
  mkdir -p "$bd"
  # a COPY of an older build's ccache is a fine seed; never share one live
  if [ ! -d "$bd/ccache" ] && [ -n "${QED64_CCACHE_SEED:-}" ] && [ -d "$QED64_CCACHE_SEED" ]; then cp -R "$QED64_CCACHE_SEED" "$bd/ccache"; fi
  local log="$bd/build-$(date +%Y%m%d-%H%M%S).log"
  say "building into $bd (log: $log) — ~15-30 min cold on 14 cores"
  rm -f "$bd/GATE-PASSED"
  if ! QED64_BUILD_DIR="$bd" bash "$REPO/wasm64-build/build.sh" >"$log" 2>&1; then
    grep -nE "error:|Error [0-9]|Killed|FAILED" "$log" | tail -20 || true
    die "build failed — $log" 30
  fi
  # a rebuild can 'succeed' around a failed target and leave a stale binary
  if grep -qE "^make.*Error [0-9]" "$log"; then die "make reported errors — $log" 30; fi
  # build.sh records BUILT-COMMIT only for a build of clean, unmoving sources
  [ -f "$bd/BUILT-COMMIT" ] || die "the sources were dirty or moved during the build: no BUILT-COMMIT — commit and rebuild" 30
  # the export list and the native-symbol table (0039) the build linked are this tree's: a fresh
  # selection, with the same nm cross-check, must match the build's manifest (exit 1 otherwise)
  local temp="$bd/build/stage1/lib/temp" libs="$bd/build/stage1/lib/lean"
  python3 "$REPO/wasm64-build/gen-exports.py" "$temp" "$REPO/src" --check --symtab-manifest "$temp/lean_wasm_symtab.json" \
    --archives "$libs/libInit.a" "$libs/libStd.a" "$libs/libLean.a" --nm "${QED64_NM:-auto}" \
    || die "the build's export list or native-symbol table is not this tree's (gen-exports.py --check above) — rebuild" 30
  say "built $(git rev-parse --short HEAD): buildId wasm64-$(shasum -a 256 "$bd/build/stage1/bin/lean.wasm" | cut -c1-16)"
}

# Gate the artifact of build dir $1 (BUILT-COMMIT names what was built). GATE-PASSED
# = BUILT-COMMIT + sha256(lean.wasm), written only on a pass and removed first, so a
# later failed or interrupted gate never leaves an earlier pass standing.
gate_build_dir() {
  local bd="$1" log="$1/gate.log"
  [ -f "$bd/build/stage1/bin/lean.wasm" ] || die "no artifact in $bd — build first" 31
  [ -f "$bd/BUILT-COMMIT" ] || die "$bd/BUILT-COMMIT missing: not a recorded build" 31
  rm -f "$bd/GATE-PASSED"
  # ~8 min: the two one-shot CLI checks are judged by output and end in a bounded timeout
  if node --stack-size=8192 "$REPO/wasm64-build/js/gate.mjs" --artifact "$bd/build/stage1" >"$log" 2>&1 && grep -q "GATE PASSED" "$log"; then
    grep -E "^(FAIL| ok)" "$log" || true
    { tr -d ' \n\r' < "$bd/BUILT-COMMIT"; echo; shasum -a 256 "$bd/build/stage1/bin/lean.wasm" | cut -c1-64; } > "$bd/GATE-PASSED"
    say "GATE PASSED"
  else
    grep -E "^(FAIL| ok)" "$log" || tail -20 "$log"
    die "gate failed — $log" 31
  fi
}

cmd_gate() {
  need_tag "$1"; local bd; bd="$(build_dir "$1")"
  built_from_head "$1" || die "sources changed since the artifact was built — rebuild" 31
  # the gate runs from the working tree: HEAD's gate checks HEAD's patches (0044's code, for one),
  # so gating an older tag's build from a later line would fail and remove that build's GATE-PASSED
  git diff --quiet "$(cat "$bd/BUILT-COMMIT")" HEAD -- "${SRC_PATHS[@]}" \
    || die "the sources at HEAD differ from $bd's build: gate it from import/$1, or gate-dir a build of HEAD" 31
  gate_build_dir "$bd"
}

cmd_gate_dir() {
  local bd; bd="$(abs_path "${1:-}")"; [ -n "${1:-}" ] && [ -d "$bd" ] || die "usage: $0 gate-dir <build dir>" 2
  bd="$(cd "$bd" && pwd)"
  [ -f "$bd/BUILT-COMMIT" ] || die "$bd/BUILT-COMMIT missing (build.sh writes it after a build from a clean tree)" 31
  git diff --quiet "$(cat "$bd/BUILT-COMMIT")" HEAD -- "${SRC_PATHS[@]}" \
    || die "the sources at HEAD differ from the build's commit — gate a build of HEAD" 31
  gate_build_dir "$bd"
}

cmd_accept() {
  need_tag "$1"; local bd; bd="$(build_dir "$1")"
  [ -f "$bd/GATE-PASSED" ] && built_from_head "$1" \
    && [ "$(sed -n 2p "$bd/GATE-PASSED")" = "$(shasum -a 256 "$bd/build/stage1/bin/lean.wasm" | cut -c1-64)" ] \
    || die "import/$1's sources have no passing gate for the artifact in $bd" 31
  git merge-base --is-ancestor "$LINE" "import/$1" || die "$LINE moved since the import branched — merge it into import/$1, rebuild, re-gate"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "working tree not clean"
  git switch --quiet "$LINE" && git merge --ff-only --quiet "import/$1"
  say "$LINE -> $(git rev-parse --short HEAD) (LOCAL). The apps' KERNEL-PIN files may only name a commit that is on origin:"
  say "    git -C $REPO push origin $LINE        # run by the repository owner"
}

cmd_status() {
  ensure_upstream
  say "line $LINE @ $(git rev-parse --short "$LINE"), imported $(imported_tag "$LINE" || echo '<none>')"
  local tag="${1:-}"; [ -n "$tag" ] || return 0
  need_tag "$tag"; local bd; bd="$(build_dir "$tag")"
  if git rev-parse -q --verify "import/$tag" >/dev/null; then
    say "import/$tag @ $(git rev-parse --short "import/$tag")$(git merge-base --is-ancestor "$tag" "import/$tag" 2>/dev/null && echo ' (tag merged)' || echo ' (merge not committed)')"
  else say "import/$tag: not started"; fi
  [ -f "$bd/BUILT-COMMIT" ] && say "built:  $(cut -c1-10 "$bd/BUILT-COMMIT") in $bd" || say "built:  no"
  [ -f "$bd/GATE-PASSED" ] && say "gate:   passed for $(head -1 "$bd/GATE-PASSED" | cut -c1-10)" || say "gate:   not passed"
  git merge-base --is-ancestor "$tag" "$LINE" 2>/dev/null && say "accepted onto $LINE" || say "not on $LINE yet"
}

cmd_run() {
  need_tag "$1"; local tag="$1" self="$REPO/wasm64-build/import-release.sh" made=1
  git rev-parse -q --verify "import/$tag" >/dev/null && made=0   # merged before: by import, or an earlier run
  # A plain call, so errexit stays on inside cmd_import: under `|| …` bash
  # switches it off there, and a failed switch, restore or commit would run on
  # into the build. Its return 20 still ends the script with 20.
  cmd_import "$tag"
  if git merge-base --is-ancestor "$tag" "$LINE"; then say "nothing to run"; return 0; fi
  # drift and delta are quick and add nothing to the repository. Each runs as
  # its own process, so that a failure there (the previous tag not fetched,
  # say) stops only it, and errexit stays on inside it.
  if [ "$made" = 1 ]; then
    # This run made the merge: stop before the build, while a fix to what the
    # build reads costs no rebuild and no re-gate.
    bash "$self" drift "$tag" || say "note: drift failed (above)"
    bash "$self" delta "$tag" || say "note: delta failed (above): fix that before the build"
    say "run stops before the build: account for drift's and delta's lists. A fix to what the build reads (${SRC_PATHS[*]}) goes on import/$tag now, not after a build. Then: $0 run $tag"
    return 21
  fi
  bash "$self" delta "$tag" \
    || die "delta failed (above): fix that and run again, or build and gate by hand ($0 build $tag; $0 gate $tag)"
  cmd_build "$tag"
  cmd_gate "$tag"
  say "kernel side done. Before accept: '$0 delta $tag' again, every entry with its reason (the merge message or a fix commit), and the drift review done; then the downstream lanes in wasm64-build/RELEASE-PIPELINE.md"
}

case "${1:-}" in
  watch)  cmd_watch ;;
  import) cmd_import "${2:-}" ;;
  drift)  cmd_drift "${2:-}" ;;
  delta)  cmd_delta "${2:-}" "${3:-}" ;;
  build)  cmd_build "${2:-}" ;;
  gate)   cmd_gate "${2:-}" ;;
  gate-dir) cmd_gate_dir "${2:-}" ;;
  accept) cmd_accept "${2:-}" ;;
  status) cmd_status "${2:-}" ;;
  run)    cmd_run "${2:-}" ;;
  release) shift; exec "$REPO/wasm64-build/stage-release.sh" "$@" ;;
  publish) shift; exec node "$REPO/wasm64-build/publish-release.mjs" "$@" ;;
  *) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$REPO/wasm64-build/import-release.sh"; exit 2 ;;
esac
