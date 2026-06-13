import Download from "lucide-react/dist/esm/icons/download.js";
import { useSyncExternalStore } from "react";
import { RunButton } from "../components/ds/feedback.tsx";
import type { PatcherOutputState } from "../patcher-presentation.ts";
import { ApplyBandaidIcon } from "./apply-bandaid-icon.tsx";
import { ProgressActionButton } from "./progress-action-button.tsx";

type OutputController = {
  subscribe: (listener: () => void) => () => void;
  getState: () => PatcherOutputState;
  cancelPrimaryAction?: () => void;
  setDisplayFileName: (value: string) => void;
  setOutputCompression: (value: string) => void;
  runPrimaryAction: () => void;
};

/** The apply form's primary action: download button when an output is ready, run/progress otherwise. */
function PatcherPrimaryAction({
  controller,
  disableRun,
  totalTime,
}: {
  controller: OutputController;
  /** Extra gate (e.g. every staged patch toggled off). */
  disableRun?: boolean;
  /** Total wall time for the finished run (download button right edge). */
  totalTime?: string;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  if (state.pendingDownloadFileName && !state.applyButton.progress && !state.applyButton.loading) {
    return (
      <RunButton
        disabled={state.applyButton.disabled}
        download={{
          format: state.pendingDownloadFileName
            ? "Patched"
            : state.downloadSummary?.format
              ? `Patched ${state.downloadSummary.format}`
              : "Patched",
          name: state.pendingDownloadFileName || undefined,
          size:
            state.downloadSummary?.size && state.downloadSummary?.ratio
              ? `${state.downloadSummary.size} (${state.downloadSummary.ratio})`
              : state.downloadSummary?.size || undefined,
          total: totalTime,
        }}
        icon={<Download aria-hidden="true" />}
        id="rom-weaver-button-apply"
        onClick={() => controller.runPrimaryAction()}
      />
    );
  }

  return (
    <ProgressActionButton
      cancelLabel="Cancel apply"
      disabled={state.applyButton.disabled || !!disableRun}
      icon={<ApplyBandaidIcon className="apply-button-icon" />}
      id="rom-weaver-button-apply"
      label={state.applyButton.label}
      loading={state.applyButton.loading}
      onCancel={controller.cancelPrimaryAction}
      onClick={() => controller.runPrimaryAction()}
      progress={state.applyButton.progress}
      progressId="rom-weaver-progress-apply"
    />
  );
}

export { PatcherPrimaryAction };
