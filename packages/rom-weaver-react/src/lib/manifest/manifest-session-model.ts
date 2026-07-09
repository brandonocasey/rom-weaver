// Pure mapping from a parsed rw.json manifest to the webapp's apply-session plan: which sources to
// acquire (URLs resolved against the manifest's own URL, or leaves already extracted from a bundled
// archive), the per-patch enablement seed, and the one-shot output defaults. No I/O here — the
// url-session boot flow feeds this into fetch/materialize and the apply form consumes the result.
import type { ManifestHeaderMode, ParsedManifestParseResult, ParsedManifestSourceRef } from "../../types/manifest.ts";

type ManifestAcquisition = { kind: "url"; url: string } | { kind: "extracted"; extractedPath: string };

/** Plan statuses exclude `disabled` — those entries are never acquired (see below). */
type ManifestPlanStatus = "required" | "default" | "optional";

type ManifestPlanEntry = {
  acquisition: ManifestAcquisition;
  name?: string;
  description?: string;
  label?: string;
  status: ManifestPlanStatus;
  header?: ManifestHeaderMode;
};

type ManifestOutputDefaults = {
  name?: string;
  /** "none" (manifest opted out of compression) or a compression format string. */
  compression?: string;
  header?: ManifestHeaderMode;
};

type ManifestApplySessionPlan = {
  /** Identity key for run-once guards (the manifest URL; the boot flow may suffix an attempt). */
  key: string;
  name?: string;
  description?: string;
  warnings: string[];
  romAcquisition?: ManifestAcquisition;
  /** Manifest order = apply order; index-aligned with the acquired patch files. */
  entries: ManifestPlanEntry[];
  outputDefaults: ManifestOutputDefaults;
};

/** A plan entry decorated with the acquired file's name (the drop-pipeline matching key). */
type ManifestApplySessionEntry = ManifestPlanEntry & { fileName: string };

/** The plan after acquisition, as handed to the apply form. */
type ManifestApplySession = Omit<ManifestApplySessionPlan, "entries" | "romAcquisition"> & {
  romFileName?: string;
  entries: ManifestApplySessionEntry[];
};

const resolveManifestRelativeUrl = (raw: string, manifestUrl: string, label: string): string => {
  try {
    // URL values are verbatim in the manifest; relative ones (and plain `path` entries, which are
    // siblings of the fetched rw.json) resolve against the manifest's own URL.
    return new URL(raw, manifestUrl).toString();
  } catch {
    throw new Error(`Manifest ${label} URL is not resolvable: ${raw}`);
  }
};

const toAcquisition = (source: ParsedManifestSourceRef, manifestUrl: string, label: string): ManifestAcquisition => {
  if (source.kind === "extracted") return { extractedPath: source.extractedPath, kind: "extracted" };
  if (source.kind === "url") return { kind: "url", url: resolveManifestRelativeUrl(source.url, manifestUrl, label) };
  return { kind: "url", url: resolveManifestRelativeUrl(source.path, manifestUrl, label) };
};

const toOutputDefaults = (parsed: ParsedManifestParseResult): ManifestOutputDefaults => {
  const output = parsed.manifest.output;
  if (!output) return {};
  const defaults: ManifestOutputDefaults = {};
  if (output.name) defaults.name = output.name;
  if (output.header) defaults.header = output.header;
  // Codecs/level are intentionally NOT mapped onto the UI defaults: the output card only models the
  // container format choice, and the per-format codec/level overrides come from Settings.
  if (output.compress) {
    if (!output.compress.enabled) defaults.compression = "none";
    else if (output.compress.format) defaults.compression = output.compress.format;
  }
  return defaults;
};

/**
 * Build the acquisition + session plan from a `manifest parse` result. Entries with status
 * `disabled` are EXCLUDED from acquisition entirely in v1: they are author-retired patches kept in
 * the manifest for provenance, and opting back in is the CLI's `--with` flow, not the webapp's.
 */
const buildManifestApplySessionPlan = (
  parsed: ParsedManifestParseResult,
  manifestUrl: string,
): ManifestApplySessionPlan => {
  const entries: ManifestPlanEntry[] = [];
  parsed.manifest.patches.forEach((patch, index) => {
    if (patch.status === "disabled") return;
    const patchSource = parsed.patchSources[index];
    if (!patchSource) throw new Error(`Manifest patch ${index + 1} has no resolved source`);
    entries.push({
      acquisition: toAcquisition(patchSource.source, manifestUrl, `patch ${index + 1}`),
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.description ? { description: patch.description } : {}),
      ...(patch.label ? { label: patch.label } : {}),
      status: patch.status,
      ...(patch.header ? { header: patch.header } : {}),
    });
  });
  return {
    entries,
    key: manifestUrl,
    ...(parsed.manifest.name ? { name: parsed.manifest.name } : {}),
    ...(parsed.manifest.description ? { description: parsed.manifest.description } : {}),
    outputDefaults: toOutputDefaults(parsed),
    ...(parsed.romSource ? { romAcquisition: toAcquisition(parsed.romSource, manifestUrl, "rom") } : {}),
    warnings: parsed.warnings.slice(),
  };
};

export type { ManifestApplySession, ManifestApplySessionEntry };
export { buildManifestApplySessionPlan };
