type WorkflowView = "patcher" | "creator";

type ValidationState = {
  messages: string[];
  invalidFields: string[];
};

type StartupState = {
  status: "loading" | "ready" | "error";
  message: string;
};

type PatcherSessionState = {
  outputCompression: string;
  outputName: string;
  patchCount: number;
  pendingDownloadFileName: string | null;
  romFilePresent: boolean;
};

type CreatorSessionState = {
  modifiedFilePresent: boolean;
  originalFilePresent: boolean;
  outputName: string;
  patchType: string;
};

const createEmptyValidationState = (): ValidationState => ({
  invalidFields: [],
  messages: [],
});

const createEmptyPatcherSessionState = (): PatcherSessionState => ({
  outputCompression: "none",
  outputName: "",
  patchCount: 0,
  pendingDownloadFileName: null,
  romFilePresent: false,
});

const createEmptyCreatorSessionState = (): CreatorSessionState => ({
  modifiedFilePresent: false,
  originalFilePresent: false,
  outputName: "",
  patchType: "bps",
});

export type { CreatorSessionState, PatcherSessionState, StartupState, ValidationState, WorkflowView };
export { createEmptyCreatorSessionState, createEmptyPatcherSessionState, createEmptyValidationState };
