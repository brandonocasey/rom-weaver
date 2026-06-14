import {
  createPatchFile,
  getDefaultCreatePatchOutputFileName,
  getPatchFileBytes,
} from "../../lib/input/binary-service.ts";
import { getProgressEventPercent } from "../../presentation/workflow-presentation.ts";
import { getNamedSource, getNamedSourceFileName } from "../../storage/shared/binary/source-file-utils.ts";
import type { SourceRef } from "../../types/source.ts";
import type { CreateWorkflowDeps, PatchFileInstance } from "../../types/workflow-internal.ts";
import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { CreatePatchInput, CreatePatchResult, JsonValue } from "../../types/workflow-runtime-types.ts";
import { patchWorkflowDeps } from "../apply/workflow.ts";
import {
  createSingleFileArchiveOutput,
  getArchiveOutputCompression,
  hasArchiveFileName,
} from "../output/archive-output-service.ts";
import { requireOutputName } from "../output/output-name-validation.ts";
import { createPatchFileFromPublicOutput } from "../runtime/public-output-bin-file.ts";
import {
  getWorkflowSourceFileName,
  roundElapsedMs,
  shouldPrepareWorkflowSource,
} from "../workflow/source-preparation.ts";
import { createWorkflowTracer } from "../workflow/workflow-tracing.ts";
import { embedSourceCrc32InPatchName } from "./patch-checksum-name.ts";

type JsonObject = { [key: string]: JsonValue };
type CreateSourceInput = PatchFileInstance | SourceRef;

const getCreateFormat = (options: CreatePatchInput["options"]) => options?.format || "bps";
const getCreateLogLevel = (options: CreatePatchInput["options"]) => options?.logging?.level;
const getCreateWorkerThreads = (options: CreatePatchInput["options"]) => options?.workers?.threads;
const getCreateMetadata = (options: CreatePatchInput["options"]): JsonObject =>
  (options?.patch?.metadata || {}) as JsonObject;
const getCreateCompression = (options: CreatePatchInput["options"]) => options?.output?.compression;
const getCreateOutputName = (options: CreatePatchInput["options"]) => options?.output?.outputName;
const { traceWorkflowStage, traceWorkflowStageBlock } = createWorkflowTracer("create");

const runCreateWorkflow = async (
  input: CreatePatchInput,
  runtime: WorkflowRuntime,
  deps: CreateWorkflowDeps,
): Promise<CreatePatchResult> => {
  const options = input.options || {};
  requireOutputName(options.output?.outputName);
  const format = getCreateFormat(options);
  const optionsForRole = (role: "original" | "modified") => ({
    ...options,
    onCandidatesFound: options.onCandidatesFound
      ? (event: Parameters<NonNullable<typeof options.onCandidatesFound>>[0]) =>
          options.onCandidatesFound?.({ ...event, role } as typeof event)
      : undefined,
  });
  const prepareCreateSource = (
    source: SourceRef,
    role: "original" | "modified",
    selectedArchiveEntry?: string,
  ): Promise<CreateSourceInput> => {
    if (!shouldPrepareWorkflowSource(source, options, selectedArchiveEntry, deps)) {
      traceWorkflowStage(options, "stage.skip", "source.prepare", role, {
        reason: "direct source",
        sourceName: getWorkflowSourceFileName(source, `${role}.bin`, deps),
      });
      return Promise.resolve(source);
    }
    return traceWorkflowStageBlock(
      options,
      "source.prepare",
      role,
      () =>
        deps.prepareInputAssets(source, optionsForRole(role), 0, runtime, selectedArchiveEntry).then((assets) => {
          const selected = assets.find((asset) => asset.patchable) || assets[0];
          if (!selected) throw new Error(`${role} source did not contain a patchable file`);
          return selected.file;
        }),
      () => ({
        selectedArchiveEntry,
        sourceName: getWorkflowSourceFileName(source, `${role}.bin`, deps),
      }),
    );
  };

  const createCompressedPatchOutput = async (patchFile: PatchFileInstance) => {
    const compression = getArchiveOutputCompression(getCreateCompression(options), "create patch");
    if (compression === "none") {
      traceWorkflowStage(options, "stage.skip", "compress", "output", { reason: "output compression disabled" });
      return deps.toPublicOutput(patchFile, runtime);
    }
    return createSingleFileArchiveOutput({
      compression,
      deps,
      entryFile: patchFile,
      entryNameDetailKey: "patchEntryName",
      fallbackEntryName: patchFile.fileName || `patch.${format}`,
      options,
      runtime,
      trace: (operation, details) => traceWorkflowStageBlock(options, "compress", "output", operation, details),
      unsupportedRuntimeMessage: "Patch output compression requires the rom-weaver wasm runtime",
    });
  };

  const createPatchCapability = runtime.patch.createPatch;
  const shouldUseWorkerCreate = !!createPatchCapability;
  const original = await prepareCreateSource(input.original, "original", input.selectedOriginalEntryName);

  if (shouldUseWorkerCreate) {
    deps.reportProgress(options, {
      label: "Creating patch...",
      percent: null,
      stage: "create",
    });
    const modified = await prepareCreateSource(input.modified, "modified", input.selectedModifiedEntryName);
    const defaultPatchFileName = deps.getDefaultCreatePatchOutputFileName(
      getWorkflowSourceFileName(modified, "modified.bin", deps),
      format,
    );
    const requestedFileName = getCreateOutputName(options) || defaultPatchFileName;
    const compression = getArchiveOutputCompression(getCreateCompression(options), "create patch");
    const basePatchFileName =
      compression !== "none" && deps.hasArchiveFileName(requestedFileName, compression)
        ? defaultPatchFileName
        : requestedFileName;
    // Mirror the Rust `patch-create --checksum-name`: embed the source crc32 into
    // the patch file name so checksumless formats round trip a "right ROM?" guard
    // back into apply/validate. For compressed output this names the inner patch
    // entry, leaving the archive name as requested.
    const rawPatchFileName = embedSourceCrc32InPatchName(basePatchFileName, input.originalCrc32);
    if (rawPatchFileName !== basePatchFileName) {
      traceWorkflowStage(options, "stage.start", "checksum-name", "output", {
        crc32: input.originalCrc32,
        outputName: rawPatchFileName,
        requestedName: basePatchFileName,
      });
    }
    const result = await traceWorkflowStageBlock(
      options,
      "create",
      "output",
      () =>
        createPatchCapability({
          format,
          logLevel: getCreateLogLevel(options),
          metadata: getCreateMetadata(options),
          modified: modified as SourceRef,
          onLog: options.onLog,
          onProgress: (progress) =>
            deps.reportProgress(options, {
              label: typeof progress.label === "string" && progress.label ? progress.label : "Creating patch...",
              percent: getProgressEventPercent(progress),
              stage: "create",
            }),
          original: original as SourceRef,
          outputName: rawPatchFileName,
          signal: options.signal,
          workerThreads: getCreateWorkerThreads(options),
        }),
      () => ({ patchType: format, worker: true }),
    );
    if (compression === "none") return result;
    const patchFile = await createPatchFileFromPublicOutput(result.output, rawPatchFileName);
    const output = await createCompressedPatchOutput(patchFile);
    const compressionTimeMs = roundElapsedMs(output?.timing);
    return {
      format,
      output,
      sizeSummary: {
        ...(result.sizeSummary || {}),
        ...(compressionTimeMs === undefined ? {} : { compressionTimeMs }),
        outputSize: output.size,
        rawSize: patchFile.fileSize,
      },
    };
  }

  throw new Error("Patch creation requires the rom-weaver wasm runtime");
};

const createWorkflowDeps: CreateWorkflowDeps = {
  ...(patchWorkflowDeps as unknown as CreateWorkflowDeps),
  createPatchFile,
  getDefaultCreatePatchOutputFileName,
  getNamedSource,
  getNamedSourceFileName,
  getPatchFileBytes,
  hasArchiveFileName,
};

export { createWorkflowDeps, runCreateWorkflow };
