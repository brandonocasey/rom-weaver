import { createElement } from "react";
import { expect, test } from "vitest";
import { fetchRemoteFiles, RemoteFetchError } from "../../src/lib/remote/remote-file-fetch.ts";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import {
  clickApplyButton,
  getInputStackRows,
  getPatchStackFileNames,
  installPatcherTestHooks,
  mount,
  RAW_PATCH,
  RAW_ROM,
  waitForApplyButtonEnabled,
  waitForApplyOutcome,
} from "./patcher-test-shared.js";

installPatcherTestHooks();

test("url-session files fetched from same-origin urls flow through the drop pipeline to a green apply", async () => {
  // Same-origin fixture URLs stand in for a distributor's CORS-enabled host.
  const fetched = await fetchRemoteFiles([
    { url: `${location.origin}/${RAW_ROM}` },
    { url: `${location.origin}/${RAW_PATCH}` },
  ]);
  expect(fetched.map((entry) => entry.file.name)).toEqual(["game.bin", "change.ips"]);

  // Deliver exactly like the WebappRoot url-session boot does: one pageDrop.
  mount(
    createElement(ApplyPatchForm, {
      pageDrop: { files: fetched.map((entry) => entry.file), id: 1 },
    }),
  );

  await expect.poll(() => getInputStackRows().length, { timeout: 30000 }).toBe(1);
  await expect.poll(() => getPatchStackFileNames(), { timeout: 30000 }).toEqual(["change.ips"]);
  await waitForApplyButtonEnabled();
  await clickApplyButton();
  const outcome = await waitForApplyOutcome();
  expect(outcome).toEqual({ kind: "download" });
});

test("remote fetch reports http failures and CORS-shaped blocks as coded errors", async () => {
  const originalFetch = globalThis.fetch;
  // The vitest dev server SPA-fallbacks unknown paths, so stub a real 404.
  globalThis.fetch = () => Promise.resolve(new Response("missing", { status: 404 }));
  try {
    const missing = await fetchRemoteFiles([{ url: `${location.origin}/tests/fixtures/does-not-exist.bin` }]).catch(
      (error) => error,
    );
    expect(missing).toBeInstanceOf(RemoteFetchError);
    expect(missing.kind).toBe("http");
    expect(missing.status).toBe(404);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
  try {
    const blocked = await fetchRemoteFiles([{ url: "https://blocked.example/rom.bin" }]).catch((error) => error);
    expect(blocked).toBeInstanceOf(RemoteFetchError);
    expect(blocked.kind).toBe("blocked");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
