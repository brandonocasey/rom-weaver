#!/usr/bin/env node

// Prebuild gate for `npm run dev`. Builds the dev WASM module when it is
// missing or when any Rust source / Cargo manifest is newer than the built
// artifact, then hands off to the dev server. Unlike the preview gate this
// runs the fast dev build (no wasm-opt/brotli) and does not require the .br
// sibling.
//
// Override with ROM_WEAVER_DEV_FORCE_WASM=1 to force a rebuild, or
// ROM_WEAVER_DEV_SKIP_WASM=1 to skip the gate entirely (e.g. worktrees with a
// copied artifact and no local WASI toolchain).

import process from "node:process";
import { run, wasmRebuildReason } from "./wasm-build-gate.mjs";

const log = (level, message) => console.log(`[ensure-wasm-build] ${level}: ${message}`);

if (String(process.env.ROM_WEAVER_DEV_SKIP_WASM || "") === "1") {
  log("warn", "ROM_WEAVER_DEV_SKIP_WASM=1 set; skipping WASM build gate");
} else {
  const force = String(process.env.ROM_WEAVER_DEV_FORCE_WASM || "") === "1";
  const reason = wasmRebuildReason({ force, requireBrotli: false });
  if (reason) {
    log("info", `WASM rebuild needed: ${reason}`);
    run("mise", ["run", "build-wasm"], { label: "build-wasm", log });
  } else {
    log("debug", "WASM artifact up to date; skipping dev build");
  }
}
