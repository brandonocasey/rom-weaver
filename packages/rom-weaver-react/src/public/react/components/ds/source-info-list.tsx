import type { ReactNode } from "react";
import { ChecksumList, ChecksumRow } from "./checksum-list.tsx";
import { FileProgress } from "./feedback.tsx";

type SourceInfoChecksums = {
  crc32?: string;
  md5?: string;
  sha1?: string;
};

type SourceInfoProgress = Parameters<typeof FileProgress>[0];

const SourceInfoList = ({
  bytes,
  checksums,
  defaultOpen = false,
  lead,
  onToggle,
  open,
  progress,
  timing,
}: {
  bytes?: number;
  checksums?: SourceInfoChecksums | null;
  defaultOpen?: boolean;
  lead?: ReactNode;
  onToggle?: (open: boolean) => void;
  open?: boolean;
  progress?: SourceInfoProgress | null;
  timing?: ReactNode;
}) => {
  const hasBytes = typeof bytes === "number" && Number.isFinite(bytes);
  if (!(hasBytes || checksums || lead || progress)) return null;
  const byteValue = hasBytes ? String(Math.floor(bytes as number)) : "";
  return (
    <ChecksumList
      defaultOpen={defaultOpen}
      label="Info"
      lead={progress ? <FileProgress {...progress} /> : lead}
      onToggle={onToggle}
      open={open}
      timing={timing}
    >
      <ChecksumRow copyValue={byteValue} label="BYTES" value={byteValue} />
      <ChecksumRow label="CRC32" value={checksums?.crc32 || ""} />
      <ChecksumRow label="MD5" value={checksums?.md5 || ""} />
      <ChecksumRow label="SHA-1" value={checksums?.sha1 || ""} />
    </ChecksumList>
  );
};

export { type SourceInfoChecksums, SourceInfoList, type SourceInfoProgress };
