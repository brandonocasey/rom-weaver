import { assertBrowserBinarySource } from "../../lib/runtime/source-normalization.ts";
import {
  invokeRomWeaverCreatePatchCandidatesWorker,
  invokeRomWeaverCreatePatchWorker,
  invokeRomWeaverPatchApplyWorker,
  invokeRomWeaverPatchValidateWorker,
  invokeRomWeaverTrimWorker,
  runRomWeaverChecksumWorker,
  runRomWeaverProbePatchWorker,
} from "../../lib/runtime/wasm-command-runtime.ts";
import {
  createRuntimePreload,
  createSharedCompressionRuntime,
  createSharedPatchRuntime,
  createSharedTrimRuntime,
  createWorkerChecksumRuntime,
  type RomSpecificRuntimeAdapter,
} from "../../lib/runtime/workflow-runtime-core.ts";
import { configureBrowserSourcePrimitives } from "../../storage/browser/browser-source-primitives.ts";
import {
  createRuntimeOutputFromBytes,
  createRuntimeOutputFromSource,
  getRuntimeOutputStorage,
  readRuntimeOutputBlob,
} from "../../storage/vfs/runtime-output.ts";
import type {
  RuntimePublicOutputAdapter,
  RuntimeWorkerIo,
  WorkflowRuntime,
} from "../../types/workflow-runtime-adapter.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../workers/shared/worker-storage/storage-layout.ts";
import { triggerBrowserDownload } from "./browser-download.ts";
import { createBrowserRuntimeVfsIo } from "./browser-runtime-vfs.ts";
import { createBrowserArchiveRuntime } from "./workflow-runtime-archive.ts";
import { createBrowserChdRuntime } from "./workflow-runtime-chd.ts";
import { createBrowserDiscFormatsRuntime } from "./workflow-runtime-disc-formats.ts";
import { browserVfs, removeBrowserVfsOutputPaths } from "./workflow-runtime-vfs-cleanup.ts";

const getBrowserDestinationHandle = (destination: unknown) => {
  if (!destination || typeof destination === "string") return undefined;
  if (typeof destination === "object" && "createWritable" in destination) return destination as FileSystemFileHandle;
  if (typeof destination === "object" && "fileHandle" in destination)
    return (destination as { fileHandle?: FileSystemFileHandle }).fileHandle;
  return undefined;
};

const getBrowserDestinationFileName = (destination: unknown) => {
  if (!destination || typeof destination !== "object" || !("fileName" in destination)) return "";
  const fileName = (destination as { fileName?: unknown }).fileName;
  return typeof fileName === "string" ? fileName.trim() : "";
};

const createBrowserPublicOutputAdapter = (): RuntimePublicOutputAdapter => ({
  getBlob: (output) => readRuntimeOutputBlob(output),
  getSize: (output) => output.size,
  getStorage: (output) => getRuntimeOutputStorage(output),
  saveAs: async (output, destination) => {
    const fileHandle = getBrowserDestinationHandle(destination);
    const fileName = getBrowserDestinationFileName(destination);
    if (fileHandle || fileName || destination == null) {
      await output.saveAs(fileHandle || (fileName ? { fileName } : undefined));
      return;
    }
    const blob = await readRuntimeOutputBlob(output);
    triggerBrowserDownload(blob, output.fileName);
  },
});

const createBrowserChecksumRuntime = (workerIo: RuntimeWorkerIo): WorkflowRuntime["checksum"] =>
  createWorkerChecksumRuntime(workerIo, runRomWeaverChecksumWorker);

const createBrowserRomSpecificRuntime = (workerIo: RuntimeWorkerIo): RomSpecificRuntimeAdapter => ({
  ...createBrowserChdRuntime(workerIo),
  ...createBrowserDiscFormatsRuntime(workerIo),
});

const createBrowserCompressionRuntime = (workerIo: RuntimeWorkerIo): WorkflowRuntime["compression"] => {
  const archiveRuntime = createBrowserArchiveRuntime(workerIo);
  const romSpecificRuntime = createBrowserRomSpecificRuntime(workerIo);
  return createSharedCompressionRuntime(archiveRuntime, romSpecificRuntime);
};

const createBrowserPatchRuntime = (workerIo: RuntimeWorkerIo): WorkflowRuntime["patch"] => {
  const sharedPatchRuntime = createSharedPatchRuntime({
    invokeApplyPatchWorker: (input, onProgress, onLog) =>
      invokeRomWeaverPatchApplyWorker(input, onProgress, onLog, (outputPath) =>
        removeBrowserVfsOutputPaths(
          [outputPath],
          [input.romFilePath, ...input.patchFiles.map((patch) => patch.patchFilePath)],
        ),
      ),
    invokeCreatePatchCandidatesWorker: (input, onProgress, onLog) =>
      invokeRomWeaverCreatePatchCandidatesWorker(input, onProgress, onLog),
    invokeCreatePatchWorker: (input, onProgress, onLog) =>
      invokeRomWeaverCreatePatchWorker(input, onProgress, onLog, (outputPath) =>
        removeBrowserVfsOutputPaths([outputPath], [input.originalFilePath, input.modifiedFilePath]),
      ),
    invokeValidatePatchWorker: (input, onProgress, onLog) =>
      invokeRomWeaverPatchValidateWorker(input, onProgress, onLog),
    workerIo,
    workerOutputFailureMessage: "Patch worker did not return browser output",
  });
  return {
    ...sharedPatchRuntime,
    probePatch: async ({ patch, patchFileName, logLevel, onLog, onProgress, signal }) => {
      const workerSource = await workerIo.stageSource({
        fallbackFileName: patchFileName || "patch.bin",
        pathBucket: "patches",
        pathPrefix: "probe-patch",
        scope: "apply",
        source: patch,
        trace: { logLevel, onLog },
      });
      try {
        return await runRomWeaverProbePatchWorker(
          {
            logLevel,
            patchFilter: true,
            signal,
            sourcePath: workerSource.filePath,
          },
          onProgress,
          onLog,
        );
      } finally {
        await workerSource.cleanup().catch(() => undefined);
      }
    },
  };
};

const createBrowserTrimRuntime = (workerIo: RuntimeWorkerIo): WorkflowRuntime["trim"] =>
  createSharedTrimRuntime({
    invokeTrimWorker: (input, onProgress, onLog) =>
      invokeRomWeaverTrimWorker(input, onProgress, onLog, (outputPath) =>
        removeBrowserVfsOutputPaths([outputPath], [input.sourceFilePath]),
      ),
    workerIo,
    workerOutputFailureMessage: "Trim worker did not return browser output",
  });

const createBrowserRuntime = (): WorkflowRuntime => {
  configureBrowserSourcePrimitives();
  const workerIo = createBrowserRuntimeVfsIo({
    mountPoint: WORKER_OPFS_MOUNTPOINT,
    vfs: browserVfs,
  });
  return {
    binary: {
      assertSource: assertBrowserBinarySource,
    },
    checksum: createBrowserChecksumRuntime(workerIo),
    compression: createBrowserCompressionRuntime(workerIo),
    name: "browser",
    output: {
      createBytes: (bytes, fileName) =>
        createRuntimeOutputFromBytes(browserVfs, bytes, fileName, {
          pathPrefix: "runtime-bytes",
        }),
      createSource: (source, fileName) =>
        createRuntimeOutputFromSource(browserVfs, source, fileName, {
          pathPrefix: "runtime-source",
        }),
    },
    patch: createBrowserPatchRuntime(workerIo),
    preload: createRuntimePreload(),
    publicOutput: createBrowserPublicOutputAdapter(),
    sidecars: {},
    trim: createBrowserTrimRuntime(workerIo),
    useBlobOutput: true,
    vfs: browserVfs,
    workerIo,
  };
};

const browserRuntime = createBrowserRuntime();

export type { WorkflowRuntime };
export { browserRuntime, createBrowserRuntime };
