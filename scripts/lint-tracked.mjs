#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { vendoredExclusions } from "./vendored-pathspecs.mjs";

export function trackedFiles(root, patterns) {
  return execFileSync("git", ["ls-files", "-z", "--", ...patterns, ...vendoredExclusions()], { cwd: root })
    .toString()
    .split("\0")
    .filter(Boolean);
}

export function main(argv = process.argv.slice(2), root = fileURLToPath(new URL("..", import.meta.url))) {
  const separator = argv.indexOf("--");
  if (separator <= 0 || separator === argv.length - 1) {
    process.stderr.write("usage: node scripts/lint-tracked.mjs <pathspec>... -- <command>...\n");
    return 2;
  }
  const patterns = argv.slice(0, separator);
  const command = argv.slice(separator + 1);
  const files = trackedFiles(root, patterns);
  if (!files.length) {
    process.stderr.write(`${command[0]}: no tracked files matching ${patterns.join(" ")}\n`);
    return 0;
  }
  return spawnSync(command[0], [...command.slice(1), ...files], { cwd: root, stdio: "inherit" }).status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
