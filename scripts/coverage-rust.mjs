#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const output = resolve(`${process.env.MISE_PROJECT_ROOT || process.cwd()}/dist/coverage/rust`);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const run = (args) => execFileSync("cargo", ["llvm-cov", ...args], { stdio: "inherit" });
run(["clean", "--workspace"]);
run(["--workspace", "--no-report"]);
run(["report", "--html", "--output-dir", output]);
run(["report", "--lcov", "--output-path", `${output}/lcov.info`]);
