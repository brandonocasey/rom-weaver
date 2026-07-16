# Agent instructions

## Worktrees

`vendor/nod` and `vendor/libarchive` are Git submodules. `scripts/setup-worktree.sh`
links populated copies from the main checkout into linked worktrees, so Git may
show those paths as expected gitlink-to-symlink typechanges.

Git refuses to remove any worktree containing submodules, even when it is clean.
Before cleanup, verify the worktree has no real changes, then use the repository
helper:

```bash
scripts/remove-worktree.sh .worktrees/<name>
```

The helper ignores only the expected vendor symlinks, refuses other tracked or
untracked changes, and uses `git worktree remove --force` after that check.
