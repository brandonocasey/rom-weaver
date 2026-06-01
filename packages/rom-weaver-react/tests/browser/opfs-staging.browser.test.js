import { expect, test } from "vitest";
import { createBrowserOpfsSourceRef } from "../../src/workers/protocol/browser-opfs-source-ref.ts";
import { getActiveBrowserVirtualFiles } from "../../src/workers/protocol/browser-virtual-files.ts";
import { getManagedOpfsFileHandle } from "../../src/workers/protocol/opfs-path.ts";

test("browser OPFS source refs use selected file handles as virtual WASI inputs", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const requestFile = new File([bytes], "input.chd", {
    type: "application/octet-stream",
  });
  const sourceHandle = {
    getFile: async () => requestFile,
    kind: "file",
    name: requestFile.name,
  };

  const staged = await createBrowserOpfsSourceRef(sourceHandle, "input.chd", {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "direct-input",
  });

  try {
    expect(staged.fileName).toBe("input.chd");
    expect(staged.filePath).toBe("/work/input.chd");
    expect(staged.size).toBe(requestFile.size);
    expect(staged.storageKind).toBe("opfs");
    expect(staged.virtual).toBe(true);
    expect(getActiveBrowserVirtualFiles()).toEqual([
      expect.objectContaining({
        path: staged.filePath,
        source: requestFile,
      }),
    ]);
    expect(await getManagedOpfsFileHandle(staged.filePath, { navigatorObject: navigator })).toBeNull();
  } finally {
    await staged.cleanup();
  }

  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});

test("browser OPFS source refs use file-handle wrappers as virtual WASI inputs", async () => {
  const bytes = new Uint8Array([5, 6, 7, 8]);
  const requestFile = new File([bytes], "wrapped-input.bin", {
    type: "application/octet-stream",
  });
  const sourceHandle = {
    getFile: async () => requestFile,
    kind: "file",
    name: requestFile.name,
  };

  const staged = await createBrowserOpfsSourceRef(
    {
      fileHandle: sourceHandle,
      fileName: "wrapped-input.bin",
    },
    "fallback.bin",
    {
      bucket: "input",
      mountPoint: "/work",
      pathPrefix: "direct-input",
    },
  );

  try {
    expect(staged.fileName).toBe("wrapped-input.bin");
    expect(staged.filePath).toBe("/work/wrapped-input.bin");
    expect(staged.size).toBe(requestFile.size);
    expect(staged.storageKind).toBe("opfs");
    expect(staged.virtual).toBe(true);
    expect(getActiveBrowserVirtualFiles()).toEqual([
      expect.objectContaining({
        path: staged.filePath,
        source: requestFile,
      }),
    ]);
    expect(await getManagedOpfsFileHandle(staged.filePath, { navigatorObject: navigator })).toBeNull();
  } finally {
    await staged.cleanup();
  }

  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});

test("browser OPFS source refs use plain Blob inputs as virtual WASI inputs", async () => {
  const requestBlob = new Blob([new Uint8Array([9, 8, 7, 6])], {
    type: "application/octet-stream",
  });
  expect(requestBlob).not.toBeInstanceOf(File);

  const stagedBlob = await createBrowserOpfsSourceRef(requestBlob, "input.chd", {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "direct-input",
  });
  try {
    expect(stagedBlob.fileName).toBe("input.chd");
    expect(stagedBlob.filePath).toBe("/work/input.chd");
    expect(stagedBlob.size).toBe(requestBlob.size);
    expect(stagedBlob.storageKind).toBe("opfs");
    expect(stagedBlob.virtual).toBe(true);
    const activeVirtualFiles = getActiveBrowserVirtualFiles();
    expect(activeVirtualFiles).toHaveLength(1);
    expect(activeVirtualFiles[0]?.path).toBe(stagedBlob.filePath);
    expect(activeVirtualFiles[0]?.source).toBeInstanceOf(File);
    expect(activeVirtualFiles[0]?.source).not.toBe(requestBlob);
    expect(getActiveBrowserVirtualFiles()).toEqual([
      expect.objectContaining({
        path: stagedBlob.filePath,
        source: expect.objectContaining({
          name: "input.chd",
          size: requestBlob.size,
          type: "application/octet-stream",
        }),
      }),
    ]);
    expect(await getManagedOpfsFileHandle(stagedBlob.filePath, { navigatorObject: navigator })).toBeNull();
  } finally {
    await stagedBlob.cleanup();
  }
  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});

test("browser OPFS source refs reject raw byte-array inputs", async () => {
  await expect(
    createBrowserOpfsSourceRef(new Uint8Array([1, 2, 3]), "input.bin", {
      bucket: "input",
      mountPoint: "/work",
      pathPrefix: "direct-input",
    }),
  ).rejects.toThrow(/File, Blob, FileSystemFileHandle, or OPFS path/);

  await expect(
    createBrowserOpfsSourceRef({ fileName: "input.bin", source: new Uint8Array([1, 2, 3]) }, "input.bin", {
      bucket: "input",
      mountPoint: "/work",
      pathPrefix: "direct-input",
    }),
  ).rejects.toThrow(/File, Blob, FileSystemFileHandle, or OPFS path/);

  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});

test("browser OPFS source refs use visible suffixes for duplicate flat work paths", async () => {
  const first = await createBrowserOpfsSourceRef(new File([new Uint8Array([1])], "game.bin"), "game.bin", {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "direct-input",
  });
  const second = await createBrowserOpfsSourceRef(new File([new Uint8Array([2])], "game.bin"), "game.bin", {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "direct-input",
  });

  try {
    expect(first.filePath).toBe("/work/game.bin");
    expect(second.filePath).toBe("/work/game-2.bin");
    expect(
      getActiveBrowserVirtualFiles()
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(["/work/game-2.bin", "/work/game.bin"]);
  } finally {
    await first.cleanup();
    await second.cleanup();
  }

  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});
