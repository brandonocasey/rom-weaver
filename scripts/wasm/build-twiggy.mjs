#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const root = process.env.MISE_PROJECT_ROOT || process.cwd();
const outDir = resolve(process.env.ROM_WEAVER_WASM_TWIGGY_OUT_DIR || join(root, "target/wasm-twiggy"));
mkdirSync(outDir, { recursive: true });
execFileSync("cargo", ["build", "-p", "rom-weaver-cli", "--features", "wasm-app", "--bin", "rom-weaver-app", "--profile", "wasm-release", "--target", "wasm32-wasip1-threads"], { stdio: "inherit" });
cpSync(join(root, "target/wasm32-wasip1-threads/wasm-release/rom-weaver-app.wasm"), join(outDir, "rom-weaver-app.wasm"));
process.stdout.write(`twiggy-ready artifact: ${join(outDir, "rom-weaver-app.wasm")}\nrun: twiggy top -n 80 ${join(outDir, "rom-weaver-app.wasm")}\n`);
