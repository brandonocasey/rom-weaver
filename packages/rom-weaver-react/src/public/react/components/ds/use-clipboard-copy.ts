import { useEffect, useRef, useState } from "react";
import { createLogger } from "../../../../lib/logging.ts";

/**
 * Copy-to-clipboard hook with a brief "copied" confirmation. Shared by the
 * checksum rows and the CUE section so the copy behaviour (including the
 * non-secure-context fallback) lives in one place.
 */

const logger = createLogger("clipboard-copy");
const COPIED_RESET_MS = 1100;

// Fallback for non-secure contexts (e.g. a self-signed LAN cert on iOS) where
// navigator.clipboard is unavailable — selection + execCommand still copies there.
const execCommandCopy = (value: string): boolean => {
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = "position:fixed;top:-1000px;left:0;opacity:0;";
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
};

const useClipboardCopy = (text: string, resetMs = COPIED_RESET_MS) => {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const markCopied = () => {
    setCopied(true);
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), resetMs);
  };

  const copy = () => {
    if (!text) return;
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (clipboard?.writeText) {
      clipboard.writeText(text).then(markCopied, () => {
        if (execCommandCopy(text)) markCopied();
        else logger.trace("Clipboard copy failed");
      });
      return;
    }
    if (execCommandCopy(text)) markCopied();
    else logger.trace("Clipboard unavailable; skipping copy");
  };

  return { copied, copy };
};

export { useClipboardCopy };
