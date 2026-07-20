import type { InputParentCompression } from "./input-assets.ts";

// Bundle parsing extracts an embedded ROM outside the normal decompression
// path. Key its synthetic bundle→ROM breadcrumb by File identity (staging
// rewrites paths) so the card still renders an Extract chain.
//
// Generic `archive` keeps the breadcrumb display-only and out of compression
// inference. WeakMap ties cleanup to the File.
const bundleRomProvenanceByFile = new WeakMap<object, InputParentCompression[]>();

const setBundleRomProvenance = (romFile: object | undefined, parentCompressions: InputParentCompression[]): void => {
  if (!romFile || parentCompressions.length === 0) return;
  bundleRomProvenanceByFile.set(romFile, parentCompressions);
};

const getBundleRomProvenance = (romFile: unknown): InputParentCompression[] | undefined => {
  if (!romFile || typeof romFile !== "object") return undefined;
  return bundleRomProvenanceByFile.get(romFile);
};

export { getBundleRomProvenance, setBundleRomProvenance };
