import { type MutableRefObject, useCallback, useRef, useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import type { ManifestApplySession } from "../../lib/manifest/manifest-session-model.ts";
import { getBinarySourceListStableIds } from "./input-session-helpers.ts";
import type { BinarySource, PatcherOutputController, PatcherStackController } from "./patcher-form.ts";
import { getReactBinarySourceFileName } from "./workflow-adapters.ts";

const logger = createLogger("manifest-apply-session");

/** Per-patch manifest metadata kept for the cards (label/description) and export round-trips. */
type ManifestPatchMeta = { name?: string; label?: string; description?: string };

type ManifestSessionControllers = {
  output: PatcherOutputController | null;
  patchStack: PatcherStackController | null;
};

/** The output name field carries the name WITHOUT an extension (the format select owns it). */
const stripOutputNameExtension = (name: string): string => {
  const stripped = name.replace(/\.[a-z0-9]{1,5}$/i, "").trim();
  return stripped || name.trim();
};

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Applies a `?manifest=` session to the apply form exactly once: when the patch list first matches
 * the manifest's delivered files (ordered file names), it seeds enablement (required → on+locked,
 * default → on, optional → off), applies per-patch header modes and the manifest's output defaults
 * through the same controller methods user edits use (so later user edits naturally win), and keeps
 * the per-patch label/description metadata for the patch cards, keyed by stable source id.
 */
const useManifestApplySession = ({
  manifestSession,
  controllersRef,
  seedPatchEnablement,
}: {
  manifestSession: ManifestApplySession | null;
  /** Latest-controller ref — the local controllers are recreated per render, so reads go through here. */
  controllersRef: MutableRefObject<ManifestSessionControllers>;
  seedPatchEnablement: (entries: Array<{ id: string; enabled: boolean; locked: boolean }>) => void;
}) => {
  const appliedKeyRef = useRef<string | null>(null);
  const [manifestMetaById, setManifestMetaById] = useState<ReadonlyMap<string, ManifestPatchMeta>>(new Map());

  const handleManifestPatchesChange = useCallback(
    (patches: BinarySource[]) => {
      const session = manifestSession;
      if (!session?.entries.length || appliedKeyRef.current === session.key) return;
      const names = patches.map((patch, index) => getReactBinarySourceFileName(patch, `Patch ${index + 1}`));
      const expected = session.entries.map((entry) => entry.fileName);
      if (names.length !== expected.length || expected.some((name, index) => names[index] !== name)) return;
      appliedKeyRef.current = session.key;
      logger.debug("manifest session matched patch list; seeding enablement + defaults", {
        key: session.key,
        patchCount: patches.length,
      });
      const ids = getBinarySourceListStableIds(patches);
      seedPatchEnablement(
        session.entries
          .map((entry, index) => ({
            enabled: entry.status !== "optional",
            id: ids[index] ?? "",
            locked: entry.status === "required",
          }))
          .filter((entry) => !!entry.id),
      );
      const meta = new Map<string, ManifestPatchMeta>();
      session.entries.forEach((entry, index) => {
        const id = ids[index];
        if (!(id && (entry.label || entry.description || entry.name))) return;
        meta.set(id, {
          ...(entry.name ? { name: entry.name } : {}),
          ...(entry.label ? { label: entry.label } : {}),
          ...(entry.description ? { description: entry.description } : {}),
        });
      });
      setManifestMetaById(meta);
      // The controller work runs task-chained straight from the match, so everything lands while the
      // patches are still staging — well before the apply button arms. Deferring longer would race a
      // fast apply click: any settings commit cancels a queued apply (by design for real user edits).
      void (async () => {
        // Let the patch-list state commit so the option mutations snapshot the new list.
        await nextTask();
        // Per-patch header modes ride the normal option path (the same call the Options drawer's
        // strip-header checkbox makes); `auto` entries stay with the engine's per-step decision.
        for (const [index, entry] of session.entries.entries()) {
          if (entry.header !== "keep" && entry.header !== "strip") continue;
          await controllersRef.current.patchStack?.setPatchOption?.(index, { header: entry.header });
        }
        // Output defaults emulate user edits so later real edits win. Each setter merges into the
        // settings snapshot captured at ITS render, so consecutive same-tick calls would clobber one
        // another — yield a task between calls so each reads the committed result of the previous.
        const defaults = session.outputDefaults;
        if (defaults.name) {
          controllersRef.current.output?.setDisplayFileName(stripOutputNameExtension(defaults.name));
          await nextTask();
        }
        if (defaults.compression) {
          controllersRef.current.output?.setOutputCompression(defaults.compression);
          await nextTask();
        }
        if (defaults.header) controllersRef.current.output?.setOutputHeader?.(defaults.header);
      })();
    },
    [controllersRef, manifestSession, seedPatchEnablement],
  );

  return { handleManifestPatchesChange, manifestMetaById };
};

export type { ManifestPatchMeta, ManifestSessionControllers };
export { useManifestApplySession };
