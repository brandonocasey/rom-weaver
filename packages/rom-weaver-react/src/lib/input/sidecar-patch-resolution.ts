import { runRomWeaverMatchSidecarsWorker } from "../runtime/wasm-command-runtime.ts";

const PATH_DIRECTORY_PREFIX_REGEX = /^.*[/\\]/;

type SidecarPatchEntry = {
  filename?: string;
  fileName?: string;
  name?: string;
};

type ResolvedSidecarPatch<TEntry extends SidecarPatchEntry> = {
  entry: TEntry;
  fileName: string;
  order: number;
  outputLabel?: string;
};

const BRACKET_LABEL_PATTERN = /\[([^\]]+)\](?:\.[^.]+)?\d*$/;

const getSidecarEntryFileName = (entry: SidecarPatchEntry | string | null | undefined): string => {
  if (typeof entry === "string") return entry;
  if (!entry) return "";
  return String(entry.filename || entry.fileName || entry.name || "");
};

// Display-only: a `[Label]` tag in the patch name becomes the generated output name. Not part of the
// match rule (Rust owns that), so it stays on the host side.
const getSidecarPatchOutputLabel = (fileName: string): string | undefined => {
  const baseName = String(fileName || "").replace(PATH_DIRECTORY_PREFIX_REGEX, "");
  const match = baseName.match(BRACKET_LABEL_PATTERN);
  const label = match?.[1]?.trim();
  return label || undefined;
};

/**
 * Resolve the RetroArch/libretro sidecar patches for a ROM by delegating the `<rom-stem>.<patch-ext>`
 * match to Rust's `match-sidecars` command (the single source of truth, shared with the native CLI), then
 * mapping the matched names back to the caller's entries. Rust returns them already sorted in apply order.
 */
const resolveSidecarPatchEntries = async <TEntry extends SidecarPatchEntry>(
  romFileName: string,
  entries: TEntry[],
): Promise<Array<ResolvedSidecarPatch<TEntry>>> => {
  if (!entries.length) return [];
  const byName = new Map<string, TEntry>();
  const patchNames: string[] = [];
  for (const entry of entries) {
    const fileName = getSidecarEntryFileName(entry);
    if (!fileName || byName.has(fileName)) continue;
    byName.set(fileName, entry);
    patchNames.push(fileName);
  }
  const matches = await runRomWeaverMatchSidecarsWorker({ patchNames, romName: romFileName });
  const resolved: Array<ResolvedSidecarPatch<TEntry>> = [];
  for (const match of matches) {
    const entry = byName.get(match.name);
    if (!entry) continue;
    resolved.push({
      entry,
      fileName: match.name,
      order: match.order,
      outputLabel: getSidecarPatchOutputLabel(match.name),
    });
  }
  return resolved;
};

const applySidecarPatchOutputLabel = <TFile extends { fileName?: string }>(
  file: TFile,
  outputLabel?: string,
): TFile => {
  if (outputLabel) (file as TFile & { _generatedPatchName?: string })._generatedPatchName = outputLabel;
  return file;
};

export { applySidecarPatchOutputLabel, resolveSidecarPatchEntries };
