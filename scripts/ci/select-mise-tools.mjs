#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import process from "node:process";
import { disabledTools } from "./mise-disable-tools.mjs";

const wanted = (process.env.WANTED || "").split(/\s+/).filter(Boolean);
const disable = disabledTools(".mise.toml", wanted);
appendFileSync(process.env.GITHUB_ENV, `MISE_DISABLE_TOOLS=${disable}\n`);
process.stdout.write(`installing: ${wanted.join(" ")}\ndisabled:   ${disable || "(none)"}\n`);
