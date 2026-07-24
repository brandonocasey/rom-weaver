#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const output = mkdtempSync(join(os.tmpdir(), "rom-weaver-license-check-"));
try {
  execFileSync("node", [fileURLToPath(new URL("./gen-third-party-licenses.mjs", import.meta.url)), output], { stdio: "inherit" });
  if (!/^Third-party components$/m.test(readFileSync(join(output, "NOTICE"), "utf8"))) throw new Error("NOTICE is missing the third-party heading");
  if (existsSync(join(output, "THIRD_PARTY_LICENSES.md")) || !existsSync(join(output, "third_party/licenses"))) throw new Error("license bundle shape is invalid");
} finally {
  rmSync(output, { recursive: true, force: true });
}
