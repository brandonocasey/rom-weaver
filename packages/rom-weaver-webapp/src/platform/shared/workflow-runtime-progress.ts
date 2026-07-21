import type { WorkflowRuntime } from "../../types/workflow-runtime-adapter.ts";
import type { JsonValue, ProgressEvent } from "../../types/workflow-runtime-types.ts";

type JsonRecord = { [key: string]: JsonValue | undefined };

type RuntimeProgress = {
  details?: JsonValue;
  label?: string;
  message?: string;
  percent?: number | null;
  stage?: string;
};

const isRecord = (value: JsonValue | object | null | undefined): value is JsonRecord =>
  !!value && typeof value === "object" && !Array.isArray(value) && !ArrayBuffer.isView(value);

/* Rust stage labels name the FORMAT, never the file ("extracting rvz (18%)",
   "creating `7z` (3/10)"). When the call site knows the file, swap the generic
   stem for the contextual label and keep the parenthetical progress detail. */
const GENERIC_STAGE_LABEL =
  /^(extracting|creating|compressing|converting|decompressing|reading)\s+`?[\w.-]+`?\s*(\((?:\d{1,3}\s*%|\d+\/\d+)\))?$/i;

const contextualizeRuntimeLabel = (label: string | undefined, contextualLabel: string | undefined) => {
  if (!label) return contextualLabel;
  if (!contextualLabel) return label;
  const generic = label.trim().match(GENERIC_STAGE_LABEL);
  if (!generic) return label;
  const detail = generic[2];
  if (!detail) return contextualLabel;
  return `${contextualLabel.replace(/\.{3}$/, "")} ${detail}`;
};

const forwardCreatePatchProgress =
  (onProgress?: Parameters<NonNullable<WorkflowRuntime["patch"]["createPatch"]>>[0]["onProgress"]) =>
  (progress: RuntimeProgress) => {
    onProgress?.({
      ...progress,
    });
  };

const getProgressLabel = (stage: "input" | "output", label: string | undefined, fallbackLabel: string | undefined) =>
  contextualizeRuntimeLabel(label, fallbackLabel) ||
  (stage === "input" ? "Extracting disc image..." : "Creating disc image...");

const getArchiveProgressDetails = (progress: RuntimeProgress) =>
  isRecord(progress.details)
    ? {
        ...progress.details,
        ...(progress.stage ? { runtimeStage: progress.stage } : {}),
      }
    : progress.details;

const getArchivePercent = (percent: number | null | undefined, sawIntermediate: boolean) => {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return { percent: null, sawIntermediate };
  const normalized = Math.max(0, Math.min(100, percent));
  const nextSawIntermediate = sawIntermediate || (normalized > 0 && normalized < 100);
  const hiddenBoundary = (normalized >= 100 || normalized <= 0) && !sawIntermediate;
  return { percent: hiddenBoundary ? null : normalized, sawIntermediate: nextSawIntermediate };
};

const forwardRomSpecificProgress = (
  stage: "input" | "output",
  onProgress?: (progress: ProgressEvent) => void,
  /** Contextual fallback (e.g. "Extracting game.rvz...") shown when the runtime event carries no label. */
  fallbackLabel?: string,
) => {
  if (!onProgress) return undefined;
  return (progress: RuntimeProgress) => {
    const label = getProgressLabel(stage, progress.label, fallbackLabel);
    const percent =
      typeof progress.percent === "number" && Number.isFinite(progress.percent)
        ? Math.max(0, Math.min(100, progress.percent))
        : null;
    onProgress({
      ...progress,
      label,
      percent,
      stage,
    });
  };
};

const forwardArchiveProgress = (
  stage: "input" | "output",
  onProgress?: (progress: ProgressEvent) => void,
  /** Contextual fallback (e.g. "Extracting game.zip...") shown when the runtime event carries no label. */
  fallbackLabel?: string,
) => {
  let sawIntermediate = false;
  return (progress: RuntimeProgress) => {
    const label =
      contextualizeRuntimeLabel(progress.label, fallbackLabel) ||
      (stage === "input" ? "Extracting archive entry..." : "Creating archive...");
    const details = getArchiveProgressDetails(progress);
    const emit = (percent: number | null) => {
      onProgress?.({
        ...progress,
        details,
        label,
        percent,
        stage,
      });
    };
    const next = getArchivePercent(progress.percent, sawIntermediate);
    sawIntermediate = next.sawIntermediate;
    emit(next.percent);
  };
};

export { contextualizeRuntimeLabel, forwardArchiveProgress, forwardCreatePatchProgress, forwardRomSpecificProgress };
