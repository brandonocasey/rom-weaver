import { expect, test } from "vitest";
import { CreateWorkflow } from "../../src/platform/browser/browser-api.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";

const makeOriginalBytes = () => new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

const makeModifiedBytes = () => {
  const bytes = makeOriginalBytes();
  bytes[3] = 0xaa;
  bytes[9] = 0xbb;
  bytes[15] = 0xcc;
  return bytes;
};

const createZipFile = async (entryName, bytes, outputName) => {
  const result = await browserRuntime.compression.create?.({
    entries: [
      {
        data: bytes,
        fileName: entryName,
        filename: entryName,
      },
    ],
    format: "zip",
    options: {
      outputName,
      workerThreads: 1,
    },
  });
  const output = result?.output;
  if (!output) throw new Error("Failed to create archive fixture");
  try {
    const blob = await browserRuntime.publicOutput.getBlob(output);
    return new File([blob], outputName, { type: "application/zip" });
  } finally {
    await output.cleanup?.().catch(() => undefined);
  }
};

const createTraceWorkflow = (output) => {
  const logs = [];
  const workflow = new CreateWorkflow({
    settings: {
      format: "ips",
      logging: {
        level: "trace",
        sink: (record) => logs.push(record || {}),
      },
      output,
      workers: {
        threads: 1,
      },
    },
  });
  return { logs, workflow };
};

test("create workflow extracts archived original and modified inputs before patch create", async () => {
  const { logs, workflow } = createTraceWorkflow({
    compression: "none",
    outputName: "change.ips",
  });
  try {
    const originalArchive = await createZipFile("original.bin", makeOriginalBytes(), "original.zip");
    const modifiedArchive = await createZipFile("modified.bin", makeModifiedBytes(), "modified.zip");

    await workflow.setOriginal(originalArchive);
    await workflow.setModified(modifiedArchive);

    expect(workflow.getOriginal()?.fileName).toBe("original.bin");
    expect(workflow.getOriginal()?.wasDecompressed).toBe(true);
    expect(workflow.getModified()?.fileName).toBe("modified.bin");
    expect(workflow.getModified()?.wasDecompressed).toBe(true);

    const result = await workflow.run();
    expect(result.type).toBe("ips");
    expect(result.output.fileName).toBe("change.ips");
    expect(result.sizeSummary?.rawSize).toBe(result.output.size);
    await result.output.dispose();

    const createDispatch = logs.find((entry) => String(entry?.message || "") === "runJson patch-create dispatch");
    expect(createDispatch?.details?.originalFilePath).toMatch(/original\.bin$/i);
    expect(createDispatch?.details?.originalFilePath).not.toMatch(/\.zip$/i);
    expect(createDispatch?.details?.modifiedFilePath).toMatch(/modified\.bin$/i);
    expect(createDispatch?.details?.modifiedFilePath).not.toMatch(/\.zip$/i);
  } finally {
    await workflow.dispose();
  }
});

test("create workflow supports raw and zip output compression", async () => {
  const original = new File([makeOriginalBytes()], "original.bin", { type: "application/octet-stream" });
  const modified = new File([makeModifiedBytes()], "modified.bin", { type: "application/octet-stream" });
  const rawWorkflow = createTraceWorkflow({
    compression: "none",
    outputName: "change.ips",
  }).workflow;
  try {
    await rawWorkflow.setOriginal(original);
    await rawWorkflow.setModified(modified);
    const rawResult = await rawWorkflow.run();
    expect(rawResult.output.fileName).toBe("change.ips");
    expect(rawResult.sizeSummary?.rawSize).toBe(rawResult.output.size);
    await rawResult.output.dispose();
  } finally {
    await rawWorkflow.dispose();
  }

  const zipWorkflow = createTraceWorkflow({
    compression: "zip",
    outputName: "change.zip",
  }).workflow;
  try {
    await zipWorkflow.setOriginal(original);
    await zipWorkflow.setModified(modified);
    const zipResult = await zipWorkflow.run();
    expect(zipResult.output.fileName).toBe("change.zip");
    expect(zipResult.sizeSummary?.rawSize).toBeGreaterThan(0);
    expect(zipResult.output.size).toBeGreaterThan(zipResult.sizeSummary?.rawSize || 0);
    const blob = await zipResult.output.getBlob?.();
    const header = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    expect([...header]).toEqual([0x50, 0x4b]);
    await zipResult.output.dispose();
  } finally {
    await zipWorkflow.dispose();
  }
});
