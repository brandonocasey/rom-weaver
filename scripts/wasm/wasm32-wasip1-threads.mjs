#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export function normalizeCompilerArgs(args) {
  const normalized = [];
  let hasTarget = false;
  let expectTargetValue = false;
  for (let arg of args) {
    if (expectTargetValue) {
      if (arg === "wasm32-wasi" || arg === "wasm32-wasi-threads") arg = "wasm32-wasip1-threads";
      normalized.push(arg);
      hasTarget = true;
      expectTargetValue = false;
      continue;
    }
    if (arg === "--target" || arg === "-target") {
      normalized.push(arg);
      expectTargetValue = true;
      continue;
    }
    if (/^(?:--target|-target)=(?:wasm32-wasi|wasm32-wasi-threads)$/.test(arg)) {
      normalized.push(`${arg.slice(0, arg.indexOf("="))}=wasm32-wasip1-threads`);
      hasTarget = true;
      continue;
    }
    if (/^(?:--target|-target)=/.test(arg)) hasTarget = true;
    normalized.push(arg);
  }
  return { base: hasTarget ? [] : ["--target=wasm32-wasip1-threads"], normalized };
}

export function compilerArguments(args, { sysroot = "", threadingHeader = "", forceThreadHeader = false } = {}) {
  const { base, normalized } = normalizeCompilerArgs(args);
  const extra = forceThreadHeader && args.some((arg) => /liblzma-sys|(?:^|\/)xz\/src\//.test(arg))
    ? ["-D_WASI_EMULATED_SIGNAL", "-include", threadingHeader]
    : [];
  if (sysroot) base.unshift(`--sysroot=${sysroot}`);
  return [...base, ...extra, ...normalized];
}

export function main(args = process.argv.slice(2), { cxx = false, env = process.env } = {}) {
  const compiler = cxx ? env.WASI_CLANGXX || "clang++" : env.WASI_CLANG || "clang";
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const argv = compilerArguments(args, {
    sysroot: env.WASI_SYSROOT,
    threadingHeader: join(scriptDir, "wasi-liblzma-threading.h"),
    forceThreadHeader: !cxx,
  });
  return spawnSync(compiler, argv, { stdio: "inherit", env }).status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cxx = process.env.ROM_WEAVER_WASM_CXX === "1" || process.argv[1].endsWith("-cxx.mjs");
  process.exitCode = main(undefined, { cxx });
}
