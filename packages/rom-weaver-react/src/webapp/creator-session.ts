import type { JsonValue, ProgressEvent } from "../types/runtime.ts";

const XDELTA_DEFAULT_SOURCE_EXTENSION_REGEX = /\.(rvz|iso|bin)$/i;

type PatchNoticeLevel = "error" | "warning";
type PatchFormat = "bps" | "ebp" | "ips" | "rup" | "xdelta" | string;
type CreatorSelectionMode = "auto" | "manual";
type CreatorSessionInputType = "original" | "modified";

type CreatorState = {
  originalFileName: string;
  modifiedFileName: string;
  originalInputTiming: string;
  modifiedInputTiming: string;
  originalInputProgress: ProgressEvent | null;
  modifiedInputProgress: ProgressEvent | null;
  patchType: PatchFormat;
  metadataFields: string[];
  metadataValues: Record<string, string>;
  createButton: {
    disabled: boolean;
    loading: boolean;
    label: string;
    progress: ProgressEvent | null;
  };
  notice: {
    level: PatchNoticeLevel;
    message: string;
    visible: boolean;
  };
};

type CreatorSelectionState = {
  displayFileName: string;
  present: boolean;
  timing: string;
  progress: ProgressEvent | null;
};

type CreatorSessionOptions = {
  translate?: (value: string) => string;
};

type CreatorSession = {
  clearNotice: () => void;
  getMetadataObject: () => Record<string, string>;
  getState: () => CreatorState;
  reset: () => void;
  setBusy: (status: boolean, label?: string) => void;
  setBusyLabel: (label?: string) => void;
  setBusyProgress: (progress?: ProgressEvent | null) => void;
  setInputProgress: (type: CreatorSessionInputType, progress?: ProgressEvent | null) => void;
  setInputSelection: (type: CreatorSessionInputType, selection: Partial<CreatorSelectionState>) => void;
  setMetadataField: (field: string, value: JsonValue | undefined) => void;
  setNotice: (message?: string, level?: PatchNoticeLevel) => void;
  setPatchType: (patchType: string) => void;
};

const getCreatorMetadataFields = (patchFormat: PatchFormat) => {
  if (patchFormat === "rup") return ["Description"];
  if (patchFormat === "ebp") return ["Author", "Title", "Description"];
  return [];
};

const shouldDefaultToXdelta = (fileName: string) => XDELTA_DEFAULT_SOURCE_EXTENSION_REGEX.test(fileName || "");

const createEmptyCreatorState = (translate?: (value: string) => string): CreatorState => ({
  createButton: {
    disabled: true,
    label: translate ? translate("Create patch") : "Create patch",
    loading: false,
    progress: null,
  },
  metadataFields: [],
  metadataValues: {},
  modifiedFileName: "",
  modifiedInputProgress: null,
  modifiedInputTiming: "",
  notice: {
    level: "error",
    message: "",
    visible: false,
  },
  originalFileName: "",
  originalInputProgress: null,
  originalInputTiming: "",
  patchType: "bps",
});

const createEmptyCreatorSelectionState = (): CreatorSelectionState => ({
  displayFileName: "",
  present: false,
  progress: null,
  timing: "",
});

const createEmptyCreatorSelections = (): Record<CreatorSessionInputType, CreatorSelectionState> => ({
  modified: createEmptyCreatorSelectionState(),
  original: createEmptyCreatorSelectionState(),
});

const createCreatorSession = ({ translate }: CreatorSessionOptions = {}): CreatorSession => {
  const _ = typeof translate === "function" ? translate : (value: string) => value;
  let state = createEmptyCreatorState(_);
  let metadataValues: Record<string, string> = {};
  let patchTypeSelectionMode: CreatorSelectionMode = "auto";
  let busyLabel = "";
  let selections = createEmptyCreatorSelections();

  const pruneMetadataValues = (patchFormat: PatchFormat) => {
    const allowedFields = new Set(getCreatorMetadataFields(patchFormat));
    metadataValues = Object.keys(metadataValues).reduce<Record<string, string>>((nextValues, field) => {
      if (allowedFields.has(field)) nextValues[field] = metadataValues[field] || "";
      return nextValues;
    }, {});
  };

  const getAutoPatchType = (): PatchFormat => {
    const fileNames = [selections.original.displayFileName, selections.modified.displayFileName];
    return fileNames.some(shouldDefaultToXdelta) ? "xdelta" : "bps";
  };

  const syncState = () => {
    const patchType = patchTypeSelectionMode === "manual" ? state.patchType : getAutoPatchType();
    pruneMetadataValues(patchType);
    state = {
      ...state,
      createButton: {
        disabled: !(selections.original.present && selections.modified.present) || !!state.createButton.loading,
        label: state.createButton.loading ? busyLabel || _("Creating patch...") : _("Create patch"),
        loading: !!state.createButton.loading,
        progress: state.createButton.loading ? state.createButton.progress || null : null,
      },
      metadataFields: getCreatorMetadataFields(patchType),
      metadataValues: { ...metadataValues },
      modifiedFileName: selections.modified.displayFileName || "",
      modifiedInputProgress: selections.modified.progress,
      modifiedInputTiming: selections.modified.timing,
      originalFileName: selections.original.displayFileName || "",
      originalInputProgress: selections.original.progress,
      originalInputTiming: selections.original.timing,
      patchType: patchType,
    };
  };

  return {
    clearNotice() {
      state = {
        ...state,
        notice: {
          level: "error",
          message: "",
          visible: false,
        },
      };
    },
    getMetadataObject() {
      return getCreatorMetadataFields(state.patchType).reduce<Record<string, string>>((metadata, field) => {
        if (typeof metadataValues[field] === "string" && metadataValues[field].trim())
          metadata[field] = metadataValues[field].trim();
        return metadata;
      }, {});
    },
    getState() {
      return {
        createButton: {
          disabled: !!state.createButton?.disabled,
          label: state.createButton?.label || _("Create patch"),
          loading: !!state.createButton?.loading,
          progress: state.createButton?.progress || null,
        },
        metadataFields: Array.isArray(state.metadataFields) ? state.metadataFields.slice() : [],
        metadataValues: { ...(state.metadataValues || {}) },
        modifiedFileName: state.modifiedFileName || "",
        modifiedInputProgress: state.modifiedInputProgress || null,
        modifiedInputTiming: state.modifiedInputTiming || "",
        notice: {
          level: state.notice?.level === "warning" ? "warning" : "error",
          message: state.notice?.message || "",
          visible: !!state.notice?.visible && !!state.notice?.message,
        },
        originalFileName: state.originalFileName || "",
        originalInputProgress: state.originalInputProgress || null,
        originalInputTiming: state.originalInputTiming || "",
        patchType: state.patchType || "bps",
      };
    },
    reset() {
      metadataValues = {};
      patchTypeSelectionMode = "auto";
      busyLabel = "";
      selections = createEmptyCreatorSelections();
      state = createEmptyCreatorState(_);
    },
    setBusy(status: boolean, label?: string) {
      if (status) busyLabel = label || busyLabel || _("Creating patch...");
      else busyLabel = "";
      state = {
        ...state,
        createButton: {
          disabled: !!status || !(selections.original.present && selections.modified.present),
          label: status ? busyLabel || _("Creating patch...") : _("Create patch"),
          loading: !!status,
          progress: status ? state.createButton.progress || null : null,
        },
      };
      syncState();
    },
    setBusyLabel(label?: string) {
      if (!state.createButton.loading) return;
      busyLabel = label || busyLabel || _("Creating patch...");
      syncState();
    },
    setBusyProgress(progress?: ProgressEvent | null) {
      if (!state.createButton.loading) return;
      if (typeof progress?.label === "string") busyLabel = progress.label || busyLabel;
      else if (typeof progress?.message === "string") busyLabel = progress.message || busyLabel;
      state = {
        ...state,
        createButton: {
          ...state.createButton,
          progress: progress || null,
        },
      };
      syncState();
    },
    setInputProgress(type: CreatorSessionInputType, progress?: ProgressEvent | null) {
      selections = {
        ...selections,
        [type]: {
          ...selections[type],
          progress: progress || null,
        },
      };
      syncState();
    },
    setInputSelection(type: CreatorSessionInputType, selection: Partial<CreatorSelectionState>) {
      selections = {
        ...selections,
        [type]: {
          displayFileName:
            typeof selection.displayFileName === "string"
              ? selection.displayFileName
              : selections[type].displayFileName,
          present: typeof selection.present === "boolean" ? selection.present : selections[type].present,
          progress: Object.hasOwn(selection, "progress") ? selection.progress || null : selections[type].progress,
          timing: typeof selection.timing === "string" ? selection.timing : selections[type].timing,
        },
      };
      syncState();
    },
    setMetadataField(field: string, value: JsonValue | undefined) {
      metadataValues[field] = String(value || "");
      syncState();
    },
    setNotice(message?: string, level?: PatchNoticeLevel) {
      state = {
        ...state,
        notice: {
          level: level === "warning" ? "warning" : "error",
          message: message || "",
          visible: !!message,
        },
      };
    },
    setPatchType(patchType: string) {
      patchTypeSelectionMode = "manual";
      state = {
        ...state,
        patchType: typeof patchType === "string" ? patchType : state.patchType,
      };
      pruneMetadataValues(state.patchType);
      syncState();
    },
  };
};

export type { CreatorSession, CreatorState };
export { createCreatorSession, createEmptyCreatorState, getCreatorMetadataFields, shouldDefaultToXdelta };
