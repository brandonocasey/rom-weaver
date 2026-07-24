#!/usr/bin/env node

import process from "node:process";
import { assertJobs } from "./assert-jobs.mjs";

let status = 0;
for (const [selected, dependencies] of [
  [process.env.REPO_LINT_SELECTED, [`repo-lint=${process.env.REPO_LINT_RESULT}`]],
  [process.env.DOCKER_SELECTED, [`docker=${process.env.DOCKER_RESULT}`]],
  [process.env.WEBAPP_SELECTED, [`wasm=${process.env.WASM_RESULT}`, `docker-prebuilt=${process.env.DOCKER_PREBUILT_RESULT}`]],
]) {
  const result = assertJobs(process.env.CHANGES_RESULT, selected, dependencies);
  process.stdout.write(`${result.output.join("\n")}${result.output.length ? "\n" : ""}`);
  if (result.failed) status = 1;
}
process.exitCode = status;
