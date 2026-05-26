import { expect, test, vi } from "vitest";

test("browser OPFS source refs use selected files directly as virtual WASI inputs", async () => {
  vi.stubGlobal(
    "Worker",
    class UnexpectedWorker {
      constructor() {
        throw new Error("staging worker should not be used for direct browser files");
      }
    },
  );

  try {
    const requestFile = new File([new Uint8Array([1, 2, 3, 4])], "input.chd", {
      type: "application/octet-stream",
    });
    const sourceHandle = {
      getFile: async () => requestFile,
      kind: "file",
      name: requestFile.name,
    };

    const { createBrowserOpfsSourceRef } = await import(
      "../../src/workers/protocol/browser-opfs-source-ref.ts?virtual-source-test"
    );
    const { getActiveBrowserVirtualFiles } = await import("../../src/workers/protocol/browser-virtual-files.ts");

    const staged = await createBrowserOpfsSourceRef(sourceHandle, "input.chd", {
      bucket: "input",
      mountPoint: "/work",
      pathPrefix: "direct-input",
    });

    expect(staged.fileName).toBe("input.chd");
    expect(staged.filePath).toMatch(/^\/work\/input\/direct-input-/);
    expect(staged.size).toBe(requestFile.size);
    expect(staged.virtual).toBe(true);
    const activeVirtualFiles = getActiveBrowserVirtualFiles();
    expect(activeVirtualFiles).toHaveLength(1);
    expect(activeVirtualFiles[0]?.path).toBe(staged.filePath);
    expect(activeVirtualFiles[0]?.proxy).toMatchObject({
      size: requestFile.size,
    });
    expect(activeVirtualFiles[0]?.proxy?.slots?.length).toBeGreaterThan(0);

    await staged.cleanup();
    expect(getActiveBrowserVirtualFiles()).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});
