#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import os from "node:os";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const PRUNE_PATHS = [
  ".git", ".github", ".cirrus.yml", "libarchive/test", "cat/test", "cpio/test", "tar/test", "unzip/test", "test_utils", "doc", "examples", "contrib",
  "build/autoconf", "build/ci", "build/release", "build/utils", "build/autogen.sh", "build/bump-version.sh", "build/clean.sh", "build/makerelease.sh",
];

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

export function vendorLibarchive(sourceDir, ref = "HEAD", repoRoot = git(["rev-parse", "--show-toplevel"], process.cwd())) {
  if (!sourceDir) throw new Error("usage: node scripts/vendor-libarchive.mjs <path-to-libarchive-checkout> [ref]");
  if (!existsSync(join(sourceDir, "CMakeLists.txt"))) throw new Error(`vendor-libarchive: ${sourceDir} is not a libarchive checkout`);
  const commit = git(["rev-parse", ref], sourceDir);
  let described;
  try { described = git(["describe", "--tags", ref], sourceDir); } catch { described = commit; }
  try { execFileSync("git", ["diff", "--quiet", ref, "--"], { cwd: sourceDir, stdio: "ignore" }); }
  catch { throw new Error(`vendor-libarchive: ${sourceDir} has uncommitted changes against ${ref}`); }

  const destination = join(repoRoot, "crates/rom-weaver-containers/libarchive/vendor/libarchive");
  const staged = mkdtempSync(join(os.tmpdir(), "rom-weaver-libarchive-"));
  try {
    process.stdout.write(`vendor-libarchive: staging ${described} (${commit})\n`);
    const archive = execFileSync("git", ["archive", "--format=tar", ref], { cwd: sourceDir });
    execFileSync("tar", ["-x", "-C", staged], { input: archive, stdio: ["pipe", "inherit", "inherit"] });
    for (const path of PRUNE_PATHS) rmSync(join(staged, path), { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(dirname(destination), { recursive: true });
    renameSync(staged, destination);
    writeFileSync(join(dirname(destination), "LIBARCHIVE_VERSION"), `source: https://github.com/brandonocasey/libarchive\nref: ${described}\ncommit: ${commit}\npruned: ${PRUNE_PATHS.join(" ")}\nrefreshed-by: scripts/vendor-libarchive.mjs\n`);
    process.stdout.write(`vendor-libarchive: wrote ${destination} (${described})\n`);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { vendorLibarchive(process.argv[2], process.argv[3]); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
