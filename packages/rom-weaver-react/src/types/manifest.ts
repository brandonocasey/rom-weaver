// Webapp-facing result shapes for the `manifest parse` / `manifest create` commands. The generated
// wire types carry snake_case fields (and `u64` values that `JSON.parse` yields as plain `number`s);
// these camelCase, `number`-based types are what the webapp consumes. Kept in `types/` (not `lib/`)
// so the runtime adapter type can reference them without an import cycle (mirrors `types/ingest.ts`).
import type { ParsedPatchDescriptor } from "./ingest.ts";

type ManifestPatchStatus = "required" | "default" | "optional" | "disabled";
type ManifestHeaderMode = "keep" | "strip" | "auto";
type ManifestSourceKind = "json" | "compressed-json" | "archive";

/** One resolved manifest source: a verbatim URL, a leaf extracted from a bundled
 * archive (already materialized under the parse call's extract dir), or an
 * unresolved manifest-relative path (plain rw.json siblings the host fetches). */
type ParsedManifestSourceRef =
  | { kind: "url"; url: string }
  | { kind: "extracted"; extractedPath: string }
  | { kind: "path"; path: string };

type ParsedManifestChecks = {
  checksums?: Record<string, string>;
  size?: number;
};

type ParsedManifestRom = {
  name?: string;
  url?: string;
  path?: string;
  checks?: ParsedManifestChecks;
};

type ParsedManifestPatchEntry = {
  name?: string;
  description?: string;
  status: ManifestPatchStatus;
  label?: string;
  url?: string;
  path?: string;
  checks?: ParsedManifestChecks;
  /** Checksums of the patch FILE itself (verifies downloaded bytes; distinct from `checks`). */
  integrity?: Record<string, string>;
  header?: ManifestHeaderMode;
};

type ParsedManifestOutputCompress = {
  enabled: boolean;
  format?: string;
  codecs?: string[];
  level?: string;
};

type ParsedManifestOutput = {
  name?: string;
  header?: ManifestHeaderMode;
  compress?: ParsedManifestOutputCompress;
};

type ParsedManifest = {
  version: number;
  name?: string;
  description?: string;
  rom?: ParsedManifestRom;
  /** Ordered: array order is the apply order. */
  patches: ParsedManifestPatchEntry[];
  output?: ParsedManifestOutput;
};

type ParsedManifestPatchSource = {
  source: ParsedManifestSourceRef;
  /** Ingest-grade descriptor for entries extracted from a bundled archive. */
  descriptor?: ParsedPatchDescriptor;
};

type ParsedManifestParseResult = {
  manifest: ParsedManifest;
  sourceKind: ManifestSourceKind;
  archiveMember?: string;
  romSource?: ParsedManifestSourceRef;
  /** Index-aligned with `manifest.patches`. */
  patchSources: ParsedManifestPatchSource[];
  warnings: string[];
};

type ParsedManifestCreateResult = {
  manifestPath: string;
  bundlePath?: string;
  manifest: ParsedManifest;
  warnings: string[];
};

export type {
  ManifestHeaderMode,
  ManifestPatchStatus,
  ManifestSourceKind,
  ParsedManifest,
  ParsedManifestChecks,
  ParsedManifestCreateResult,
  ParsedManifestOutput,
  ParsedManifestParseResult,
  ParsedManifestPatchEntry,
  ParsedManifestPatchSource,
  ParsedManifestRom,
  ParsedManifestSourceRef,
};
