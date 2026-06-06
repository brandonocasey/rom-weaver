const REGEX_SPECIAL_CHARACTER_REGEX = /[\\^$.*+?()[\]{}|]/g;
const LEADING_EXTENSION_DOT_REGEX = /^\./;

const CHD_COMPRESSION_INPUT_EXTENSIONS = ["bin", "cue", "gdi", "iso"];
const CHD_DECOMPRESSION_INPUT_EXTENSIONS = ["chd"];
const RVZ_COMPRESSION_INPUT_EXTENSIONS = ["gcm", "iso", "wbfs"];
const RVZ_DECOMPRESSION_INPUT_EXTENSIONS = ["gcz", "rvz", "wia"];
const Z3DS_COMPRESSION_INPUT_EXTENSIONS = ["3ds", "3dsx", "app", "cci", "cia", "cxi"];
const Z3DS_DECOMPRESSION_INPUT_EXTENSIONS = ["z3ds", "z3dsx", "zcci", "zcia", "zcxi"];

const uniqueExtensions = (...extensionLists: readonly (readonly string[])[]) =>
  Array.from(new Set(extensionLists.flat()));

const ROM_SPECIFIC_COMPRESSION_INPUT_EXTENSIONS = uniqueExtensions(
  CHD_COMPRESSION_INPUT_EXTENSIONS,
  RVZ_COMPRESSION_INPUT_EXTENSIONS,
  Z3DS_COMPRESSION_INPUT_EXTENSIONS,
);
const ROM_SPECIFIC_DECOMPRESSION_INPUT_EXTENSIONS = uniqueExtensions(
  CHD_DECOMPRESSION_INPUT_EXTENSIONS,
  RVZ_DECOMPRESSION_INPUT_EXTENSIONS,
  Z3DS_DECOMPRESSION_INPUT_EXTENSIONS,
);
const ROM_SPECIFIC_INPUT_EXTENSIONS = uniqueExtensions(
  ROM_SPECIFIC_COMPRESSION_INPUT_EXTENSIONS,
  ROM_SPECIFIC_DECOMPRESSION_INPUT_EXTENSIONS,
);

const ROM_SPECIFIC_COMPRESSION_INPUT_EXTENSION_COUNTS = [
  CHD_COMPRESSION_INPUT_EXTENSIONS,
  RVZ_COMPRESSION_INPUT_EXTENSIONS,
  Z3DS_COMPRESSION_INPUT_EXTENSIONS,
]
  .flat()
  .reduce<Record<string, number>>((counts, extension) => {
    counts[extension] = (counts[extension] || 0) + 1;
    return counts;
  }, {});

const normalizeRomSpecificExtension = (extension: string | number | boolean | null | undefined) =>
  String(extension || "")
    .replace(LEADING_EXTENSION_DOT_REGEX, "")
    .toLowerCase();

const hasRomSpecificExtension = (
  extensions: readonly string[],
  extension: string | number | boolean | null | undefined,
): boolean => extensions.indexOf(normalizeRomSpecificExtension(extension)) !== -1;

const getUnambiguousRomSpecificCompressionInputExtensions = (extensions: readonly string[]): string[] =>
  extensions.filter(
    (extension) => ROM_SPECIFIC_COMPRESSION_INPUT_EXTENSION_COUNTS[normalizeRomSpecificExtension(extension)] === 1,
  );

const hasUnambiguousRomSpecificCompressionInputExtension = (
  extensions: readonly string[],
  extension: string | number | boolean | null | undefined,
): boolean => hasRomSpecificExtension(getUnambiguousRomSpecificCompressionInputExtensions(extensions), extension);

const createRomSpecificExtensionRegex = (extensions: readonly string[]): RegExp => {
  const pattern = extensions.map((extension) => extension.replace(REGEX_SPECIAL_CHARACTER_REGEX, "\\$&")).join("|");
  return new RegExp(`\\.(${pattern})(?:[?#].*)?$`, "i");
};

export {
  CHD_COMPRESSION_INPUT_EXTENSIONS,
  CHD_DECOMPRESSION_INPUT_EXTENSIONS,
  createRomSpecificExtensionRegex,
  getUnambiguousRomSpecificCompressionInputExtensions,
  hasRomSpecificExtension,
  hasUnambiguousRomSpecificCompressionInputExtension,
  normalizeRomSpecificExtension,
  ROM_SPECIFIC_COMPRESSION_INPUT_EXTENSIONS,
  ROM_SPECIFIC_DECOMPRESSION_INPUT_EXTENSIONS,
  ROM_SPECIFIC_INPUT_EXTENSIONS,
  RVZ_COMPRESSION_INPUT_EXTENSIONS,
  RVZ_DECOMPRESSION_INPUT_EXTENSIONS,
  Z3DS_COMPRESSION_INPUT_EXTENSIONS,
  Z3DS_DECOMPRESSION_INPUT_EXTENSIONS,
};
