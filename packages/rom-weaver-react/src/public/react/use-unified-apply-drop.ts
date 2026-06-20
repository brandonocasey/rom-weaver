import { useCallback } from "react";
import { createLogger } from "../../lib/logging.ts";
import { classifyDroppedFiles } from "./file-classification.ts";

/**
 * Drop orchestration for the Apply tab.
 *
 * Bare ROMs/patches route by extension. An archive is NOT pre-classified by a
 * filename probe — that duplicated (and mis-judged) Rust's own ROM/container
 * classification. Instead every archive stages straight into the ROM bucket and
 * lets Rust's nested extract drive: a real ROM (single, or a keep-one pick when
 * several compete) stays in the ROM bucket, while a patch-only bundle is
 * reclassified to the patch bucket when Rust's probe-manifest reports
 * `is_rom === false` (see `reclassifyArchiveToPatch` in the session). Both the
 * in-tab dropzone and the page-wide drop forwarder funnel through one `onDrop`.
 */

const logger = createLogger("unified-apply-drop");

/** Retained for API compatibility — the routing no longer needs placeholder cards because an archive's
 * real ROM staging card appears instantly in the ROM bucket. */
type PendingDrop = {
  id: string;
  name: string;
};

type UnifiedDropController = {
  provideRomInputFiles?: (files: File[]) => void;
  providePatchInputFiles?: (files: File[]) => void;
};

type UnifiedApplyDrop = {
  pendingDrops: PendingDrop[];
  onDrop: (files: File[], isCancelled?: () => boolean) => void;
};

const NO_PENDING_DROPS: PendingDrop[] = [];

const useUnifiedApplyDrop = (controller: UnifiedDropController): UnifiedApplyDrop => {
  const onDrop = useCallback(
    (files: File[], isCancelled?: () => boolean) => {
      if (isCancelled?.()) return;
      const { archives, inputs, patches } = classifyDroppedFiles(files);
      // Archives join the ROM bucket alongside bare ROMs; Rust's nested extract reclassifies any
      // patch-only bundle to the patch bucket on identify.
      const romInputs = [...inputs, ...archives];
      logger.trace("unified apply drop received files", {
        archiveCount: archives.length,
        fileCount: files.length,
        patchCount: patches.length,
        romInputCount: romInputs.length,
      });
      if (romInputs.length) controller.provideRomInputFiles?.(romInputs);
      if (patches.length) controller.providePatchInputFiles?.(patches);
    },
    [controller],
  );

  return { onDrop, pendingDrops: NO_PENDING_DROPS };
};

export { type PendingDrop, useUnifiedApplyDrop };
