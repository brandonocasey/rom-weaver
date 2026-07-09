import { describe, expect, it } from "vitest";
import { buildManifestApplySessionPlan } from "../../src/lib/manifest/manifest-session-model.ts";
import type { ParsedManifestParseResult } from "../../src/types/manifest.ts";

/**
 * `buildManifestApplySessionPlan` is the pure mapping from a parsed rw.json to the webapp's
 * acquisition/session plan. These cases lock the status seeding, the relative url/path resolution
 * against the manifest's own URL, the v1 exclusion of `disabled` entries, and the output-defaults
 * mapping onto the output card's name/compression/header controls.
 */

const MANIFEST_URL = "https://hacks.example/releases/rw.json";

const parsedResult = (overrides: Partial<ParsedManifestParseResult> = {}): ParsedManifestParseResult => ({
  manifest: { patches: [], version: 1 },
  patchSources: [],
  sourceKind: "json",
  warnings: [],
  ...overrides,
});

describe("buildManifestApplySessionPlan", () => {
  it("maps statuses, metadata, and header modes onto index-aligned entries", () => {
    const plan = buildManifestApplySessionPlan(
      parsedResult({
        manifest: {
          description: "Full rebalance",
          name: "Rebalance",
          patches: [
            { header: "strip", label: "stable", name: "Core", status: "required" },
            { description: "Extra maps", status: "default" },
            { status: "optional" },
          ],
          version: 1,
        },
        patchSources: [
          { source: { kind: "url", url: "https://cdn.example/core.ips" } },
          { source: { kind: "url", url: "maps.bps" } },
          { source: { kind: "url", url: "../optional/music.ups" } },
        ],
        warnings: ["ignored member: readme.txt"],
      }),
      MANIFEST_URL,
    );
    expect(plan.key).toBe(MANIFEST_URL);
    expect(plan.name).toBe("Rebalance");
    expect(plan.description).toBe("Full rebalance");
    expect(plan.warnings).toEqual(["ignored member: readme.txt"]);
    expect(plan.entries).toEqual([
      {
        acquisition: { kind: "url", url: "https://cdn.example/core.ips" },
        header: "strip",
        label: "stable",
        name: "Core",
        status: "required",
      },
      {
        acquisition: { kind: "url", url: "https://hacks.example/releases/maps.bps" },
        description: "Extra maps",
        status: "default",
      },
      {
        acquisition: { kind: "url", url: "https://hacks.example/optional/music.ups" },
        status: "optional",
      },
    ]);
  });

  it("resolves relative plain-manifest `path` entries as siblings of the rw.json", () => {
    const plan = buildManifestApplySessionPlan(
      parsedResult({
        manifest: {
          patches: [{ status: "default" }],
          rom: { path: "roms/game.bin" },
          version: 1,
        },
        patchSources: [{ source: { kind: "path", path: "change.ips" } }],
        romSource: { kind: "path", path: "roms/game.bin" },
      }),
      MANIFEST_URL,
    );
    expect(plan.romAcquisition).toEqual({ kind: "url", url: "https://hacks.example/releases/roms/game.bin" });
    expect(plan.entries[0]?.acquisition).toEqual({
      kind: "url",
      url: "https://hacks.example/releases/change.ips",
    });
  });

  it("passes extracted archive leaves through untouched", () => {
    const plan = buildManifestApplySessionPlan(
      parsedResult({
        manifest: { patches: [{ status: "required" }], version: 1 },
        patchSources: [{ source: { extractedPath: "/work/change.ips", kind: "extracted" } }],
        romSource: { extractedPath: "/work/game.bin", kind: "extracted" },
        sourceKind: "archive",
      }),
      MANIFEST_URL,
    );
    expect(plan.romAcquisition).toEqual({ extractedPath: "/work/game.bin", kind: "extracted" });
    expect(plan.entries[0]?.acquisition).toEqual({ extractedPath: "/work/change.ips", kind: "extracted" });
  });

  it("excludes disabled entries from acquisition entirely", () => {
    const plan = buildManifestApplySessionPlan(
      parsedResult({
        manifest: {
          patches: [
            { name: "Kept", status: "default" },
            { name: "Retired", status: "disabled" },
          ],
          version: 1,
        },
        patchSources: [{ source: { kind: "url", url: "kept.ips" } }, { source: { kind: "url", url: "retired.ips" } }],
      }),
      MANIFEST_URL,
    );
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]?.name).toBe("Kept");
  });

  it("maps output defaults: name, header, compress=false → none, compress format", () => {
    const withOutput = (output: NonNullable<ParsedManifestParseResult["manifest"]["output"]>) =>
      buildManifestApplySessionPlan(parsedResult({ manifest: { output, patches: [], version: 1 } }), MANIFEST_URL)
        .outputDefaults;
    expect(withOutput({ compress: { enabled: false }, header: "keep", name: "hack v2" })).toEqual({
      compression: "none",
      header: "keep",
      name: "hack v2",
    });
    expect(withOutput({ compress: { enabled: true, format: "zip", level: "max" } })).toEqual({
      compression: "zip",
    });
    // `compress: true` without a format keeps the UI's automatic choice.
    expect(withOutput({ compress: { enabled: true } })).toEqual({});
    expect(withOutput({})).toEqual({});
  });

  it("throws on an unresolvable relative source", () => {
    expect(() =>
      buildManifestApplySessionPlan(
        parsedResult({
          manifest: { patches: [{ status: "default" }], version: 1 },
          patchSources: [{ source: { kind: "url", url: "change.ips" } }],
        }),
        "not a url",
      ),
    ).toThrow(/not resolvable/);
  });
});
