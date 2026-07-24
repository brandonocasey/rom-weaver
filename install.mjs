#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const REPO = "rom-weaver/rom-weaver";

export function detectPlatform({ system = process.platform, machine = process.arch, glibc = process.report?.getReport?.().header?.glibcVersionRuntime } = {}) {
  if (system === "darwin" && machine === "arm64") return "darwin-arm64";
  if (system === "darwin" && machine === "x64") return "darwin-x64";
  if (system === "linux" && machine === "x64") return `linux-x64-${glibc ? "gnu" : "musl"}`;
  if (system === "linux" && machine === "arm64") return "linux-arm64-musl";
  if (system === "linux" && machine === "ia32") return "linux-ia32-musl";
  throw new Error(`rom-weaver does not support ${system}/${machine}`);
}

export function releaseUrl(version = "latest") {
  const normalized = version === "latest" ? "latest" : `v${version.replace(/^v/, "")}`;
  return `https://github.com/${REPO}/releases/${normalized === "latest" ? "latest/download" : `download/${normalized}`}`;
}

async function download(fetchImpl, url, destination) {
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

export function verifyChecksum(binaryPath, checksumPath, asset) {
  const [expected, name] = readFileSync(checksumPath, "utf8").trim().split(/\s+/, 2);
  if (name && name !== asset) throw new Error(`checksum names ${name}, expected ${asset}`);
  const actual = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
  if (actual !== expected) throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);
}

export function pathHint(installDir, shell = "", env = process.env) {
  if (env.PATH?.split(":").includes(installDir)) return ["Run: rom-weaver --help"];
  if (shell === "fish") return [`  fish_add_path "${installDir}"`];
  const profile = shell === "zsh" ? `${env.ZDOTDIR || env.HOME || os.homedir()}/.zshrc` : shell === "bash" ? `${env.HOME || os.homedir()}/${process.platform === "darwin" ? ".bash_profile" : ".bashrc"}` : `${env.HOME || os.homedir()}/.profile`;
  const source = shell === "zsh" || shell === "bash" ? "source" : ".";
  return [
    "Add rom-weaver to PATH:",
    `  echo 'export PATH="${installDir}:\$PATH"' >> "${profile}"`,
    `  ${source} "${profile}"`,
    "Then run: rom-weaver --help",
  ];
}

export async function install({ env = process.env, fetchImpl = globalThis.fetch, system, machine, glibc } = {}) {
  const platform = detectPlatform({ system, machine, glibc });
  const asset = `rom-weaver-${platform}`;
  const version = env.ROM_WEAVER_VERSION || "latest";
  const base = releaseUrl(version);
  const temp = mkdtempSync(join(os.tmpdir(), "rom-weaver-install-"));
  const binary = join(temp, asset);
  const checksum = `${binary}.sha256`;
  const installDir = env.ROM_WEAVER_INSTALL_DIR || join(env.HOME || os.homedir(), ".local", "bin");
  try {
    await download(fetchImpl, `${base}/${asset}`, binary);
    await download(fetchImpl, `${base}/${asset}.sha256`, checksum);
    verifyChecksum(binary, checksum, asset);
    mkdirSync(installDir, { recursive: true });
    copyFileSync(binary, join(installDir, "rom-weaver"));
    chmodSync(join(installDir, "rom-weaver"), 0o755);
    const lines = [`Installed rom-weaver to ${installDir}/rom-weaver`, ...pathHint(installDir, (env.SHELL || "").split("/").at(-1), env)];
    process.stdout.write(`${lines.join("\n")}\n`);
    return join(installDir, "rom-weaver");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await install();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
