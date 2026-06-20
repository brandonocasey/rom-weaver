// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "../../src/lib/clipboard.ts";

/**
 * The execCommand fallback (used when navigator.clipboard is unavailable, e.g.
 * a non-secure LAN context) must mount its scratch <textarea> inside an open
 * <dialog>. A modal dialog makes document.body inert, so a textarea appended
 * there cannot be selected and the copy silently fails — the log dialog bug.
 */

const stubNoAsyncClipboard = () => {
  vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
};

// happy-dom does not implement document.execCommand, so install a mock the
// fallback path can call and return its result.
const stubExecCommand = (impl: () => boolean) => {
  Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(impl) });
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("copyToClipboard execCommand fallback host", () => {
  it("mounts the scratch textarea inside an open dialog, not the inert body", async () => {
    stubNoAsyncClipboard();
    const dialog = document.createElement("dialog");
    document.body.appendChild(dialog);
    dialog.showModal();

    let host: Node | null = null;
    stubExecCommand(() => {
      host = document.querySelector("textarea")?.parentNode ?? null;
      return true;
    });

    await expect(copyToClipboard("payload")).resolves.toBeUndefined();
    expect(host).toBe(dialog);
  });

  it("falls back to document.body when no dialog is open", async () => {
    stubNoAsyncClipboard();
    let host: Node | null = null;
    stubExecCommand(() => {
      host = document.querySelector("textarea")?.parentNode ?? null;
      return true;
    });

    await expect(copyToClipboard("payload")).resolves.toBeUndefined();
    expect(host).toBe(document.body);
  });

  it("rejects when execCommand reports failure", async () => {
    stubNoAsyncClipboard();
    stubExecCommand(() => false);
    await expect(copyToClipboard("payload")).rejects.toThrow("Clipboard unavailable");
  });

  it("removes the scratch textarea after copying", async () => {
    stubNoAsyncClipboard();
    stubExecCommand(() => true);
    await copyToClipboard("payload");
    expect(document.querySelector("textarea")).toBeNull();
  });
});
