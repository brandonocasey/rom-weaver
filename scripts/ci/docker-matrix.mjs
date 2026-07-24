#!/usr/bin/env node

import process from "node:process";
import { appendFileSync } from "node:fs";

const legs = [];
if (process.env.CLI_SELECTED === "true") legs.push({ name: "CLI", image: "rom-weaver-cli", file: "Dockerfile" });
if (process.env.WEBAPP_SELECTED === "true") legs.push({ name: "webapp", image: "rom-weaver-webapp", file: "packages/rom-weaver-webapp/Dockerfile" });
const output = `matrix=${JSON.stringify(legs)}\n`;
process.stdout.write(`${output}Docker legs: ${JSON.stringify(legs)}\n`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
