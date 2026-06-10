import type { ReactNode } from "react";
import { createLogger } from "../../../../lib/logging.ts";
import { DropZone } from "./layout.tsx";

/**
 * The single combined drop surface shared by every workflow tab. A thin wrapper
 * over the {@link DropZone} primitive that always accepts multiple files, traces
 * what it receives, and composes the per-category hints into one minimal line
 * ("roms (…), patches (…), or archives (…)"). The patch hint is omitted on
 * ROM-only tabs (Create/Trim) by simply not passing `patchHint`. Routing is
 * decided by the per-tab caller (see `unified-drop-routing.ts`).
 */

const logger = createLogger("unified-drop-zone");

const joinHintParts = (parts: string[]): string | undefined => {
  if (parts.length <= 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")}${parts.length > 2 ? "," : ""} or ${parts[parts.length - 1]}`;
};

type UnifiedDropZoneProps = {
  label: ReactNode;
  romHint?: string;
  patchHint?: string;
  archiveHint?: string;
  big?: boolean;
  disabled?: boolean;
  accept?: string;
  id?: string;
  inputId?: string;
  onFiles: (files: File[]) => void;
};

const UnifiedDropZone = ({ archiveHint, onFiles, patchHint, romHint, ...dropZoneProps }: UnifiedDropZoneProps) => {
  const emit = (files: File[]) => {
    logger.trace("unified drop zone received files", {
      count: files.length,
      names: files.map((file) => file.name),
    });
    onFiles(files);
  };
  const hint = joinHintParts([romHint, patchHint, archiveHint].filter((part): part is string => !!part));
  // Wrap in a headerless section so the surface lines up with the form's other
  // step bodies (same horizontal inset) instead of spanning the full panel
  // width. The `--hero` modifier (empty state) keeps generous breathing room;
  // otherwise the section hugs the slim inline bar. First child = no top border.
  return (
    <div className={dropZoneProps.big ? "step unified-drop-step unified-drop-step--hero" : "step unified-drop-step"}>
      <div className="step-body">
        <DropZone {...dropZoneProps} hint={hint} multiple onFiles={emit} />
      </div>
    </div>
  );
};

export type { UnifiedDropZoneProps };
export { UnifiedDropZone };
