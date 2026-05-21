import {
  CHD_CODEC_LEVEL_MAX,
  canUseThreadedWasm,
  getDefaultBrowserThreadCount,
  normalizeBrowserThreadCount,
  normalizeCodecList,
  normalizeCodecListWithFallback,
  normalizeIntegerInRange,
  parseIntegerInRange,
} from "../../lib/compression/compression-option-utils.ts";
import {
  getCompressionProfileFromIndex,
  getCompressionProfileIndex,
  getCompressionProfileLabel,
  resolveCompressionLevels,
} from "../../lib/compression/compression-settings.ts";
import OutputCompressionManager from "../../lib/compression/output-compression-manager.ts";

const {
  COMPRESSION_PROFILES,
  SEVEN_ZIP_COMPRESSION_METHODS,
  ZIP_COMPRESSION_METHODS,
  getChdCodecsForMode,
  normalizeArchiveCompressionLevelForFormat,
  normalizeCompressionProfile,
  normalizeSevenZipCodec,
  normalizeZipCodec,
} = OutputCompressionManager;

export {
  CHD_CODEC_LEVEL_MAX,
  COMPRESSION_PROFILES,
  canUseThreadedWasm,
  getChdCodecsForMode,
  getCompressionProfileFromIndex,
  getCompressionProfileIndex,
  getCompressionProfileLabel,
  getDefaultBrowserThreadCount,
  normalizeArchiveCompressionLevelForFormat,
  normalizeBrowserThreadCount,
  normalizeCodecList,
  normalizeCodecListWithFallback,
  normalizeCompressionProfile,
  normalizeIntegerInRange,
  normalizeSevenZipCodec,
  normalizeZipCodec,
  parseIntegerInRange,
  resolveCompressionLevels,
  SEVEN_ZIP_COMPRESSION_METHODS,
  ZIP_COMPRESSION_METHODS,
};
