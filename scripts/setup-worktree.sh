#!/usr/bin/env bash
# Mirror the main checkout's node_modules into a fresh git worktree without
# breaking local workspace (`file:`) dependencies.
#
# The trap this avoids: symlinking a worktree's node_modules wholesale from main
# makes `file:` workspace deps resolve back into MAIN. Those deps are *relative*
# symlinks (e.g. `rom-weaver-wasm -> ../../rom-weaver-wasm`); when the parent
# node_modules is itself a symlink into main, that relative target follows it
# back to main. The dev server then serves that package's source — and its built
# wasm (`new URL('../rom-weaver-app.wasm', import.meta.url)`) — from main, so
# edits made in the worktree silently never take effect.
#
# Fix: make each node_modules a REAL directory and mirror main's entries by kind:
#   - third-party deps (real dirs)  -> symlink to main's copy (shared, fast)
#   - symlink entries (workspace/file: deps) -> copy the symlink itself, so its
#     relative target resolves inside THIS worktree
#
# Usage (from inside the worktree):  scripts/setup-worktree.sh
# Re-runnable; rebuilds the mirrored node_modules each time.
#
# Note: vendored submodules under vendor/ and the wasm build artifact are NOT
# handled here — link/build those separately.
set -euo pipefail

main_dir="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
worktree_dir="$(git rev-parse --show-toplevel)"
if [ "$main_dir" = "$worktree_dir" ]; then
  echo "setup-worktree: run this from inside a worktree, not the main checkout" >&2
  exit 1
fi

mirror_node_modules() {
  local rel="$1"
  local main_nm="$main_dir/$rel"
  local wt_nm="$worktree_dir/$rel"
  [ -d "$main_nm" ] || return 0
  rm -rf "$wt_nm"
  mkdir -p "$wt_nm"
  local name
  for name in $(ls -A "$main_nm"); do
    if [ -L "$main_nm/$name" ]; then
      # Workspace/file: dep — preserve the (relative) link so it resolves here.
      cp -P "$main_nm/$name" "$wt_nm/$name"
    else
      # Third-party dep — share main's installed copy.
      ln -s "$main_nm/$name" "$wt_nm/$name"
    fi
  done
  echo "  mirrored $rel"
}

mirror_node_modules "node_modules"
for pkg_nm in "$main_dir"/packages/*/node_modules; do
  [ -d "$pkg_nm" ] || continue
  mirror_node_modules "packages/$(basename "$(dirname "$pkg_nm")")/node_modules"
done

echo "setup-worktree: done for $worktree_dir"
