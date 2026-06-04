import type { ReactNode } from "react";
import { FixesPanel, type FixesPanelProps } from "./fixes-panel.tsx";
import { type SourceInfoChecksums, SourceInfoList, type SourceInfoProgress } from "./source-info-list.tsx";

type RomInputInfoPanelProps = {
  bytes?: number;
  checksums?: SourceInfoChecksums | null;
  defaultOpen?: boolean;
  lead?: ReactNode;
  onToggle?: (open: boolean) => void;
  open?: boolean;
  progress?: SourceInfoProgress | null;
  timing?: ReactNode;
};

type RomInputPanelsProps = {
  fixes?: Omit<FixesPanelProps, "label">;
  info?: RomInputInfoPanelProps;
  showFixes?: boolean;
  showInfo?: boolean;
};

const RomInputPanels = ({ fixes = {}, info = {}, showFixes = true, showInfo = true }: RomInputPanelsProps) => (
  <>
    {showFixes ? <FixesPanel {...fixes} /> : null}
    {showInfo ? <SourceInfoList {...info} /> : null}
  </>
);

export { type RomInputInfoPanelProps, RomInputPanels, type RomInputPanelsProps };
