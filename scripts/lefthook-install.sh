#!/usr/bin/env sh
# Install lefthook git hooks, but ONLY from the main checkout.
#
# Worktrees share `.git/hooks`, and lefthook bakes its node_modules path into the
# hook. Installing from a disposable worktree would break every checkout after
# that worktree is removed. Worktrees inherit the stable main-checkout hook.
set -eu

# Outside a git work tree (e.g. installed as a dependency, or a tarball build),
# there is nothing to install into - skip quietly.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

common_dir="$(git rev-parse --git-common-dir)"
main_dir="$(cd "$common_dir/.." && pwd)"
worktree_dir="$(git rev-parse --show-toplevel)"

if [ "$main_dir" != "$worktree_dir" ]; then
  echo "lefthook-install: in a worktree - skipping install (shared hooks come from the main checkout)"
  exit 0
fi

lefthook install
