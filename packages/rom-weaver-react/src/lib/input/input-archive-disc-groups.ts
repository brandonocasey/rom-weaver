import { reportProgress } from "../progress/progress-reporting.ts";
import { type DiscGroupingEntryInput, runRomWeaverGroupDiscEntriesWorker } from "../runtime/wasm-command-runtime.ts";
import { isCueEntryFileName, isGdiEntryFileName } from "./archive.ts";
import { decodeUtf8, type PatchFileInstance } from "./binary-service.ts";
import {
  type ArchiveEntryLike,
  type ChdCodecMode,
  type CompressionEntryKindFilter,
  describeArchiveFileForTrace,
  extractArchiveEntryBytes,
  type InputPreparationOptions,
  type InputPreparationRuntimeLike,
  listCompressionEntryResult,
  traceArchivePreparation,
} from "./input-preparation-archive.ts";
import { DEFAULT_INPUT_PREPARATION_RUNTIME } from "./input-preparation-compression.ts";

const CHD_MERGED_SELECTION_PREFIX = "rom-weaver:chd-merged:";
const CHD_SPLIT_SELECTION_PREFIX = "rom-weaver:chd-split:";

const isBinEntryFileName = (fileName: string) => /\.bin$/i.test(String(fileName || ""));

const parseChdSplitSelection = (
  entryName: string | undefined,
): { chdSplitBin?: boolean; selectedEntryName?: string } => {
  const value = String(entryName || "");
  if (value.startsWith(CHD_SPLIT_SELECTION_PREFIX)) {
    return { chdSplitBin: true };
  }
  if (value.startsWith(CHD_MERGED_SELECTION_PREFIX)) {
    return { chdSplitBin: false };
  }
  return { selectedEntryName: value || undefined };
};

// A CHD disc lists its sheet as a `.cue` (CD-ROM) or `.gdi` (GD-ROM); both mark a
// multi-track disc that should auto-resolve to whole-disc split-bin extraction
// instead of prompting per track.
const getChdDiscSheetEntryName = (entries: ArchiveEntryLike[]) =>
  entries.find((entry) => isCueEntryFileName(entry.filename) || isGdiEntryFileName(entry.filename))?.filename || "";

const getChdBinEntries = (entries: ArchiveEntryLike[]) => entries.filter((entry) => isBinEntryFileName(entry.filename));

const reportChdCodecMode = (
  archiveFile: PatchFileInstance,
  options: InputPreparationOptions,
  chdMode: ChdCodecMode | null,
) => {
  if (!chdMode) return;
  reportProgress(options, {
    details: { chdMode },
    label: "Preparing CHD extraction...",
    percent: null,
    stage: "input",
  });
  traceArchivePreparation(options, "input.archive.chd-mode", {
    chdMode,
    file: describeArchiveFileForTrace(archiveFile),
  });
};

const resolveChdSplitBinSelection = async ({
  archiveFile,
  compressionFormat,
  kindFilter,
  options,
  runtime,
  selectedEntryName,
}: {
  archiveFile: PatchFileInstance;
  compressionFormat: string;
  kindFilter: CompressionEntryKindFilter;
  options: InputPreparationOptions;
  runtime: InputPreparationRuntimeLike;
  selectedEntryName?: string;
}): Promise<{ selectedEntryName?: string; chdMode?: ChdCodecMode; chdSplitBin?: boolean }> => {
  const parsedSelection = parseChdSplitSelection(selectedEntryName);
  if (parsedSelection.chdSplitBin !== undefined) return { ...parsedSelection, chdMode: "cd" };
  if (parsedSelection.selectedEntryName) return parsedSelection;
  if (compressionFormat !== "chd" || !kindFilter.romFilter || typeof options?.onCandidatesFound !== "function") {
    return parsedSelection;
  }

  const mergedResult = await listCompressionEntryResult(archiveFile, options, runtime, kindFilter, {
    chdSplitBin: false,
  });
  const splitResult = await listCompressionEntryResult(archiveFile, options, runtime, kindFilter, {
    chdSplitBin: true,
  });
  const chdMode = mergedResult.chdMode || splitResult.chdMode;
  reportChdCodecMode(archiveFile, options, chdMode);
  const mergedEntries = mergedResult.entries;
  const splitEntries = splitResult.entries;
  const mergedBinEntries = getChdBinEntries(mergedEntries);
  const splitBinEntries = getChdBinEntries(splitEntries);
  const cueEntryName = getChdDiscSheetEntryName(mergedEntries) || getChdDiscSheetEntryName(splitEntries);
  if (!(cueEntryName && mergedBinEntries.length === 1 && splitBinEntries.length > 1))
    return { ...parsedSelection, ...(chdMode ? { chdMode } : {}) };

  // A multi-track CD/GD disc is one logical ROM. Default to per-track split bins
  // — so each track gets its own checksums and can be patch-targeted, matching
  // how loose bin+cue discs are handled — instead of prompting Merged vs Split.
  return { chdMode: chdMode || "cd", chdSplitBin: true };
};

// Build the entry list Rust's `group-disc-entries` consumes: each listed entry's name + coarse type,
// plus the raw `.cue` text for cue sheets (Rust is no-I/O, so the host extracts the sheet bytes once
// here and passes the text). `.gdi` sheets carry no text — Rust groups them from sibling `track`
// entries. Unreadable cue text is left absent so Rust marks the group as an unreadable CUE.
const buildDiscGroupingEntries = async (
  archiveFile: PatchFileInstance,
  entries: ArchiveEntryLike[],
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike,
): Promise<DiscGroupingEntryInput[]> => {
  const groupingEntries: DiscGroupingEntryInput[] = [];
  for (const entry of entries) {
    const filename = String(entry.filename || "");
    if (!filename) continue;
    const groupingEntry: DiscGroupingEntryInput = { filename };
    if (entry.archiveEntryType) groupingEntry.archiveEntryType = entry.archiveEntryType;
    // Only read `.cue` text — and only when there are no synthetic track entries already (those
    // produce a synthetic group in Rust without parsing). A `.gdi` is never read here.
    const isSheetThatNeedsText =
      isCueEntryFileName(filename) && entry.archiveEntryType !== "cue" && entry.archiveEntryType !== "gdi";
    if (isSheetThatNeedsText) {
      try {
        groupingEntry.sheetText = decodeUtf8(
          await extractArchiveEntryBytes(archiveFile, filename, options, runtime, undefined, { romFilter: true }),
        );
      } catch (_error) {
        // Leave sheetText absent so Rust reports an unreadable CUE.
      }
    }
    groupingEntries.push(groupingEntry);
  }
  return groupingEntries;
};

// Resolve the single ROM entry to auto-select from a container's ROM entries when no explicit
// selection was given, delegating the disc grouping (CUE/GDI reference resolution, identical
// track-set dedup) and the auto-pick decision tree to Rust's `group-disc-entries` command. Throws
// when Rust reports the source is ambiguous (multiple competing input candidates), matching the
// prior behavior so the caller falls through to the interactive ROM descent prompt.
const resolveCompressionRomAutoPickEntryName = async (
  archiveFile: PatchFileInstance,
  entries: ArchiveEntryLike[],
  options: InputPreparationOptions,
  runtime: InputPreparationRuntimeLike = DEFAULT_INPUT_PREPARATION_RUNTIME,
): Promise<string | null> => {
  if (!entries.length) return null;
  const groupingEntries = await buildDiscGroupingEntries(archiveFile, entries, options, runtime);
  const result = await runRomWeaverGroupDiscEntriesWorker({
    entries: groupingEntries,
    logLevel: options?.logging?.level,
    sourceName: archiveFile.fileName,
  });
  traceArchivePreparation(options, "input.archive.disc-grouping", {
    ambiguous: result.autoPick.ambiguous,
    autoPick: result.autoPick.entryName || "",
    discGroups: result.discGroups.length,
    file: describeArchiveFileForTrace(archiveFile),
    standalones: result.standaloneEntries.length,
  });
  if (result.autoPick.ambiguous) {
    throw new Error(`${archiveFile.fileName || "Archive"} contains multiple input candidates`);
  }
  return result.autoPick.entryName;
};

export { resolveChdSplitBinSelection, resolveCompressionRomAutoPickEntryName };
