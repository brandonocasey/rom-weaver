import { useCallback, useRef, useState } from "react";
import { getBinarySourceListStableIds } from "./input-session-helpers.ts";
import type { BinarySource } from "./patcher-form.ts";

/**
 * Owns the apply form's patch enable/disable state (the loom On/Off switch).
 * Disabled patches stay on the bench but are excluded from the apply run; the
 * set is keyed by stable source id so reorders/removals keep the right patches
 * off. Extracted from `ApplyPatchForm` as a cohesive state+refs+callback group:
 *
 * - `disabledPatchIds` / `togglePatchEnabled` drive the per-patch switch.
 * - `lockedPatchIds` / `seedPatchEnablement` carry a manifest session's
 *   enablement seed: required patches stay enabled with the toggle locked,
 *   optional ones start off but remain toggleable.
 * - `syncPatchTracking` mirrors the current patch list into a ref (so the
 *   toggle can resolve an index → stable id) and drops stale toggles whenever
 *   the list changes, so a removed patch's id can't disable a later re-add.
 * - `filterEnabledPatches` strips disabled patches before they reach the
 *   workflow; `getPatchIds` feeds the view's enablement controls.
 */
const useApplyPatchEnablement = () => {
  const [disabledPatchIds, setDisabledPatchIds] = useState<ReadonlySet<string>>(new Set());
  const [lockedPatchIds, setLockedPatchIds] = useState<ReadonlySet<string>>(new Set());
  const disabledPatchIdsRef = useRef(disabledPatchIds);
  disabledPatchIdsRef.current = disabledPatchIds;
  const lockedPatchIdsRef = useRef(lockedPatchIds);
  lockedPatchIdsRef.current = lockedPatchIds;
  const currentPatchesRef = useRef<BinarySource[]>([]);

  // Mirror the latest patch list and drop toggles whose source has gone away. Called from the form's
  // onPatchesChange handler before its own selection-sync/prop-forwarding, preserving call order.
  const syncPatchTracking = useCallback((nextPatches: BinarySource[]) => {
    currentPatchesRef.current = nextPatches;
    // Drop stale toggles/locks so a removed patch's id can't disable a later re-add.
    const ids = new Set(getBinarySourceListStableIds(nextPatches));
    const retainKnownIds = (previous: ReadonlySet<string>): ReadonlySet<string> => {
      const next = new Set([...previous].filter((id) => ids.has(id)));
      return next.size === previous.size ? previous : next;
    };
    setDisabledPatchIds(retainKnownIds);
    setLockedPatchIds(retainKnownIds);
  }, []);

  const togglePatchEnabled = useCallback((index: number) => {
    const id = getBinarySourceListStableIds(currentPatchesRef.current)[index];
    if (id === undefined) return;
    // A locked patch (a manifest's `required` entry) cannot be toggled off.
    if (lockedPatchIdsRef.current.has(id)) return;
    setDisabledPatchIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Seed enablement + locks in one pass (a manifest session's statuses). */
  const seedPatchEnablement = useCallback((entries: Array<{ id: string; enabled: boolean; locked: boolean }>) => {
    setDisabledPatchIds((previous) => {
      const next = new Set(previous);
      for (const entry of entries) {
        if (entry.enabled) next.delete(entry.id);
        else next.add(entry.id);
      }
      return next;
    });
    setLockedPatchIds((previous) => {
      const next = new Set(previous);
      for (const entry of entries) {
        if (entry.locked) next.add(entry.id);
        else next.delete(entry.id);
      }
      return next;
    });
  }, []);

  const filterEnabledPatches = useCallback((patches: BinarySource[]) => {
    const disabled = disabledPatchIdsRef.current;
    if (!disabled.size) return patches;
    const ids = getBinarySourceListStableIds(patches);
    return patches.filter((_, index) => {
      const id = ids[index];
      return id === undefined || !disabled.has(id);
    });
  }, []);

  const getPatchIds = useCallback(() => getBinarySourceListStableIds(currentPatchesRef.current), []);

  return {
    disabledPatchIds,
    filterEnabledPatches,
    getPatchIds,
    lockedPatchIds,
    seedPatchEnablement,
    syncPatchTracking,
    togglePatchEnabled,
  };
};

export { useApplyPatchEnablement };
