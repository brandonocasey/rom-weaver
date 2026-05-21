import type { PageUpdateState } from "./page-update-state.ts";
import type {
  CreatorSessionState,
  PatcherSessionState,
  StartupState,
  ValidationState,
  WorkflowView,
} from "./webapp-state-types.ts";

type ConfirmationDialogState = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  level: "error" | "warning";
};

type WebappRootProps = {
  state: {
    creatorSession: CreatorSessionState;
    currentView: WorkflowView;
    patcherSession: PatcherSessionState;
    settingsDialogOpen: boolean;
    settings: {
      [key: string]: RuntimeValue;
    };
    draftSettings: Record<string, RuntimeValue>;
    validation: ValidationState;
    startup: StartupState;
  };
  serviceWorkerCache: {
    label: string;
    title: string;
    updateLabel: string;
    updateReady: boolean;
    updateTitle: string;
  };
  pageUpdate: PageUpdateState;
  confirmationDialog: ConfirmationDialogState;
  actions: {
    onSelectView: (view: WorkflowView) => void;
    onDraftChange: (field: string, value: string | boolean) => void;
    onOpenSettings: () => void;
    onCloseSettings: () => void;
    onReloadUpdate: () => void;
    onRestoreDefaults: () => void;
    onSaveClose: () => void;
    onCancelConfirmation: () => void;
    onConfirmConfirmation: () => void;
    onCreatorModifiedChange: (file: unknown) => void;
    onCreatorOriginalChange: (file: unknown) => void;
    onCreatorPatchTypeChange: (patchType: string) => void;
    onCreatorSettingsChange: (settings: unknown) => void;
    onPatcherInputsChange: (inputs: readonly unknown[]) => void;
    onPatcherPatchesChange: (patches: readonly unknown[]) => void;
    onPatcherSettingsChange: (settings: unknown) => void;
  };
};

export type { ConfirmationDialogState, WebappRootProps, WorkflowView };
