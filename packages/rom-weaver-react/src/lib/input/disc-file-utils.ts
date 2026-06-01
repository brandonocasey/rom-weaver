import {
  getSingleTrackCdExtractionPlan,
  parseCueFile,
  replaceCuePatchFileName,
} from "../../workers/protocol/cue-file-utils.ts";
import {
  DISC_COMPRESSION_FORMAT_REGISTRY,
  getDiscExtractedFileName,
  getFileExtension,
  hasDiscCompressionFormatExtension,
} from "../compression/container-format-registry.ts";

const BIN_EXTENSION_REGEX = /\.bin$/i;
const CUE_EXTENSION_REGEX = /\.cue$/i;

type ByteInspectableSource = {
  _u8array?: Uint8Array;
  fileName?: string;
  getExtension?: () => string;
  readIntoAt?: (buffer: Uint8Array, bufferOffset?: number, len?: number, fileOffset?: number) => number | undefined;
};

const getSourceBytes = (source: unknown, length: number): Uint8Array | null => {
  if (source instanceof ArrayBuffer) return new Uint8Array(source, 0, Math.min(length, source.byteLength));
  if (ArrayBuffer.isView(source))
    return new Uint8Array(source.buffer, source.byteOffset, Math.min(length, source.byteLength));
  if (!source || typeof source !== "object") return null;
  const inspectable = source as ByteInspectableSource;
  if (inspectable._u8array instanceof Uint8Array) return inspectable._u8array.subarray(0, length);
  if (typeof inspectable.readIntoAt === "function") {
    const buffer = new Uint8Array(length);
    const read = inspectable.readIntoAt(buffer, 0, length, 0);
    return typeof read === "number" ? buffer.subarray(0, read) : buffer;
  }
  return null;
};

const hasAsciiMagic = (source: unknown, magic: string): boolean => {
  const bytes = getSourceBytes(source, magic.length);
  if (!bytes || bytes.byteLength < magic.length) return false;
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[index] !== magic.charCodeAt(index)) return false;
  }
  return true;
};

const isDiscFormatFile = (format: keyof typeof DISC_COMPRESSION_FORMAT_REGISTRY, source: unknown): boolean => {
  const registration = DISC_COMPRESSION_FORMAT_REGISTRY[format];
  const inspectableSource = source as ByteInspectableSource | null | undefined;
  return (
    registration.extensionRegex.test(String(inspectableSource?.fileName || "")) ||
    hasDiscCompressionFormatExtension(format, getFileExtension(inspectableSource)) ||
    hasAsciiMagic(source, registration.magic)
  );
};

const isChdFile = (source: unknown): boolean => isDiscFormatFile("chd", source);

const isRvzFile = (source: unknown): boolean => isDiscFormatFile("rvz", source);

const isZ3dsFile = (source: unknown): boolean => isDiscFormatFile("z3ds", source);

const getChdAutoCreateMode = (
  source: ByteInspectableSource & { _chdCuePath?: string; _chdCueText?: string; _chdMode?: string },
): string => {
  if (source._chdMode === "cd" || source._chdCuePath || source._chdCueText) return "cd";
  if (source._chdMode === "dvd") return "dvd";
  const fileName = String(source.fileName || "");
  return CUE_EXTENSION_REGEX.test(fileName) || BIN_EXTENSION_REGEX.test(fileName) ? "cd" : "dvd";
};

export {
  getChdAutoCreateMode,
  getDiscExtractedFileName,
  getSingleTrackCdExtractionPlan,
  isChdFile,
  isRvzFile,
  isZ3dsFile,
  parseCueFile,
  replaceCuePatchFileName,
};
