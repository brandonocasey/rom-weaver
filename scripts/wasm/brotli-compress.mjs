#!/usr/bin/env node
// Use Node's bundled Brotli to avoid another CI dependency. Pin LGWIN to the CLI default because
// Node's smaller default produces larger artifacts.

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const BROTLI_LGWIN = 24;

export function brotliCompressFile({ inputPath, outputPath, quality }) {
  const source = fs.readFileSync(inputPath);
  const compressed = zlib.brotliCompressSync(source, {
    params: {
      [zlib.constants.BROTLI_PARAM_LGWIN]: BROTLI_LGWIN,
      [zlib.constants.BROTLI_PARAM_QUALITY]: Number(quality),
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.byteLength,
    },
  });
  fs.writeFileSync(outputPath, compressed);
  return { compressedSize: compressed.byteLength, sourceSize: source.byteLength };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [inputPath, outputPath, quality = "11"] = process.argv.slice(2);
  if (!inputPath || !outputPath) {
    process.stderr.write("usage: brotli-compress.mjs <input> <output> [quality]\n");
    process.exit(2);
  }
  const { compressedSize, sourceSize } = brotliCompressFile({ inputPath, outputPath, quality });
  process.stdout.write(
    `brotli q${quality}: ${sourceSize} -> ${compressedSize} bytes (${((compressedSize / sourceSize) * 100).toFixed(1)}%)\n`,
  );
}
