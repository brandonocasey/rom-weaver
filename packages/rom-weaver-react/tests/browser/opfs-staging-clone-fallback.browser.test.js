import { expect, test, vi } from "vitest";

test("browser OPFS source refs use non-CHD selected files directly as virtual WASI inputs", async () => {
  vi.stubGlobal(
    "Worker",
    class UnexpectedWorker {
      constructor() {
        throw new Error("staging worker should not be used for direct browser files");
      }
    },
  );

  try {
    const requestFile = new File([new Uint8Array([1, 2, 3, 4])], "input.bin", {
      type: "application/octet-stream",
    });
    const sourceHandle = {
      getFile: async () => requestFile,
      kind: "file",
      name: requestFile.name,
    };

    const { createBrowserOpfsSourceRef } = await import("../../src/workers/protocol/browser-opfs-source-ref.ts");
    const { getActiveBrowserVirtualFiles } = await import("../../src/workers/protocol/browser-virtual-files.ts");

    const staged = await createBrowserOpfsSourceRef(sourceHandle, "input.bin", {
      bucket: "input",
      mountPoint: "/work",
      pathPrefix: "direct-input",
    });

    expect(staged.fileName).toBe("input.bin");
    expect(staged.filePath).toBe("/work/input.bin");
    expect(staged.size).toBe(requestFile.size);
    expect(staged.virtual).toBe(true);
    const activeVirtualFiles = getActiveBrowserVirtualFiles();
    expect(activeVirtualFiles).toHaveLength(1);
    expect(activeVirtualFiles[0]?.path).toBe(staged.filePath);
    expect(activeVirtualFiles[0]?.source).toBeInstanceOf(File);
    expect(activeVirtualFiles[0]?.source?.size).toBe(requestFile.size);
    expect(activeVirtualFiles[0]?.proxy).toBeUndefined();

    await staged.cleanup();
    expect(getActiveBrowserVirtualFiles()).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("browser OPFS source refs stage small CHD blobs into OPFS", async () => {
  const requestFile = new File([new Uint8Array([9, 8, 7, 6])], "input.chd", {
    type: "application/octet-stream",
  });
  const { createBrowserOpfsSourceRef } = await import("../../src/workers/protocol/browser-opfs-source-ref.ts");
  const { getActiveBrowserVirtualFiles } = await import("../../src/workers/protocol/browser-virtual-files.ts");
  const { getManagedOpfsFileHandle } = await import("../../src/workers/protocol/opfs-path.ts");

  const stagedBlob = await createBrowserOpfsSourceRef(requestFile, "input.chd", {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "direct-input",
  });
  // Small inputs are copied into OPFS up front so wasm threads read via sync access handles.
  expect(stagedBlob.virtual).toBeFalsy();
  expect(stagedBlob.storageKind).toBe("opfs");
  expect(stagedBlob.filePath).toBe("/work/input.chd");
  expect(stagedBlob.size).toBe(requestFile.size);
  expect(getActiveBrowserVirtualFiles()).toEqual([]);
  expect(await getManagedOpfsFileHandle(stagedBlob.filePath, { navigatorObject: navigator })).not.toBeNull();
  await stagedBlob.cleanup();
  expect(await getManagedOpfsFileHandle("/work/input.chd", { navigatorObject: navigator })).toBeNull();
  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});

test("browser OPFS RVZ staging preserves the original filename leaf", async () => {
  const sourceName = "Luigi's Mansion (USA).rvz";
  const sourceFile = new File([new Uint8Array([1, 2, 3, 4])], sourceName, {
    type: "application/octet-stream",
  });
  const { createBrowserOpfsSourceRef } = await import("../../src/workers/protocol/browser-opfs-source-ref.ts");
  const { getManagedOpfsFileHandle } = await import("../../src/workers/protocol/opfs-path.ts");
  const staged = await createBrowserOpfsSourceRef(sourceFile, sourceName, {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "rvz-input",
  });
  try {
    expect(staged.fileName).toBe(sourceName);
    expect(staged.filePath).toBe("/work/Luigi's Mansion (USA).rvz");
    expect(await getManagedOpfsFileHandle(staged.filePath, { navigatorObject: navigator })).not.toBeNull();
  } finally {
    await staged.cleanup();
  }
  expect(await getManagedOpfsFileHandle("/work/Luigi's Mansion (USA).rvz", { navigatorObject: navigator })).toBeNull();
});

test("browser OPFS source refs stage small 7z files into OPFS", async () => {
  const fileName = "input.7z";
  const sourceFile = new File([new Uint8Array([0x37, 0x7a, 0xbc, 0xaf])], fileName, {
    type: "application/x-7z-compressed",
  });
  const { createBrowserOpfsSourceRef } = await import("../../src/workers/protocol/browser-opfs-source-ref.ts");
  const { getActiveBrowserVirtualFiles } = await import("../../src/workers/protocol/browser-virtual-files.ts");
  const { getManagedOpfsFileHandle } = await import("../../src/workers/protocol/opfs-path.ts");

  const staged = await createBrowserOpfsSourceRef(sourceFile, fileName, {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "archive-input",
  });
  try {
    expect(staged.virtual).toBeFalsy();
    expect(staged.storageKind).toBe("opfs");
    expect(staged.filePath).toBe("/work/input.7z");
    expect(staged.size).toBe(sourceFile.size);
    expect(getActiveBrowserVirtualFiles()).toEqual([]);
    expect(await getManagedOpfsFileHandle(staged.filePath, { navigatorObject: navigator })).not.toBeNull();
  } finally {
    await staged.cleanup();
  }
  expect(await getManagedOpfsFileHandle("/work/input.7z", { navigatorObject: navigator })).toBeNull();
  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});
