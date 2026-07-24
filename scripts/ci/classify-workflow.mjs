#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { classifyChanges, formatChanges } from "./classify-changes.mjs";

const emptySha = "0".repeat(40);
let paths;
if (process.env.EVENT_NAME === "workflow_dispatch" || !process.env.BASE_SHA || process.env.BASE_SHA === emptySha) {
  process.stdout.write(formatChanges(classifyChanges([], true)));
  appendFileSync(process.env.GITHUB_OUTPUT, formatChanges(classifyChanges([], true)));
  process.exit(0);
}
try {
  paths = execFileSync("git", ["diff", "--name-only", process.env.BASE_SHA, process.env.HEAD_SHA], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
} catch {
  process.stdout.write(`base ${process.env.BASE_SHA} is unreachable; classifying everything\n`);
  const output = formatChanges(classifyChanges([], true));
  process.stdout.write(output);
  appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.exit(0);
}
process.stdout.write(`changed paths:\n${paths.length ? paths.join("\n") : "(none)"}\n`);
appendFileSync(process.env.GITHUB_OUTPUT, formatChanges(classifyChanges(paths)));
