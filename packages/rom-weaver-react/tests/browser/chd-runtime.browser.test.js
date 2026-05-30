import { beforeEach, expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { resetRomWeaverRunner, warmupRomWeaverRunner } from "../../src/workers/rom-weaver/rom-weaver-runner.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../src/workers/shared/worker-storage/storage-layout.ts";

const loadFixtureBytes = async (filePath) => {
  const response = await fetch(`/${filePath}`);
  if (!response.ok) throw new Error(`Failed to load fixture ${filePath}`);
  return new Uint8Array(await response.arrayBuffer());
};

const clearOpfsRuntimeBuckets = async () => {
  if (!navigator.storage?.getDirectory) return;
  const root = await navigator.storage.getDirectory();
  if (typeof root.keys === "function") {
    for await (const name of root.keys()) {
      await root.removeEntry(name, { recursive: true }).catch(() => undefined);
    }
    return;
  }
  if (typeof root.entries === "function") {
    for await (const [name] of root.entries()) {
      await root.removeEntry(name, { recursive: true }).catch(() => undefined);
    }
    return;
  }
  await browserRuntime.vfs.remove(`${WORKER_OPFS_MOUNTPOINT}/input`).catch(() => undefined);
  await browserRuntime.vfs.remove(`${WORKER_OPFS_MOUNTPOINT}/output`).catch(() => undefined);
  await browserRuntime.vfs.remove(`${WORKER_OPFS_MOUNTPOINT}/temp`).catch(() => undefined);
};

beforeEach(async () => {
  await clearOpfsRuntimeBuckets();
});

test("rom-weaver runtime extracts a CHD staged through browser OPFS", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const source = `${WORKER_OPFS_MOUNTPOINT}/input/chd-runtime-${runId}.chd`;
  const bytes = await loadFixtureBytes("tests/fixtures/browser-generated/game-cd.chd");
  await browserRuntime.vfs.truncate(source, 0);
  await browserRuntime.vfs.write(source, bytes, { fileOffset: 0 });
  const progressEvents = [];
  let output = null;
  try {
    const result = await browserRuntime.compression.extract?.({
      entries: ["game.bin", "game.cue"],
      format: "chd",
      options: {
        onProgress: (progress) => progressEvents.push(progress),
      },
      outputName: "game.bin",
      source,
    });

    output = result?.output || null;
    expect(output?.fileName).toMatch(/\.(bin|iso)$/i);
    expect(output?.size).toBeGreaterThan(0);
    expect(progressEvents.length).toBeGreaterThan(0);
  } finally {
    await output?.cleanup?.().catch(() => undefined);
    await browserRuntime.vfs.remove(source).catch(() => undefined);
  }
});

test("rom-weaver runtime keeps original CHD basename for extracted output", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sourcePath = `${WORKER_OPFS_MOUNTPOINT}/input/chd-input-${runId}-Crash_Bandicoot_USA_.chd`;
  const sourceFileName = "Crash Bandicoot (USA).chd";
  const bytes = await loadFixtureBytes("tests/fixtures/browser-generated/game-cd.chd");
  await browserRuntime.vfs.truncate(sourcePath, 0);
  await browserRuntime.vfs.write(sourcePath, bytes, { fileOffset: 0 });

  let output = null;
  try {
    const result = await browserRuntime.compression.extract?.({
      entries: ["Crash Bandicoot (USA).bin", "Crash Bandicoot (USA).cue"],
      format: "chd",
      source: {
        fileName: sourceFileName,
        filePath: sourcePath,
      },
    });

    output = result?.output || null;
    expect(output?.fileName).toMatch(/^Crash Bandicoot \(USA\)\.(bin|iso)$/i);
    expect(output?.fileName).not.toMatch(/^chd-input-/i);
    expect(output?.size).toBeGreaterThan(0);
  } finally {
    await output?.cleanup?.().catch(() => undefined);
    await browserRuntime.vfs.remove(sourcePath).catch(() => undefined);
  }
});

test("rom-weaver runtime creates a CD CHD from a browser-generated CUE", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sourcePath = `${WORKER_OPFS_MOUNTPOINT}/input/chd-create-${runId}/disc.bin`;
  const sectorBytes = 2352;
  const sectorCount = 32;
  const sourceBytes = new Uint8Array(sectorBytes * sectorCount);
  for (let index = 0; index < sourceBytes.length; index += 1) {
    sourceBytes[index] = index & 0xff;
  }
  await browserRuntime.vfs.truncate(sourcePath, 0);
  await browserRuntime.vfs.write(sourcePath, sourceBytes, { fileOffset: 0 });

  let output = null;
  try {
    const result = await browserRuntime.compression.create?.({
      chdSourceMode: "cd",
      format: "chd",
      mode: "cd",
      options: {
        workerThreads: 2,
      },
      outputName: "created-cd.chd",
      source: {
        fileName: "disc.bin",
        filePath: sourcePath,
      },
    });

    output = result?.output || null;
    expect(output?.fileName).toBe("created-cd.chd");
    expect(output?.size).toBeGreaterThan(0);
    const blob = await browserRuntime.publicOutput.getBlob(output);
    const header = new TextDecoder().decode(await blob.slice(0, 8).arrayBuffer());
    expect(header).toBe("MComprHD");
  } finally {
    await output?.cleanup?.().catch(() => undefined);
    await browserRuntime.vfs.remove(`${WORKER_OPFS_MOUNTPOINT}/input/chd-create-${runId}`).catch(() => undefined);
  }
});
