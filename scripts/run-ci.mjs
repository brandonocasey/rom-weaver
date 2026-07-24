#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const run = (args) => execFileSync("npm", args, { stdio: "inherit" });
run(["--prefix", "packages/rom-weaver-webapp", "run", "lint"]);
run(["test"]);
run(["--prefix", "packages/rom-weaver-webapp", "run", "test:unit"]);
run(["--prefix", "packages/rom-weaver-webapp", "run", "test:browser:wasm"]);
run(["--prefix", "packages/rom-weaver-webapp", "run", "test:browser"]);
run(["--prefix", "packages/rom-weaver-webapp", "run", "test:e2e:webapp"]);
run(["--prefix", "packages/rom-weaver-webapp", "run", "build"]);
