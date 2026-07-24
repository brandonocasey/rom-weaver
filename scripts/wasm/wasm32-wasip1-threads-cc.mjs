#!/usr/bin/env node
import { main } from "./wasm32-wasip1-threads.mjs";
process.exitCode = main();
