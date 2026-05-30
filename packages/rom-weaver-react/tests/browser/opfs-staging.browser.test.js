import { expect, test } from "vitest";
import { createBrowserOpfsSourceRef } from "../../src/workers/protocol/browser-opfs-source-ref.ts";
import { getManagedOpfsFileHandle } from "../../src/workers/protocol/opfs-path.ts";

const readOpfsBytes = async (filePath) => {
  const handle = await getManagedOpfsFileHandle(filePath, { navigatorObject: navigator });
  expect(handle).toBeTruthy();
  const file = await handle.getFile();
  return new Uint8Array(await file.arrayBuffer());
};

test("browser OPFS source refs stage selected file handles into real OPFS paths", async () => {
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
    expect(staged.filePath).toMatch(/^\/work\/input\/direct-input-/);
    expect(staged.size).toBe(requestFile.size);
    expect(staged.storageKind).toBe("opfs");
    expect(await readOpfsBytes(staged.filePath)).toEqual(bytes);
  } finally {
    await staged.cleanup();
  }

  const cleanedHandle = await getManagedOpfsFileHandle(staged.filePath, { navigatorObject: navigator });
  expect(cleanedHandle).toBeNull();
});

test("browser OPFS source refs stage Blob and byte-array inputs into real OPFS paths", async () => {
  const requestFile = new File([new Uint8Array([9, 8, 7, 6])], "input.chd", {
    type: "application/octet-stream",
  });
  const stagedBlob = await createBrowserOpfsSourceRef(requestFile, "input.chd", {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "direct-input",
  });
  try {
    expect(stagedBlob.storageKind).toBe("opfs");
    expect(await readOpfsBytes(stagedBlob.filePath)).toEqual(new Uint8Array([9, 8, 7, 6]));
  } finally {
    await stagedBlob.cleanup();
  }

  const stagedBytes = await createBrowserOpfsSourceRef(new Uint8Array([1, 2, 3]), "input.bin", {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "direct-input",
  });
  try {
    expect(stagedBytes.storageKind).toBe("opfs");
    expect(stagedBytes.size).toBe(3);
    if (stagedBytes.virtual) {
      expect(stagedBytes.filePath).toMatch(/^\/work\/input\/direct-input-/);
    } else {
      expect(await readOpfsBytes(stagedBytes.filePath)).toEqual(new Uint8Array([1, 2, 3]));
    }
  } finally {
    await stagedBytes.cleanup();
  }
});
