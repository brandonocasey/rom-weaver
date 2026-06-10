import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, test } from "vitest";
import { getDiscKind, getDiscKindLabel } from "../../src/lib/input/rom-specific-file-utils.ts";
import { RomInputPanels } from "../../src/public/react/components/ds/rom-input-panels.tsx";
import { buildCompressPanel } from "../../src/public/react/compress-options.ts";

let mountedRoot = null;
let rootElement = null;

beforeEach(() => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  rootElement = document.createElement("div");
  document.body.replaceChildren(rootElement);
});

const GD_CUE_TEXT =
  "REM SINGLE-DENSITY AREA\n" +
  'FILE "track01.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n' +
  "REM HIGH-DENSITY AREA\n" +
  'FILE "track03.bin" BINARY\n  TRACK 03 MODE1/2352\n    INDEX 01 00:00:00\n';

const CD_CUE_TEXT = 'FILE "disc.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n';

test("getDiscKind detects GD-ROM from high-density cue markers", () => {
  expect(getDiscKind({ cueText: GD_CUE_TEXT, fileName: "game.cue" })).toBe("gd");
  expect(getDiscKindLabel(getDiscKind({ cueText: GD_CUE_TEXT }))).toBe("GD-ROM");
});

test("getDiscKind detects GD-ROM from a .gdi file name", () => {
  expect(getDiscKind({ fileName: "game.gdi" })).toBe("gd");
});

test("getDiscKind treats a plain multi-track cue as CD-ROM", () => {
  expect(getDiscKind({ cueText: CD_CUE_TEXT, fileName: "disc.cue" })).toBe("cd");
  expect(getDiscKindLabel(getDiscKind({ fileName: "disc.bin" }))).toBe("CD-ROM");
});

test("getDiscKind returns null for non-disc sources", () => {
  expect(getDiscKind({ fileName: "rom.sfc" })).toBeNull();
  expect(getDiscKind({})).toBeNull();
});

test("CHD output panel summary surfaces the detected disc type", () => {
  const gdPanel = buildCompressPanel("chd", {}, { _chdCueText: GD_CUE_TEXT, fileName: "game.cue" });
  expect(gdPanel?.summary).toMatch(/^GD-ROM ·/);

  const cdPanel = buildCompressPanel("chd", {}, { _chdCueText: CD_CUE_TEXT, fileName: "disc.cue" });
  expect(cdPanel?.summary).toMatch(/^CD-ROM ·/);
});

test("source Info panel renders the detected disc type row", async () => {
  mountedRoot = createRoot(rootElement);
  mountedRoot.render(
    createElement(RomInputPanels, {
      cue: { cueText: GD_CUE_TEXT },
      info: { bytes: 1024, defaultOpen: true },
      showCue: false,
      showFixes: false,
    }),
  );
  await expect.poll(() => rootElement.textContent || "").toContain("DISC");
  expect(rootElement.textContent || "").toContain("GD-ROM");
});
