import { parseIntegerInRange } from "../compression/compression-option-utils.ts";
import OutputCompressionManager from "../compression/output-compression-manager.ts";

const compressionManager = OutputCompressionManager;
const CODEC_WITH_OPTIONAL_LEVEL_REGEX = /^([a-z0-9_+-]+)(?::(\d+))?$/;

type CompressionSettingsSource = {
  compressionProfile?: string | null;
  rvzCodec?: string | null;
  rvzCompression?: string | null;
  rvzCompressionLevel?: string | number | null;
  z3dsCompressionLevel?: string | number | "default" | null;
  sevenZipCodec?: string | null;
  sevenZipLevel?: string | number | null;
  zipCodec?: string | null;
  zipLevel?: string | number | null;
};

type ParsedCodecLevel = {
  codec: string;
  level: number | null;
};

const parseCodecLevel = (
  value: string | null | undefined,
  fallback: string,
  normalizeCodec: (codec: string | null | undefined, fallback?: string) => string,
): ParsedCodecLevel => {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  const match = raw.match(CODEC_WITH_OPTIONAL_LEVEL_REGEX);
  if (!match) return { codec: normalizeCodec(value, fallback), level: null };
  return {
    codec: normalizeCodec(match[1] || fallback, fallback),
    level: match[2] === undefined ? null : parseInt(match[2], 10),
  };
};

const parseRvzCodecLevel = (value: string | null | undefined): ParsedCodecLevel => {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  const match = raw.match(CODEC_WITH_OPTIONAL_LEVEL_REGEX);
  if (!match) return { codec: compressionManager.normalizeRvzCompression(value || "zstd"), level: null };
  return {
    codec: compressionManager.normalizeRvzCompression(match[1] || "zstd"),
    level: match[2] === undefined ? null : parseInt(match[2], 10),
  };
};

const getCompressionProfileIndex = (validProfiles: string[], profile: string | null | undefined): number =>
  Math.max(0, validProfiles.indexOf(compressionManager.normalizeCompressionProfile(profile, "max")));

const getCompressionProfileFromIndex = (
  validProfiles: string[],
  value: string | number | null | undefined,
  fallback: string | null | undefined,
): string => {
  const index = parseInt(String(value), 10);
  return validProfiles[index] || compressionManager.normalizeCompressionProfile(fallback, "max");
};

const getCompressionProfileLabel = (profile: string | null | undefined): string => {
  const normalized = compressionManager.normalizeCompressionProfile(profile, "max");
  if (normalized === "min") return "Min";
  if (normalized === "very-low") return "Very Low";
  if (normalized === "low") return "Low";
  if (normalized === "medium") return "Medium";
  if (normalized === "high") return "High";
  if (normalized === "very-high") return "Very High";
  return "Max";
};

const getOptionalCompressionLevel = (
  value: string | number | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  const parsed = parseIntegerInRange(value, {
    allowEmpty: true,
    failureMessage: `Unsupported compression level: ${value}`,
    max,
    min,
    requireExactString: true,
  });
  return parsed === null ? fallback : parsed;
};

const resolveCompressionLevels = (source?: CompressionSettingsSource | null) => {
  const settings = source || {};
  const compressionProfile = compressionManager.normalizeCompressionProfile(settings.compressionProfile, "max");
  const rvzCodecSetting = parseRvzCodecLevel(settings.rvzCodec ?? settings.rvzCompression);
  const sevenZipCodecSetting = parseCodecLevel(
    settings.sevenZipCodec,
    "lzma2",
    compressionManager.normalizeSevenZipCodec,
  );
  const zipCodecSetting = parseCodecLevel(settings.zipCodec, "deflate", compressionManager.normalizeZipCodec);
  const rvzCompression = rvzCodecSetting.codec;
  const sevenZipCodec = sevenZipCodecSetting.codec;
  const zipCodec = zipCodecSetting.codec;
  const zipLevelMax = zipCodec === "zstd" ? 22 : 9;

  return {
    compressionProfile: compressionProfile,
    rvzCompression: rvzCompression,
    rvzCompressionLevel: getOptionalCompressionLevel(
      rvzCodecSetting.level ?? settings.rvzCompressionLevel,
      compressionManager.getCompressionProfileLevel(compressionProfile, rvzCompression),
      0,
      22,
    ),
    sevenZipCodec: sevenZipCodec,
    sevenZipLevel: getOptionalCompressionLevel(
      sevenZipCodecSetting.level ?? settings.sevenZipLevel,
      compressionManager.getCompressionProfileLevel(compressionProfile, sevenZipCodec, "7z"),
      0,
      9,
    ),
    z3dsCompressionLevel:
      settings.z3dsCompressionLevel === "default"
        ? "default"
        : getOptionalCompressionLevel(
            settings.z3dsCompressionLevel,
            compressionManager.getCompressionProfileLevel(compressionProfile, "zstd"),
            0,
            22,
          ),
    zipCodec: zipCodec,
    zipLevel:
      zipCodec === "store"
        ? 9
        : getOptionalCompressionLevel(
            zipCodecSetting.level ?? settings.zipLevel,
            compressionManager.getCompressionProfileLevel(compressionProfile, zipCodec, "zip"),
            0,
            zipLevelMax,
          ),
  };
};

export {
  getCompressionProfileFromIndex,
  getCompressionProfileIndex,
  getCompressionProfileLabel,
  getOptionalCompressionLevel,
  resolveCompressionLevels,
};
