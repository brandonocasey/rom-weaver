import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { readPlatformMatrix } from "./cli-platform-matrix.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const platforms = JSON.parse(readFileSync(join(repoRoot, ".github/cli-platforms.json"), "utf8"));

test("emits a non-empty platform list", () => assert.deepEqual(readPlatformMatrix(), platforms));
test("rejects an empty list", () => {
  const file = join(mkdtempSync(join(tmpdir(), "cli-platforms-")), "empty.json");
  writeFileSync(file, "[]\n");
  assert.throws(() => readPlatformMatrix(file), /lists no CLI platforms/);
});
test("the platform list matches published packages", () => {
  const published = readdirSync(join(repoRoot, "packages/rom-weaver-cli-platforms"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(platforms.map((platform) => platform.package).sort(), published);
});
