#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export function detectWasiSdk({ env = process.env, home = os.homedir(), candidates = ["/opt/wasi-sdk", "/opt/homebrew/opt/wasi-sdk"] } = {}) {
  if (env.WASI_SDK_PATH && existsSync(env.WASI_SDK_PATH) && statSync(env.WASI_SDK_PATH).isDirectory()) return env.WASI_SDK_PATH;
  for (const candidate of candidates) if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
  const toolchains = join(home, ".local", "toolchains");
  if (!existsSync(toolchains)) return "";
  return readdirSync(toolchains, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("wasi-sdk-"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// Keep the resolution expression small and deterministic: the last sorted
// directory is the newest version-like name.
export function resolveWasiSdk(options = {}) {
  const found = detectWasiSdk(options);
  return Array.isArray(found) ? join(options.home || os.homedir(), ".local", "toolchains", found.at(-1) || "") : found;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.stdout.write(resolveWasiSdk());
