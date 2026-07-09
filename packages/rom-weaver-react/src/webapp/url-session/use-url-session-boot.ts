import { useCallback, useEffect, useRef, useState } from "react";

import { createLogger } from "../../lib/logging.ts";
import type { RemoteFetchEntry, RemoteFetchErrorKind } from "../../lib/remote/remote-file-fetch.ts";
import { fetchRemoteFiles, RemoteFetchError } from "../../lib/remote/remote-file-fetch.ts";
import type { UrlSessionRequest } from "./url-session-request.ts";

const logger = createLogger("url-session");

type UrlSessionBootState = {
  phase: "idle" | "fetching" | "done" | "error";
  loadedBytes: number;
  totalBytes: number | null;
  errorKind: RemoteFetchErrorKind | null;
  errorDetail: string;
};

const IDLE_STATE: UrlSessionBootState = {
  errorDetail: "",
  errorKind: null,
  loadedBytes: 0,
  phase: "idle",
  totalBytes: null,
};

/**
 * Boot-time URL-session loader: fetches the request's sources once per
 * attempt and delivers them as `File`s into the apply tab's drop pipeline.
 * The manifest kind is resolved by the manifest session flow; this hook owns
 * the direct `rom=`/`patch=` shape.
 */
function useUrlSessionBoot(
  request: UrlSessionRequest | null,
  deliverFiles: (files: File[]) => void,
): { state: UrlSessionBootState; retry: () => void } {
  const [state, setState] = useState<UrlSessionBootState>(IDLE_STATE);
  const [attempt, setAttempt] = useState(0);
  const deliverRef = useRef(deliverFiles);
  deliverRef.current = deliverFiles;

  useEffect(() => {
    if (!request || request.kind !== "direct") return undefined;
    let cancelled = false;
    const controller = new AbortController();
    const loadedByEntry = new Map<number, number>();
    const totalsByEntry = new Map<number, number | null>();
    const reportProgress = () => {
      if (cancelled) return;
      let loadedBytes = 0;
      for (const value of loadedByEntry.values()) loadedBytes += value;
      let totalBytes: number | null = 0;
      for (const value of totalsByEntry.values()) {
        if (value === null) {
          totalBytes = null;
          break;
        }
        totalBytes += value;
      }
      setState((previous) => ({ ...previous, loadedBytes, phase: "fetching", totalBytes }));
    };

    const urls = [...(request.romUrl ? [request.romUrl] : []), ...request.patchUrls];
    const entries: RemoteFetchEntry[] = urls.map((url, index) => ({
      onProgress: (progress) => {
        loadedByEntry.set(index, progress.loadedBytes);
        totalsByEntry.set(index, progress.totalBytes);
        reportProgress();
      },
      url,
    }));
    setState({ ...IDLE_STATE, phase: "fetching" });
    logger.info(`loading url session (${entries.length} file(s))`);
    void fetchRemoteFiles(entries, controller.signal)
      .then((files) => {
        if (cancelled) return;
        // One delivery preserves patch order through the drop router.
        deliverRef.current(files.map((entry) => entry.file));
        setState((previous) => ({ ...previous, phase: "done" }));
        logger.info("url session loaded");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const kind = error instanceof RemoteFetchError ? error.kind : null;
        if (kind === "aborted") return;
        logger.error(`url session failed: ${String(error)}`);
        setState((previous) => ({
          ...previous,
          errorDetail: error instanceof Error ? error.message : String(error),
          errorKind: kind,
          phase: "error",
        }));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [attempt, request]);

  const retry = useCallback(() => setAttempt((previous) => previous + 1), []);
  return { retry, state };
}

export type { UrlSessionBootState };
export { useUrlSessionBoot };
