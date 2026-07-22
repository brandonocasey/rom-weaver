#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [version, checksumDirectory, output = "bucket/rom-weaver.json"] = process.argv.slice(2);
if (!version || !checksumDirectory) {
  throw new Error("usage: generate-scoop-manifest.mjs <version> <checksum-directory> [output]");
}

const asset = "rom-weaver-win32-x64-msvc.exe";
const checksum = readFileSync(resolve(checksumDirectory, `${asset}.sha256`), "utf8").match(
  /^[a-f0-9]{64}/,
)?.[0];
if (!checksum) throw new Error(`invalid checksum for ${asset}`);

// The `#/rom-weaver.exe` fragment is a Scoop convention: it renames the
// downloaded file, which is what lets `bin` be a stable name across releases.
const manifest = {
  version,
  description: "Local-first offline toolkit for ROMs and ROM hack patches",
  homepage: "https://rom-weaver.com",
  license: "AGPL-3.0-or-later",
  architecture: {
    "64bit": {
      url: `https://github.com/brandonocasey/rom-weaver/releases/download/v${version}/${asset}#/rom-weaver.exe`,
      hash: checksum,
    },
  },
  bin: "rom-weaver.exe",
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
