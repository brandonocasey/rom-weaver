import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("generates a manifest from the release checksum", () => {
  const directory = mkdtempSync(join(tmpdir(), "rom-weaver-scoop-"));
  try {
    const checksums = join(directory, "checksums");
    mkdirSync(checksums);
    const asset = "rom-weaver-win32-x64-msvc.exe";
    writeFileSync(join(checksums, `${asset}.sha256`), `${"a".repeat(64)}  ${asset}\n`);

    const output = join(directory, "bucket", "rom-weaver.json");
    execFileSync(process.execPath, [
      "scripts/generate-scoop-manifest.mjs",
      "1.2.3",
      checksums,
      output,
    ]);
    const manifest = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(manifest.version, "1.2.3");
    assert.equal(manifest.bin, "rom-weaver.exe");
    assert.equal(manifest.architecture["64bit"].hash, "a".repeat(64));
    // The `#/rom-weaver.exe` fragment is what makes `bin` a stable name.
    assert.equal(
      manifest.architecture["64bit"].url,
      `https://github.com/brandonocasey/rom-weaver/releases/download/v1.2.3/${asset}#/rom-weaver.exe`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
