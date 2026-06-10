import type { ReactNode } from "react";
import type { ChecksumVariant } from "../../../../types/checksum.ts";
import { ChecksumList, ChecksumRow } from "./checksum-list.tsx";
import { FileProgress } from "./feedback.tsx";

type SourceInfoChecksums = {
  crc32?: string;
  md5?: string;
  sha1?: string;
};

type SourceInfoProgress = Parameters<typeof FileProgress>[0];

const CHECKSUM_VARIANT_ALGORITHMS = [
  ["crc32", "CRC32"],
  ["md5", "MD5"],
  ["sha1", "SHA-1"],
] as const;

const getVariantStrippedBytes = (variant: ChecksumVariant): number => {
  const removeHeader = (variant.transforms as { removeHeader?: { strippedBytes?: unknown } } | undefined)?.removeHeader;
  const stripped = removeHeader?.strippedBytes;
  return typeof stripped === "number" && Number.isFinite(stripped) ? stripped : 0;
};

// remove-header drops the leading header bytes; the other transforms keep the
// byte count, so the variant's size is the source size minus any stripped header.
const getVariantBytes = (variant: ChecksumVariant, sourceBytes: number | undefined): string => {
  if (typeof sourceBytes !== "number" || !Number.isFinite(sourceBytes)) return "";
  const stripped = variant.id === "remove-header" ? getVariantStrippedBytes(variant) : 0;
  return String(Math.max(0, Math.floor(sourceBytes) - stripped));
};

const VariantInfoList = ({ bytes, variants }: { bytes?: number; variants?: ChecksumVariant[] }) => {
  const rows = (variants || []).filter((variant) => variant.id !== "raw");
  if (!rows.length) return null;
  return (
    <ChecksumList defaultOpen={false} label="Variants">
      {rows.map((variant) => {
        const byteValue = getVariantBytes(variant, bytes);
        return (
          <div className="ck-group" key={variant.id}>
            <div className="ck-group-head">{variant.label}</div>
            {byteValue ? <ChecksumRow copyValue={byteValue} label="BYTES" value={byteValue} /> : null}
            {CHECKSUM_VARIANT_ALGORITHMS.map(([algorithm, algorithmLabel]) => {
              const value = variant.checksums?.[algorithm] || "";
              if (!value) return null;
              return <ChecksumRow key={algorithm} label={algorithmLabel} value={value} />;
            })}
          </div>
        );
      })}
    </ChecksumList>
  );
};

const SourceInfoList = ({
  bytes,
  checksums,
  checksumVariants,
  defaultOpen = false,
  discType,
  lead,
  onToggle,
  open,
  progress,
  timing,
}: {
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
}) => {
  const hasBytes = typeof bytes === "number" && Number.isFinite(bytes);
  if (!(hasBytes || checksums || discType || lead || progress)) return null;
  const byteValue = hasBytes ? String(Math.floor(bytes as number)) : "";
  return (
    <>
      <ChecksumList
        defaultOpen={defaultOpen}
        label="Info"
        lead={progress ? <FileProgress {...progress} /> : lead}
        onToggle={onToggle}
        open={open}
        timing={timing}
      >
        {discType ? <ChecksumRow copyValue={discType} label="DISC" value={discType} /> : null}
        <ChecksumRow copyValue={byteValue} label="BYTES" value={byteValue} />
        <ChecksumRow label="CRC32" value={checksums?.crc32 || ""} />
        <ChecksumRow label="MD5" value={checksums?.md5 || ""} />
        <ChecksumRow label="SHA-1" value={checksums?.sha1 || ""} />
      </ChecksumList>
      <VariantInfoList bytes={bytes} variants={checksumVariants} />
    </>
  );
};

export { type SourceInfoChecksums, SourceInfoList, type SourceInfoProgress };
