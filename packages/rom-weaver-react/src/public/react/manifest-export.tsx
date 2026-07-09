import { useCallback, useRef, useState } from "react";
import { triggerBrowserDownload } from "../../platform/browser/browser-download.ts";
import { browserRuntime } from "../../platform/browser/workflow-runtime.ts";
import type { ManifestHeaderMode, ManifestPatchStatus, ParsedManifestCreateResult } from "../../types/manifest.ts";
import { Notice } from "./components/ds/feedback.tsx";
import { Modal } from "./components/ds/index.ts";
import { getBinarySourceListStableIds } from "./input-session-helpers.ts";
import type { BinarySource } from "./patcher-form.ts";
import type { PatchStackItemState } from "./patcher-presentation.ts";
import { useUiLocalizer } from "./settings-context.tsx";
import type { ManifestPatchMeta } from "./use-manifest-apply-session.ts";
import { getReactBinarySourceFileName } from "./workflow-adapters.ts";

/**
 * The apply form's "Export manifest…" flow: a small dialog collecting a manifest
 * name/description + per-patch statuses (prefilled from the live enablement
 * state and any originating manifest session), then a `manifest create` run
 * over the CURRENT session's ROM + patch files. The emitted rw.json (or the
 * everything-bundle .zip) goes straight to the browser download path.
 */

type ManifestExportRow = {
  fileName: string;
  status: ManifestPatchStatus;
  name?: string;
  description?: string;
  label?: string;
  header?: ManifestHeaderMode;
};

type ManifestExportSources = { inputs: BinarySource[]; patches: BinarySource[] };

type UseManifestExportOptions = {
  /** Live session sources, read at dialog-open time. */
  getSessionSources: () => ManifestExportSources;
  /** Live per-patch stack items (index-aligned with patches) for header round-trips. */
  getStackItems: () => PatchStackItemState[];
  disabledPatchIds: ReadonlySet<string>;
  lockedPatchIds: ReadonlySet<string>;
  /** Originating manifest session metadata (name/label/description round-trips). */
  manifestMetaById: ReadonlyMap<string, ManifestPatchMeta>;
  initialName?: string;
  initialDescription?: string;
  onComplete?: (result: ParsedManifestCreateResult) => void;
};

const useManifestExport = ({
  getSessionSources,
  getStackItems,
  disabledPatchIds,
  lockedPatchIds,
  manifestMetaById,
  initialName,
  initialDescription,
  onComplete,
}: UseManifestExportOptions) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [bundle, setBundle] = useState(false);
  const [rows, setRows] = useState<ManifestExportRow[]>([]);
  // The sources captured when the dialog opened, so the export run stays aligned with its rows even
  // if the bench changes underneath the open dialog.
  const sourcesRef = useRef<ManifestExportSources>({ inputs: [], patches: [] });

  const openDialog = useCallback(() => {
    const sources = getSessionSources();
    const items = getStackItems();
    const ids = getBinarySourceListStableIds(sources.patches);
    sourcesRef.current = { inputs: sources.inputs.slice(), patches: sources.patches.slice() };
    setRows(
      sources.patches.map((patch, index) => {
        const id = ids[index] || "";
        const meta = id ? manifestMetaById.get(id) : undefined;
        const headerChoice = items[index]?.headerChoice;
        // Toggled-off patches export as `optional`; a manifest session's locked
        // `required` entries stay required; everything else is `default`.
        const status: ManifestPatchStatus = disabledPatchIds.has(id)
          ? "optional"
          : lockedPatchIds.has(id)
            ? "required"
            : "default";
        return {
          fileName: getReactBinarySourceFileName(patch, `patch-${index + 1}.bin`),
          status,
          ...(meta?.name ? { name: meta.name } : {}),
          ...(meta?.description ? { description: meta.description } : {}),
          ...(meta?.label ? { label: meta.label } : {}),
          ...(headerChoice === "keep" || headerChoice === "strip" ? { header: headerChoice } : {}),
        };
      }),
    );
    setName(initialName || "");
    setDescription(initialDescription || "");
    setBundle(false);
    setError("");
    setOpen(true);
  }, [
    disabledPatchIds,
    getSessionSources,
    getStackItems,
    initialDescription,
    initialName,
    lockedPatchIds,
    manifestMetaById,
  ]);

  const closeDialog = useCallback(() => {
    if (!busy) setOpen(false);
  }, [busy]);

  const setRowStatus = useCallback((index: number, status: ManifestPatchStatus) => {
    setRows((previous) => previous.map((row, rowIndex) => (rowIndex === index ? { ...row, status } : row)));
  }, []);

  const runExport = useCallback(async () => {
    const create = browserRuntime.manifest?.create;
    const { inputs, patches } = sourcesRef.current;
    if (!(create && patches.length)) return;
    setBusy(true);
    setError("");
    try {
      const rom = inputs[0];
      const { result, manifestFile, bundleFile } = await create({
        bundle,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        patches: patches.map((patch, index) => {
          const row = rows[index];
          return {
            fileName: row?.fileName || getReactBinarySourceFileName(patch, `patch-${index + 1}.bin`),
            source: patch,
            status: row?.status || "default",
            ...(row?.name ? { name: row.name } : {}),
            ...(row?.description ? { description: row.description } : {}),
            ...(row?.label ? { label: row.label } : {}),
            ...(row?.header ? { header: row.header } : {}),
          };
        }),
        ...(rom ? { rom: { fileName: getReactBinarySourceFileName(rom, "rom.bin"), source: rom } } : {}),
      });
      onComplete?.(result);
      const downloadFile = bundle && bundleFile ? bundleFile : manifestFile;
      await triggerBrowserDownload(downloadFile, downloadFile.name);
      setOpen(false);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusy(false);
    }
  }, [bundle, description, name, onComplete, rows]);

  return {
    bundle,
    busy,
    closeDialog,
    description,
    error,
    name,
    open,
    openDialog,
    rows,
    runExport,
    setBundle,
    setDescription,
    setName,
    setRowStatus,
  };
};

type ManifestExportDialogProps = ReturnType<typeof useManifestExport>;

const MANIFEST_STATUS_VALUES: ManifestPatchStatus[] = ["required", "default", "optional", "disabled"];

const ManifestExportDialog = (props: ManifestExportDialogProps) => {
  const localizer = useUiLocalizer();
  return (
    <Modal onClose={props.closeDialog} open={props.open} title={localizer.message("ui.manifestExport.title")}>
      <div className="optsgrid">
        <div className="ofld">
          <label className="ofld-l" htmlFor="rom-weaver-manifest-export-name">
            {localizer.message("ui.manifestExport.name")}
          </label>
          <input
            className="input"
            disabled={props.busy}
            id="rom-weaver-manifest-export-name"
            onChange={(event) => props.setName(event.currentTarget.value)}
            type="text"
            value={props.name}
          />
        </div>
        <div className="ofld">
          <label className="ofld-l" htmlFor="rom-weaver-manifest-export-description">
            {localizer.message("ui.manifestExport.description")}
          </label>
          <input
            className="input"
            disabled={props.busy}
            id="rom-weaver-manifest-export-description"
            onChange={(event) => props.setDescription(event.currentTarget.value)}
            type="text"
            value={props.description}
          />
        </div>
      </div>
      <div className="descblk" id="rom-weaver-manifest-export-patches">
        <div className="k">{localizer.message("ui.manifestExport.patches")}</div>
        {props.rows.map((row, index) => (
          <div className="ofld" key={`${index}:${row.fileName}`}>
            <span className="ofld-l mono">{row.fileName}</span>
            <select
              aria-label={localizer.message("ui.manifestExport.statusLabel", { n: index + 1 })}
              className="select"
              disabled={props.busy}
              id={`rom-weaver-manifest-export-status-${index}`}
              onChange={(event) => props.setRowStatus(index, event.currentTarget.value as ManifestPatchStatus)}
              value={row.status}
            >
              {MANIFEST_STATUS_VALUES.map((status) => (
                <option key={status} value={status}>
                  {localizer.message(`ui.manifestExport.status.${status}`)}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <label className="checkrow">
        <input
          checked={props.bundle}
          disabled={props.busy}
          id="rom-weaver-manifest-export-bundle"
          onChange={(event) => props.setBundle(event.currentTarget.checked)}
          type="checkbox"
        />
        <span>{localizer.message("ui.manifestExport.bundle")}</span>
      </label>
      {props.error ? (
        <Notice id="rom-weaver-manifest-export-error" level="error">
          {localizer.message("ui.manifestExport.error")}: {props.error}
        </Notice>
      ) : null}
      <div className="c-actions">
        <button className="btn ghost" disabled={props.busy} onClick={props.closeDialog} type="button">
          {localizer.message("ui.common.cancel")}
        </button>
        <button
          className="btn primary"
          disabled={props.busy || !props.rows.length}
          id="rom-weaver-manifest-export-run"
          onClick={() => void props.runExport()}
          type="button"
        >
          {localizer.message("ui.manifestExport.export")}
        </button>
      </div>
    </Modal>
  );
};

export { ManifestExportDialog, useManifestExport };
