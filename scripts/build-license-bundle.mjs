#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const output = resolve(process.env.ROM_WEAVER_LICENSE_OUTPUT_DIR || `${process.env.MISE_PROJECT_ROOT || process.cwd()}/target/license-bundle`);
rmSync(output, { recursive: true, force: true });
execFileSync("node", [fileURLToPath(new URL("./gen-third-party-licenses.mjs", import.meta.url)), output], { stdio: "inherit" });
