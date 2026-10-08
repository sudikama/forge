#!/bin/bash
# forge must start its tracker in any git layout: missing .git/info, submodule (.git is a file),
# linked worktree (shared common dir), and a plain directory that is not a git repo.
set -u
F="node $(cd "$(dirname "$0")/../.." && pwd)/bin/forge.mjs"
W=$(mktemp -d "${TMPDIR:-/tmp}/forge-layouts-XXXX")
export FORGE_HOME=$W/home
fail=0
ok() { if [ "$2" = 0 ]; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
mk() { git init -q "$1" && git -C "$1" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init; }
check() { # name dir
  local name=$1 d=$2 out
  out=$(cd "$d" && $F new "${name}-1" --mode small --title x 2>&1); ok "$name: forge new starts" $?
  [ -d "$d/.forge/tasks/${name}-1" ]; ok "$name: task dir created" $?
  if git -C "$d" rev-parse --git-dir >/dev/null 2>&1; then
    [ -z "$(git -C "$d" status --porcelain)" ]; ok "$name: git status stays clean" $?
    grep -qx '.forge/' "$(cd "$d" && git rev-parse --path-format=absolute --git-path info/exclude)"; ok "$name: exclude written to the real git dir" $?
  fi
}

mk "$W/a"; rm -rf "$W/a/.git/info";                     check missing-info "$W/a"
mk "$W/sub"; mk "$W/parent"
git -C "$W/parent" -c protocol.file.allow=always submodule add -q "$W/sub" lib >/dev/null 2>&1
git -C "$W/parent" -c user.name=t -c user.email=t@t commit -q -m sub
check submodule "$W/parent/lib"
[ -z "$(git -C "$W/parent" status --porcelain)" ]; ok "submodule: parent repo stays clean" $?
mk "$W/c"; git -C "$W/c" worktree add -q "$W/c-wt" -b wt >/dev/null 2>&1; check worktree "$W/c-wt"
mkdir -p "$W/plain";                                     check not-a-repo "$W/plain"

rm -rf "$W"
[ $fail = 0 ] && echo "layouts: ALL PASS" || { echo "layouts: FAILURES"; exit 1; }
