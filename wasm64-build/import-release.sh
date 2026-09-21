#!/usr/bin/env bash
# Import an upstream Lean release into the wasm64 kernel line (branch
# qed64-wasm64), build + gate it, and hand the artifact to the two apps.
#
#   wasm64-build/import-release.sh watch             # is there a release we have not imported?
#   wasm64-build/import-release.sh import  <tag>     # branch import/<tag>, merge the tag (stops on conflicts)
#   wasm64-build/import-release.sh drift   <tag>     # files BOTH sides changed: the semantic-drift review list
#   wasm64-build/import-release.sh build   <tag>     # Docker stage1 build into ../wasm64-lean-kernel-build-<tag>
#   wasm64-build/import-release.sh gate    <tag>     # release gate on that artifact (writes GATE-PASSED)
#   wasm64-build/import-release.sh accept  <tag>     # fast-forward qed64-wasm64 to import/<tag> (LOCAL only)
#   wasm64-build/import-release.sh status  [<tag>]   # where an import stands
#   wasm64-build/import-release.sh run     <tag>     # import -> build -> gate, stopping at the first thing
#                                                    # that needs judgment (conflicts, build break, gate fail)
#
# Nothing here pushes, uploads or deploys: `accept` prints the push command and
# the downstream lanes (RELEASE-PIPELINE.md) end at a ship gate the repository
# owner runs by hand. The version imported so far is not stored anywhere — it
# is the newest upstream stable tag that is an ancestor of the branch.
#
# Exit codes: 0 done / up to date; 10 a new release is ready to import;
# 11 a new release exists but Mathlib/Batteries have not tagged it yet;
# 20 merge conflicts left in the tree; 30 build failed; 31 gate failed; 2 usage.
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
cd "$REPO"

say()  { printf '%s\n' "$*"; }
die()  { printf 'import-release: %s\n' "$*" >&2; exit "${2:-1}"; }
build_dir() { printf '%s' "${QED64_BUILD_DIR:-$REPO/../wasm64-lean-kernel-build-$1}"; }
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
  [ -f "$bd/BUILT-COMMIT" ] && git diff --quiet "$(cat "$bd/BUILT-COMMIT")" "import/$1" -- src stage0 docker-wasm64 CMakeLists.txt CMakePresets.json
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
  git switch -c "$br" "$LINE"
  say "merging $tag ($(git rev-list --count "$LINE..$tag") upstream commits) into $br"
  if git merge --no-ff --no-commit "$tag" >/dev/null 2>&1; then :; fi
  # stage0/ is upstream's bootstrap compiler: never merge it, take theirs and
  # re-apply the line's two pointer-width gates (stage0-line-edits.patch).
  local s0; s0="$(git diff --name-only --diff-filter=U -- stage0 || true)"
  if [ -n "$s0" ]; then
    echo "$s0" | xargs git checkout --theirs --
    git apply --3way "$REPO/wasm64-build/stage0-line-edits.patch" 2>/dev/null \
      || say "note: stage0-line-edits.patch no longer applies — check whether upstream absorbed the gates, then refresh it"
    echo "$s0" | xargs git add --
  fi
  local unmerged; unmerged="$(git diff --name-only --diff-filter=U)"
  if [ -n "$unmerged" ]; then
    say "CONFLICTS — resolve, 'git add', 'git commit', then: $0 build $tag"
    say "$unmerged" | sed 's/^/  U /'
    return 20
  fi
  git commit --quiet -m "Merge tag '$tag' into the wasm64 kernel line"
  say "merged cleanly: $(git rev-parse --short HEAD). Review the drift list before trusting it: $0 drift $tag"
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
  say "building into $bd (log: $log) — 1.5-3 h cold"
  rm -f "$bd/GATE-PASSED"
  if ! QED64_BUILD_DIR="$bd" bash "$REPO/wasm64-build/build.sh" >"$log" 2>&1; then
    grep -nE "error:|Error [0-9]|Killed|FAILED" "$log" | tail -20 || true
    die "build failed — $log" 30
  fi
  # a rebuild can 'succeed' around a failed target and leave a stale binary
  if grep -qE "^make.*Error [0-9]" "$log"; then die "make reported errors — $log" 30; fi
  git rev-parse HEAD > "$bd/BUILT-COMMIT"
  python3 "$REPO/wasm64-build/gen-exports.py" "$bd/build/stage1/lib/temp" "$REPO/src" --check
  say "built $(git rev-parse --short HEAD): buildId wasm64-$(shasum -a 256 "$bd/build/stage1/bin/lean.wasm" | cut -c1-16)"
}

cmd_gate() {
  need_tag "$1"; local bd; bd="$(build_dir "$1")"
  [ -f "$bd/build/stage1/bin/lean.wasm" ] || die "no artifact in $bd — build first" 31
  built_from_head "$1" || die "sources changed since the artifact was built — rebuild" 31
  local log="$bd/gate.log"
  # ~8 min: the two one-shot CLI checks are judged by output and end in a bounded timeout
  if node --stack-size=8192 "$REPO/wasm64-build/gate.mjs" --artifact "$bd/build/stage1" >"$log" 2>&1 && grep -q "GATE PASSED" "$log"; then
    grep -E "^(FAIL| ok)" "$log" || true
    { git rev-parse "import/$1"; shasum -a 256 "$bd/build/stage1/bin/lean.wasm" | cut -c1-64; } > "$bd/GATE-PASSED"
    say "GATE PASSED"
  else
    grep -E "^(FAIL| ok)" "$log" || tail -20 "$log"
    die "gate failed — $log" 31
  fi
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
  need_tag "$1"
  cmd_import "$1" || return $?
  cmd_build "$1"
  cmd_gate "$1"
  say "kernel side done. Next: review '$0 drift $1', then the downstream lanes in wasm64-build/RELEASE-PIPELINE.md"
}

case "${1:-}" in
  watch)  cmd_watch ;;
  import) cmd_import "${2:-}" ;;
  drift)  cmd_drift "${2:-}" ;;
  build)  cmd_build "${2:-}" ;;
  gate)   cmd_gate "${2:-}" ;;
  accept) cmd_accept "${2:-}" ;;
  status) cmd_status "${2:-}" ;;
  run)    cmd_run "${2:-}" ;;
  *) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
