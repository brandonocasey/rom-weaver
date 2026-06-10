import type { ReactNode } from "react";
import { getDiscKind, getDiscKindLabel } from "../../../../lib/input/rom-specific-file-utils.ts";
import type { ChecksumVariant } from "../../../../types/checksum.ts";
import { CuePanel } from "./cue-panel.tsx";
import { FixesPanel, type FixesPanelProps } from "./fixes-panel.tsx";
import { type SourceInfoChecksums, SourceInfoList, type SourceInfoProgress } from "./source-info-list.tsx";

type RomInputInfoPanelProps = {
  bytes?: number;
  checksums?: SourceInfoChecksums | null;
  checksumVariants?: ChecksumVariant[];
  defaultOpen?: boolean;
  discType?: string;
  lead?: ReactNode;
  onToggle?: (open: boolean) => void;
  open?: boolean;
  progress?: SourceInfoProgress | null;
  timing?: ReactNode;
};

type RomInputPanelsProps = {
  fixes?: Omit<FixesPanelProps, "label">;
  info?: RomInputInfoPanelProps;
  cue?: { cueText: string };
  showFixes?: boolean;
  showInfo?: boolean;
  showCue?: boolean;
};

const RomInputPanels = ({
  fixes = {},
  info = {},
  cue,
  showFixes = true,
  showInfo = true,
  showCue = true,
}: RomInputPanelsProps) => {
  // Derive the disc type from the cue sheet so it appears in the source Info
  // panel; an explicit info.discType (e.g. from a non-cue source) wins.
  const discType = info.discType ?? getDiscKindLabel(getDiscKind({ cueText: cue?.cueText })) ?? undefined;
  return (
    <>
      {showFixes ? <FixesPanel {...fixes} /> : null}
      {showInfo ? <SourceInfoList {...info} discType={discType} /> : null}
      {showCue && cue?.cueText ? <CuePanel cueText={cue.cueText} /> : null}
    </>
  );
};

export { type RomInputInfoPanelProps, RomInputPanels, type RomInputPanelsProps };
