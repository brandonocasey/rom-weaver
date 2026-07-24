#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";

const method = process.argv[2];
if (method === "install.mjs") {
  execFileSync("node", ["install.mjs"], { stdio: "inherit" });
  execFileSync(`${process.env.ROM_WEAVER_INSTALL_DIR}/rom-weaver`, ["--version"], { stdio: "inherit" });
} else if (method === "install.ps1") {
  execFileSync("pwsh", ["-NoProfile", "-File", "install.ps1"], { stdio: "inherit" });
  execFileSync(`${process.env.ROM_WEAVER_INSTALL_DIR}/rom-weaver.exe`, ["--version"], { stdio: "inherit" });
} else if (method === "npm") {
  execFileSync("npm", ["install", "--global", "rom-weaver"], { stdio: "inherit" });
  execFileSync("rom-weaver", ["--version"], { stdio: "inherit" });
} else throw new Error(`unknown install method: ${method}`);
