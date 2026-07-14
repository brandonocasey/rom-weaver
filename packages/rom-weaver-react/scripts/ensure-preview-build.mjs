#!/usr/bin/env node

// Prebuild gate for `npm run preview`. Keeps the previewed bundle honest by
// rebuilding the prod WASM module and the vite bundle when their inputs have
// changed, then hands off to the preview server.
//
// Staleness is decided by filesystem mtimes, which reflect uncommitted (dirty)
// edits as well as committed ones:
//   - WASM rebuild  : any Rust source / Cargo manifest newer than the built
//                     artifact, or a missing artifact / missing brotli sibling
//                     (the brotli file marks a *prod* build; a dev build lacks
//                     it and must be promoted to prod for preview).
//   - vite rebuild  : missing dist, or any web source / config / WASM artifact
//                     newer than the built dist/index.html.
//
// Override with ROM_WEAVER_PREVIEW_FORCE=wasm|vite|all to force a rebuild, or
// ROM_WEAVER_PREVIEW_SKIP_BUILD=1 to skip the gate entirely.

import path from "node:path";
import process from "node:process";
import {
  mtimeMs,
  newestMtime,
  PACKAGE_DIR,
  REPO_ROOT,
  run,
  WASM_ARTIFACT,
  wasmRebuildReason,
} from "./wasm-build-gate.mjs";

const DIST_INDEX = path.join(PACKAGE_DIR, "dist", "index.html");

// Inputs that gate the vite rebuild (in addition to the WASM artifact itself).
const WEB_ROOTS = [path.join(PACKAGE_DIR, "src")];
const WEB_FILES = [
  path.join(PACKAGE_DIR, "index.html"),
  path.join(PACKAGE_DIR, "vite.config.mjs"),
  path.join(PACKAGE_DIR, "package.json"),
];

const log = (level, message) => console.log(`[ensure-preview-build] ${level}: ${message}`);

const force = String(process.env.ROM_WEAVER_PREVIEW_FORCE || "").toLowerCase();
const forceWasm = force === "wasm" || force === "all";
const forceVite = force === "vite" || force === "all";

if (String(process.env.ROM_WEAVER_PREVIEW_SKIP_BUILD || "") === "1") {
  log("warn", "ROM_WEAVER_PREVIEW_SKIP_BUILD=1 set; skipping build gate");
} else {
  // --- WASM gate ----------------------------------------------------------
  const wasmReason = wasmRebuildReason({ force: forceWasm, requireBrotli: true });
  if (wasmReason) {
    log("info", `WASM rebuild needed: ${wasmReason}`);
    run("mise", ["run", "build-wasm-prod"], { label: "build-wasm-prod", log });
  } else {
    log("debug", "WASM artifact up to date; skipping prod build");
  }

  // --- vite gate ----------------------------------------------------------
  const distMtime = mtimeMs(DIST_INDEX);
  const newestWeb = newestMtime(WEB_ROOTS, WEB_FILES, null);
  const newestWasmMtime = mtimeMs(WASM_ARTIFACT) || 0;

  let viteReason = null;
  if (forceVite) viteReason = "forced via ROM_WEAVER_PREVIEW_FORCE";
  else if (distMtime === null) viteReason = "dist/index.html missing";
  else if (newestWasmMtime > distMtime) viteReason = "WASM artifact newer than dist";
  else if (newestWeb.mtimeMs > distMtime)
    viteReason = `web source newer than dist (${path.relative(PACKAGE_DIR, newestWeb.file)})`;

  if (viteReason) {
    log("info", `vite rebuild needed: ${viteReason}`);
    run("npm", ["--prefix", "packages/rom-weaver-react", "run", "build"], { label: "vite build", log });
  } else {
    log("debug", "dist up to date; skipping vite build");
  }

  log("info", "build gate complete");
}
