#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";

const packages = (process.env.APT_PACKAGES || "").split(/\s+/).filter(Boolean);
if (packages.length) {
  execFileSync("sudo", ["apt-get", "update"], { stdio: "inherit" });
  execFileSync("sudo", ["apt-get", "install", "--yes", ...packages], { stdio: "inherit" });
  const candidates = execFileSync("find", ["/usr/lib", "/usr/lib64", "-name", "libclang.so*"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  if (candidates[0] && process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `LIBCLANG_PATH=${candidates[0].replace(/\/[^/]*$/, "")}\n`);
}
