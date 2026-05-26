import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ApplyPatchForm } from "../../src/public/react/index.tsx";
import { resetRomWeaverRunner, warmupRomWeaverRunner } from "../../src/workers/rom-weaver/rom-weaver-runner.ts";

const POSIX_DIRECTORY_PREFIX_REGEX = /^.*\//;
const RAW_ROM = "tests/fixtures/archive_sources/game.bin";
const RAW_PATCH = "tests/fixtures/archive_sources/change.ips";
const ONE_PATCH_7Z = "tests/fixtures/archives/one-patch.7z";
const MULTI_ROM_ZIP = "tests/fixtures/archives/multi-rom.zip";
const RVZ_INPUT = "tests/fixtures/browser-generated/game.rvz";
const CHD_INPUT = "tests/fixtures/browser-generated/game-cd.chd";
const WRONG_INPUT_BPS = "tests/fixtures/browser-generated/wrong-input-same-size.bps";

let mountedRoot = null;

const getRoot = () => {
  const existing = document.getElementById("app");
  if (existing) return existing;
  const element = document.createElement("div");
  element.id = "app";
  document.body.appendChild(element);
  return element;
};

const mount = (element) => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  const root = createRoot(getRoot());
  root.render(element);
  mountedRoot = root;
  return root;
};

const fileNameFromPath = (filePath) => filePath.replace(POSIX_DIRECTORY_PREFIX_REGEX, "");

const loadFixtureFile = async (filePath, type = "application/octet-stream") => {
  const response = await fetch(`/${filePath}`);
  if (!response.ok) throw new Error(`Failed to load fixture ${filePath}`);
  const bytes = await response.arrayBuffer();
  return new File([bytes], fileNameFromPath(filePath), { type });
};

const selectFileInput = (input, file) => {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  Object.defineProperty(input, "files", {
    configurable: true,
    value: dataTransfer.files,
  });
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

const setFormControlValue = (element, value) => {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
};

const waitForState = async (resolveState, timeout = 30000, intervalMs = 50) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const state = resolveState();
    if (state) return state;
    await new Promise((resolve) => globalThis.setTimeout(resolve, intervalMs));
  }
  return null;
};

const getRuntimeErrorText = () => document.getElementById("rom-weaver-error-message")?.textContent?.trim() || "";
const getOutputErrorText = () => document.getElementById("rom-weaver-output-notice-message")?.textContent?.trim() || "";
const getAnyErrorText = () => getRuntimeErrorText() || getOutputErrorText() || "";
const hasStagingProgress = () =>
  !!document.querySelector(
    "[id^='rom-weaver-progress-rom'], [id^='rom-weaver-progress-checksum'], [id^='rom-weaver-progress-patch']",
  );

const waitForApplyButtonEnabled = async () => {
  await expect
    .poll(
      () =>
        document.getElementById("rom-weaver-button-apply") instanceof HTMLButtonElement &&
        !document.getElementById("rom-weaver-button-apply").disabled &&
        !hasStagingProgress(),
      { timeout: 30000 },
    )
    .toBe(true);
};

const clickApplyButton = async () => {
  const clicked = await waitForState(() => {
    const applyButton = document.getElementById("rom-weaver-button-apply");
    if (!(applyButton instanceof HTMLButtonElement) || applyButton.disabled) return null;
    applyButton.click();
    return true;
  }, 30000);
  expect(clicked).toBe(true);
};

const waitForApplyOutcome = async () => {
  return waitForState(() => {
    const applyButton = document.getElementById("rom-weaver-button-apply");
    const errorText = getAnyErrorText();
    if (errorText) return { errorText, kind: "error" };
    if (!(applyButton instanceof HTMLButtonElement)) return null;
    const isDownloadReady = !applyButton.disabled && (applyButton.textContent || "").includes("Download");
    if (isDownloadReady) return { kind: "download" };
    const canTriggerApply =
      !applyButton.disabled && (applyButton.textContent || "").toLowerCase().includes("apply patch");
    if (canTriggerApply && !hasStagingProgress()) applyButton.click();
    return null;
  }, 60000);
};

const clickCandidateSelectionOption = async (label) => {
  const state = await waitForState(() => {
    const list = document.querySelector("#rom-weaver-candidate-selection-list");
    if (list) return { kind: "dialog" };
    const selectedLabel = document.querySelector(
      "#rom-weaver-list-input-stack .rom-weaver-input-stack-file",
    )?.textContent;
    if (selectedLabel?.includes(label)) return { kind: "selected" };
    const errorText = getRuntimeErrorText();
    if (errorText) return { errorText, kind: "error" };
    return null;
  }, 60000);
  expect(state).not.toBeNull();
  expect(state?.kind, state && "errorText" in state ? state.errorText : "").not.toBe("error");
  if (state?.kind === "selected") return;
  if (!document.querySelector("#rom-weaver-candidate-selection-list")) return;
  const button = Array.from(document.querySelectorAll("#rom-weaver-candidate-selection-list button")).find((entry) =>
    entry.textContent?.includes(label),
  );
  if (!button) throw new Error(`Missing candidate selection option: ${label}`);
  button.click();
};

const clickPatchCandidateSelectionOption = async (label) => {
  const state = await waitForState(() => {
    const patchFileName =
      document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file")?.textContent || "";
    const selectedPatchName =
      document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file strong")?.textContent || "";
    if (selectedPatchName.includes(label) || patchFileName === label) return { kind: "selected" };
    const list = document.querySelector("#rom-weaver-candidate-selection-list");
    if (list) return { kind: "dialog" };
    const errorText = getRuntimeErrorText();
    if (errorText) return { errorText, kind: "error" };
    return null;
  }, 60000);
  expect(state).not.toBeNull();
  expect(state?.kind, state && "errorText" in state ? state.errorText : "").not.toBe("error");
  if (state?.kind === "selected") return;
  if (!document.querySelector("#rom-weaver-candidate-selection-list")) return;
  const button = Array.from(document.querySelectorAll("#rom-weaver-candidate-selection-list button")).find((entry) =>
    entry.textContent?.includes(label),
  );
  if (!button) throw new Error(`Missing patch candidate selection option: ${label}`);
  button.click();
};

const getInputStackFileName = () =>
  document.querySelector("#rom-weaver-list-input-stack .rom-weaver-input-stack-file strong")?.textContent?.trim() ||
  document.querySelector("#rom-weaver-list-input-stack .rom-weaver-input-stack-file")?.textContent?.trim() ||
  "";

const waitForInputStackFileName = async () => {
  const state = await waitForState(() => {
    if (hasStagingProgress()) return null;
    const fileName = getInputStackFileName();
    if (fileName && fileName.trim()) return { fileName: fileName.trim(), kind: "ready" };
    const errorText = getRuntimeErrorText();
    if (errorText) return { errorText, kind: "error" };
    return null;
  }, 60000);
  expect(state).not.toBeNull();
  expect(state?.kind, state && "errorText" in state ? state.errorText : "").toBe("ready");
  return state?.fileName || "";
};

beforeEach(async () => {
  mountedRoot?.unmount?.();
  mountedRoot = null;
  await new Promise((resolve) => globalThis.setTimeout(resolve, 40));
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  document.body.innerHTML = '<div id="app"></div>';
});

afterEach(async () => {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
});

test("ApplyPatchForm runs a complete patch flow and downloads output", async () => {
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: {
        output: {
          compression: "none",
        },
      },
    }),
  );

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(RAW_ROM));
  selectFileInput(document.getElementById("rom-weaver-input-file-patch"), await loadFixtureFile(RAW_PATCH));

  await waitForApplyButtonEnabled();

  await clickApplyButton();

  const applyState = await waitForApplyOutcome();
  expect(applyState).not.toBeNull();
  expect(applyState?.kind, applyState && "errorText" in applyState ? applyState.errorText : "").toBe("download");
  await expect
    .poll(() => document.getElementById("rom-weaver-section-timing-output")?.textContent || "", { timeout: 30000 })
    .toMatch(/apply:/i);
  expect(document.getElementById("rom-weaver-error-message")?.textContent || "").toBe("");
});

test("candidate selection resolves multi-entry archive inputs", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(
    document.getElementById("rom-weaver-input-file-rom"),
    await loadFixtureFile(MULTI_ROM_ZIP, "application/zip"),
  );

  await clickCandidateSelectionOption("game.bin");

  await expect
    .poll(
      () => document.querySelector("#rom-weaver-list-input-stack .rom-weaver-input-stack-file")?.textContent || "",
      { timeout: 30000 },
    )
    .toMatch(/\S+/);
});

test("patch row shows extraction progress and extracted patch naming", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-patch")).not.toBeNull();

  selectFileInput(
    document.getElementById("rom-weaver-input-file-patch"),
    await loadFixtureFile(ONE_PATCH_7Z, "application/x-7z-compressed"),
  );

  await clickPatchCandidateSelectionOption("change.ips");

  const patchState = await waitForState(() => {
    const patchFileName =
      document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file")?.textContent || "";
    const selectedPatchName =
      document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file strong")?.textContent || "";
    if (selectedPatchName.includes("change.ips") || patchFileName === "change.ips") return { kind: "ready" };
    const errorText = getRuntimeErrorText();
    if (errorText) return { errorText, kind: "error" };
    return null;
  }, 60000);
  expect(patchState).not.toBeNull();
  expect(patchState?.kind, patchState && "errorText" in patchState ? patchState.errorText : "").toBe("ready");

  await expect
    .poll(
      () =>
        document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-file strong")?.textContent || "",
      { timeout: 30000 },
    )
    .toContain("change.ips");

  const archiveLabel =
    document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-archive")?.textContent || "";
  expect(archiveLabel).toContain("one-patch.7z");
  expect(archiveLabel).toContain("change.ips");
  expect(archiveLabel).toMatch(/\d+(?:\.\d)? (?:B|KiB|MiB|GiB)/);
  expect(
    document.querySelector("#rom-weaver-list-patch-stack .rom-weaver-patch-stack-archive strong")?.textContent || "",
  ).toContain("change.ips");
});

test("RVZ rom inputs auto-extract before apply", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(RVZ_INPUT));

  await waitForInputStackFileName();
  await expect.poll(() => getInputStackFileName(), { timeout: 60000 }).toContain("game.iso");
});

test("CHD rom inputs auto-extract before apply", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(CHD_INPUT));

  await waitForInputStackFileName();
  await expect.poll(() => getInputStackFileName(), { timeout: 60000 }).not.toMatch(/\.chd$/i);
  await expect.poll(() => getInputStackFileName(), { timeout: 60000 }).toMatch(/game-cd\./i);
});

test("RVZ rom inputs can still run full apply workflow", async () => {
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: {
        output: {
          compression: "none",
        },
      },
    }),
  );

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(RVZ_INPUT));
  selectFileInput(document.getElementById("rom-weaver-input-file-patch"), await loadFixtureFile(RAW_PATCH));

  await waitForApplyButtonEnabled();
  await clickApplyButton();

  const applyState = await waitForApplyOutcome();
  expect(applyState).not.toBeNull();
  expect(applyState?.kind, applyState && "errorText" in applyState ? applyState.errorText : "").toBe("download");
});

test("output compression selector keeps expected apply options", async () => {
  mount(createElement(ApplyPatchForm));

  await expect.poll(() => document.getElementById("rom-weaver-select-output-format")).not.toBeNull();

  const outputFormatSelect = document.getElementById("rom-weaver-select-output-format");
  const outputFormatValues = Array.from(outputFormatSelect.options || []).map((entry) => entry.value);

  expect(outputFormatValues).toContain("none");
  expect(outputFormatValues).toContain("zip");
  expect(outputFormatValues).toContain("7z");

  setFormControlValue(outputFormatSelect, "zip");
  expect(document.getElementById("rom-weaver-select-output-format")?.value).toBe("zip");
});

test("runtime failures surface actionable error messaging", async () => {
  mount(
    createElement(ApplyPatchForm, {
      defaultSettings: {
        validation: {
          requireInputChecksumMatch: true,
        },
      },
    }),
  );

  await expect.poll(() => document.getElementById("rom-weaver-input-file-rom")).not.toBeNull();

  selectFileInput(document.getElementById("rom-weaver-input-file-rom"), await loadFixtureFile(RAW_ROM));
  selectFileInput(document.getElementById("rom-weaver-input-file-patch"), await loadFixtureFile(WRONG_INPUT_BPS));

  await waitForApplyButtonEnabled();
  await clickApplyButton();

  const applyState = await waitForApplyOutcome();
  expect(applyState).not.toBeNull();
  expect(applyState?.kind).toBe("error");
  expect("errorText" in (applyState || {}) ? applyState.errorText : "").toMatch(/(checksum|mismatch|failed|invalid)/i);
});
