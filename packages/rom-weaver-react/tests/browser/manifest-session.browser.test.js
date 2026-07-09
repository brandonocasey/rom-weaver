import { createElement } from "react";
import { expect, test } from "vitest";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { loadManifestUrlSession } from "../../src/webapp/url-session/manifest-url-session.ts";
import {
  clickApplyButton,
  getOutputFileNameValue,
  getPatchStackFileNames,
  installPatcherTestHooks,
  mount,
  RAW_PATCH,
  RAW_ROM,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

const ALTERNATE_PATCH = "tests/fixtures/archive_sources/multi-patch/alternate.ips";
const MANIFEST_URL = `${location.origin}/virtual/manifest/rw.json`;

// The manifest's sources are real same-origin fixture URLs (only the rw.json itself is virtual, so
// fetch is stubbed for that one URL and passed through for everything else).
const MANIFEST_JSON = {
  description: "Session-driven apply",
  name: "Manifest Test Hack",
  output: { compress: false, name: "manifest-output" },
  patches: [
    {
      description: "Required core patch",
      label: "stable",
      name: "Core",
      status: "required",
      url: `${location.origin}/${RAW_PATCH}`,
    },
    { name: "Alternate", status: "optional", url: `${location.origin}/${ALTERNATE_PATCH}` },
  ],
  rom: { url: `${location.origin}/${RAW_ROM}` },
  version: 1,
};

const withManifestFetchStub = async (manifest, run) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    if (url === MANIFEST_URL) {
      return Promise.resolve(
        new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json" }, status: 200 }),
      );
    }
    return originalFetch(input, init);
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const getPatchToggles = () => Array.from(document.querySelectorAll("#rom-weaver-list-patch-stack .patch-enable input"));

test("manifest url session seeds enablement + output defaults and applies to a download", async () => {
  // The REAL boot flow: fetch → wasm manifest parse → plan → source acquisition (same code the
  // use-url-session-boot hook runs).
  const { files, session } = await withManifestFetchStub(MANIFEST_JSON, () => loadManifestUrlSession(MANIFEST_URL));
  expect(files.map((file) => file.name)).toEqual(["game.bin", "change.ips", "alternate.ips"]);
  expect(session.name).toBe("Manifest Test Hack");
  expect(session.entries.map((entry) => entry.status)).toEqual(["required", "optional"]);
  expect(session.outputDefaults).toEqual({ compression: "none", name: "manifest-output" });

  // Deliver exactly like WebappRoot does: one pageDrop plus the decorated session prop.
  mount(
    createElement(ApplyPatchForm, {
      manifestSession: session,
      pageDrop: { files, id: 1 },
    }),
  );

  // Patches land in manifest order.
  await expect.poll(() => getPatchStackFileNames(), { timeout: 30000 }).toEqual(["change.ips", "alternate.ips"]);
  await expect.poll(() => getPatchToggles().length, { timeout: 30000 }).toBe(2);
  // Required patch: On with the toggle locked.
  await expect.poll(() => getPatchToggles()[0]?.disabled, { timeout: 30000 }).toBe(true);
  expect(getPatchToggles()[0]?.checked).toBe(true);
  // Optional patch: starts Off, stays toggleable.
  await expect.poll(() => getPatchToggles()[1]?.checked, { timeout: 30000 }).toBe(false);
  expect(getPatchToggles()[1]?.disabled).toBe(false);
  getPatchToggles()[1]?.click();
  await expect.poll(() => getPatchToggles()[1]?.checked).toBe(true);
  getPatchToggles()[1]?.click();
  await expect.poll(() => getPatchToggles()[1]?.checked).toBe(false);
  // Manifest metadata reaches the patch cards (label chip + description line).
  const patchStackText = () => document.getElementById("rom-weaver-list-patch-stack")?.textContent || "";
  expect(patchStackText()).toContain("stable");
  expect(patchStackText()).toContain("Required core patch");
  // Output defaults applied once through the output controller.
  await expect.poll(() => getOutputFileNameValue(), { timeout: 30000 }).toBe("manifest-output");

  await waitForApplyButtonEnabled();
  await clickApplyButton();
  const outcome = await waitForApplyOutcome();
  expect(outcome).toEqual({ kind: "download" });
});
