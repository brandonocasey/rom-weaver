import { parseCompressionCodecEntry } from "../compression/codec-parser.ts";
import { isCompressionLevelProfile } from "../path-utils.ts";

type PushCodecEntry = (entry: string) => void;

const collectCodecString = (candidate: string, push: PushCodecEntry) => {
  for (const entry of candidate.split(/[,+]/)) push(entry);
};

const getCodecObjectEntry = (name: string, value: unknown): string | null => {
  if (!name || value == null || value === false) return null;
  if (value === true) return name;
  if (typeof value === "number") return Number.isFinite(value) ? `${name}:${Math.floor(value)}` : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized === "0" || normalized.toLowerCase() === "false") return null;
  return normalized.toLowerCase() === "true" ? name : `${name}:${normalized}`;
};

const collectCodecObject = (candidate: Record<string, unknown>, push: PushCodecEntry) => {
  for (const [codecName, codecValue] of Object.entries(candidate)) {
    const name = codecName.trim();
    const entry = getCodecObjectEntry(name, codecValue);
    if (entry) push(entry);
  }
};

const collectCodecValue = (candidate: unknown, push: PushCodecEntry): void => {
  if (candidate == null) return;
  if (Array.isArray(candidate)) {
    for (const entry of candidate) collectCodecValue(entry, push);
    return;
  }
  if (typeof candidate === "string") {
    collectCodecString(candidate, push);
    return;
  }
  if (typeof candidate === "number") {
    if (Number.isFinite(candidate)) push(String(Math.floor(candidate)));
    return;
  }
  if (typeof candidate === "object") collectCodecObject(candidate as Record<string, unknown>, push);
};

const normalizeCodecEntries = (value: unknown): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (entry: string) => {
    const normalized = String(entry || "").trim();
    if (!normalized) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  collectCodecValue(value, push);
  return out;
};

const normalizeCompressionLevelProfile = (value: unknown): string | null => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  return isCompressionLevelProfile(normalized) ? normalized : null;
};

const normalizeChdCodecArgs = (codecs: string[]) => {
  const explicitLevels = new Set<string>();
  const strippedCodecs: string[] = [];
  const strippedSeen = new Set<string>();
  for (const codecEntry of codecs) {
    const trimmed = String(codecEntry || "").trim();
    if (!trimmed) continue;
    const parsed = parseCompressionCodecEntry(trimmed);
    if (!parsed) {
      if (!strippedSeen.has(trimmed)) {
        strippedSeen.add(trimmed);
        strippedCodecs.push(trimmed);
      }
      continue;
    }
    const codecName = parsed.codec || trimmed;
    if (parsed.levelText !== null) explicitLevels.add(parsed.levelText);
    if (!strippedSeen.has(codecName)) {
      strippedSeen.add(codecName);
      strippedCodecs.push(codecName);
    }
  }

  // CHD codec sets cannot mix per-codec levels; keep user codec order but remove level suffixes on conflicts.
  if (explicitLevels.size <= 1) return { codecs, stripped: false };
  return { codecs: strippedCodecs, stripped: true };
};

const isChdCompressionFormat = (format: string): boolean => {
  const normalized = format.trim().toLowerCase();
  return normalized === "chd" || normalized.startsWith("chd-");
};

export { isChdCompressionFormat, normalizeChdCodecArgs, normalizeCodecEntries, normalizeCompressionLevelProfile };
