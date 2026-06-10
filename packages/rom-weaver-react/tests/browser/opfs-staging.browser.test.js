import { expect, test } from "vitest";
import { createBrowserOpfsSourceRef } from "../../src/workers/protocol/browser-opfs-source-ref.ts";
import { getActiveBrowserVirtualFiles } from "../../src/workers/protocol/browser-virtual-files.ts";
import { getManagedOpfsFileHandle } from "../../src/workers/protocol/opfs-path.ts";

// Small inputs (<= the stage-to-OPFS threshold) are copied into OPFS up front so each wasm thread
// reads through its own sync access handle; only oversized inputs stay on the virtual-Blob path.

test("browser OPFS source refs stage selected file handles into OPFS work paths", async () => {
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
    expect(staged.virtual).toBeFalsy();
    expect(getActiveBrowserVirtualFiles()).toEqual([]);
    expect(await getManagedOpfsFileHandle(staged.filePath, { navigatorObject: navigator })).not.toBeNull();
  } finally {
    await staged.cleanup();
  }

  expect(await getManagedOpfsFileHandle("/work/input.chd", { navigatorObject: navigator })).toBeNull();
  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});

test("browser OPFS source refs stage file-handle wrappers into OPFS work paths", async () => {
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
    expect(staged.virtual).toBeFalsy();
    expect(getActiveBrowserVirtualFiles()).toEqual([]);
    expect(await getManagedOpfsFileHandle(staged.filePath, { navigatorObject: navigator })).not.toBeNull();
  } finally {
    await staged.cleanup();
  }

  expect(await getManagedOpfsFileHandle("/work/wrapped-input.bin", { navigatorObject: navigator })).toBeNull();
  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});

test("browser OPFS source refs stage plain Blob inputs into OPFS work paths", async () => {
  const requestBlob = new Blob([new Uint8Array([9, 8, 7, 6])], {
    type: "application/octet-stream",
  });
  expect(requestBlob).not.toBeInstanceOf(File);

  const stagedBlob = await createBrowserOpfsSourceRef(requestBlob, "blob-input.chd", {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "direct-input",
  });
  try {
    expect(stagedBlob.fileName).toBe("blob-input.chd");
    expect(stagedBlob.filePath).toBe("/work/blob-input.chd");
    expect(stagedBlob.size).toBe(requestBlob.size);
    expect(stagedBlob.storageKind).toBe("opfs");
    expect(stagedBlob.virtual).toBeFalsy();
    expect(getActiveBrowserVirtualFiles()).toEqual([]);
    const handle = await getManagedOpfsFileHandle(stagedBlob.filePath, { navigatorObject: navigator });
    expect(handle).not.toBeNull();
    const stagedFile = await handle.getFile();
    expect(stagedFile.size).toBe(requestBlob.size);
  } finally {
    await stagedBlob.cleanup();
  }
  expect(await getManagedOpfsFileHandle("/work/blob-input.chd", { navigatorObject: navigator })).toBeNull();
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
    expect(await getManagedOpfsFileHandle(first.filePath, { navigatorObject: navigator })).not.toBeNull();
    expect(await getManagedOpfsFileHandle(second.filePath, { navigatorObject: navigator })).not.toBeNull();
  } finally {
    await first.cleanup();
    await second.cleanup();
  }

  expect(await getManagedOpfsFileHandle("/work/game.bin", { navigatorObject: navigator })).toBeNull();
  expect(await getManagedOpfsFileHandle("/work/game-2.bin", { navigatorObject: navigator })).toBeNull();
  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});
