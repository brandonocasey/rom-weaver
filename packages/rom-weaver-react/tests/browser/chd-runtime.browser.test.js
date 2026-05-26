import { expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { resetRomWeaverRunner, warmupRomWeaverRunner } from "../../src/workers/rom-weaver/rom-weaver-runner.ts";

const loadFixtureFile = async (filePath, type = "application/octet-stream") => {
  const response = await fetch(`/${filePath}`);
  if (!response.ok) throw new Error(`Failed to load fixture ${filePath}`);
  const bytes = await response.arrayBuffer();
  return new File([bytes], filePath.split("/").pop() || "input.chd", { type });
};

test("rom-weaver runtime extracts a CHD staged through browser OPFS", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();

  const source = await loadFixtureFile("tests/fixtures/browser-generated/game-cd.chd");
  const progressEvents = [];
  const result = await browserRuntime.compression.extract?.({
    entries: [],
    format: "chd",
    options: {
      onProgress: (progress) => progressEvents.push(progress),
    },
    outputName: "game.bin",
    source,
  });

  expect(result?.output.fileName).toMatch(/\.(bin|iso)$/i);
  expect(result?.output.size).toBeGreaterThan(0);
  expect(progressEvents.length).toBeGreaterThan(0);
});
