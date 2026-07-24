#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

try {
  execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
} catch {
  process.exit(0);
}
const commonDir = resolve(process.cwd(), execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim());
const mainDir = resolve(commonDir, "..");
const worktreeDir = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
if (mainDir !== worktreeDir) {
  process.stdout.write("lefthook-install: in a worktree - skipping install (shared hooks come from the main checkout)\n");
  process.exit(0);
}
execFileSync("lefthook", ["install"], { cwd: mainDir, stdio: "inherit" });
