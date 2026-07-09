import { createElement } from "react";
import { expect, test } from "vitest";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  installPatcherTestHooks,
  loadFixtureFile,
  mount,
  RAW_PATCH,
  RAW_ROM,
  setFormControlValue,
  waitForApplyButtonEnabled,
  waitForState,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

test("export manifest round-trips the staged session into an rw.json with computed checks", async () => {
  const [romFile, patchFile] = await Promise.all([loadFixtureFile(RAW_ROM), loadFixtureFile(RAW_PATCH)]);
  let exported = null;
  mount(
    createElement(ApplyPatchForm, {
      onManifestExportComplete: (result) => {
        exported = result;
      },
      pageDrop: { files: [romFile, patchFile], id: 1 },
    }),
  );
  await waitForApplyButtonEnabled();

  // The output-card secondary action arms once a ROM and a patch are staged.
  const exportButton = await waitForState(() => {
    const button = document.getElementById("rom-weaver-button-export-manifest");
    return button instanceof HTMLButtonElement && !button.disabled ? button : null;
  });
  expect(exportButton).not.toBeNull();
  exportButton.click();

  const nameInput = await waitForState(() => document.getElementById("rom-weaver-manifest-export-name"));
  expect(nameInput).not.toBeNull();
  setFormControlValue(nameInput, "Exported Hack");
  const statusSelect = document.getElementById("rom-weaver-manifest-export-status-0");
  expect(statusSelect).not.toBeNull();
  expect(statusSelect.value).toBe("default");
  setFormControlValue(statusSelect, "required");

  const runButton = document.getElementById("rom-weaver-manifest-export-run");
  expect(runButton).not.toBeNull();
  runButton.click();

  // The runtime create call resolves with the canonical manifest — assert on it directly rather
  // than intercepting the browser download.
  const result = await waitForState(() => exported, 60000);
  expect(result).not.toBeNull();
  expect(result.manifest.version).toBe(1);
  expect(result.manifest.name).toBe("Exported Hack");
  expect(result.manifestPath.endsWith("rw.json")).toBe(true);
  expect(result.manifest.rom?.path).toBe("game.bin");
  // ROM checks + patch integrity are computed from the actual staged bytes by Rust.
  expect(Object.keys(result.manifest.rom?.checks?.checksums || {}).length).toBeGreaterThan(0);
  expect(result.manifest.patches).toHaveLength(1);
  const patchEntry = result.manifest.patches[0];
  expect(patchEntry.path).toBe("change.ips");
  expect(patchEntry.status).toBe("required");
  expect(Object.keys(patchEntry.integrity || {}).length).toBeGreaterThan(0);

  // The dialog closes after a successful export.
  await expect.poll(() => document.getElementById("rom-weaver-manifest-export-run")).toBeNull();
});
