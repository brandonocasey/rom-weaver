#!/usr/bin/env node

// Shared WASM staleness gate used by `npm run dev` (ensure-wasm-build.mjs) and
// `npm run preview` (ensure-preview-build.mjs). Staleness is decided by
// filesystem mtimes, which reflect uncommitted (dirty) edits as well as
// committed ones: any Rust source / Cargo manifest newer than the built
// artifact (or a missing artifact) triggers a rebuild.

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");
export const WASM_ARTIFACT = path.join(PACKAGE_DIR, "src", "wasm", "rom-weaver-app.wasm");
const WASM_BROTLI = `${WASM_ARTIFACT}.br`;

// Inputs that gate the WASM rebuild. Dirty edits bump these files' mtimes.
const RUST_ROOTS = [path.join(REPO_ROOT, "crates")];
const RUST_FILES = [path.join(REPO_ROOT, "Cargo.toml"), path.join(REPO_ROOT, "Cargo.lock")];
const RUST_EXTENSIONS = new Set([".rs", ".toml"]);

export const mtimeMs = (filePath) => {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

// Walk roots + explicit files, returning the newest mtime and the file holding it.
export const newestMtime = (roots, files, extensions) => {
  let newest = { mtimeMs: 0, file: null };
  const consider = (filePath, ms) => {
    if (ms !== null && ms > newest.mtimeMs) newest = { mtimeMs: ms, file: filePath };
  };

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extensions && !extensions.has(path.extname(entry.name))) continue;
      consider(full, mtimeMs(full));
    }
  };

  for (const root of roots) walk(root);
  for (const file of files) consider(file, mtimeMs(file));
  return newest;
};

// Decide whether the WASM artifact needs a rebuild. `requireBrotli` gates the
// prod path (a dev build lacks the .br sibling and must be promoted for
// preview); dev builds pass requireBrotli=false. Returns a human-readable
// reason string, or null when the artifact is up to date.
export const wasmRebuildReason = ({ force = false, requireBrotli = false } = {}) => {
  if (force) return "forced";
  const wasmMtime = mtimeMs(WASM_ARTIFACT);
  if (wasmMtime === null) return "artifact missing";
  if (requireBrotli && mtimeMs(WASM_BROTLI) === null)
    return "brotli sibling missing (artifact is a dev build, not prod)";
  const newestRust = newestMtime(RUST_ROOTS, RUST_FILES, RUST_EXTENSIONS);
  if (newestRust.mtimeMs > wasmMtime)
    return `Rust source newer than artifact (${path.relative(REPO_ROOT, newestRust.file)})`;
  return null;
};

// Run a build command from the repo root, streaming its output. Exits the
// process on failure so the gate blocks a broken server start.
export const run = (command, args, { label, log }) => {
  log("info", `running: ${command} ${args.join(" ")}`);
  const result = childProcess.spawnSync(command, args, { cwd: REPO_ROOT, stdio: "inherit" });
  if (result.error) {
    if (result.error.code === "ENOENT") log("error", `${label} failed: command not found: ${command}`);
    else log("error", `${label} failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    log("error", `${label} exited with status ${result.status}`);
    process.exit(result.status || 1);
  }
};
