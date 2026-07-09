import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import type { ManifestApplySession } from "../../lib/manifest/manifest-session-model.ts";
import type { RemoteFetchEntry, RemoteFetchErrorKind } from "../../lib/remote/remote-file-fetch.ts";
import { fetchRemoteFiles, RemoteFetchError } from "../../lib/remote/remote-file-fetch.ts";
import { loadManifestUrlSession } from "./manifest-url-session.ts";
import type { UrlSessionRequest } from "./url-session-request.ts";

const logger = createLogger("url-session");

type UrlSessionBootState = {
  phase: "idle" | "fetching" | "done" | "error";
  loadedBytes: number;
  totalBytes: number | null;
  /** The manifest's display name once parsed (manifest sessions only). */
  manifestName: string;
  errorKind: RemoteFetchErrorKind | null;
  errorDetail: string;
};

const IDLE_STATE: UrlSessionBootState = {
  errorDetail: "",
  errorKind: null,
  loadedBytes: 0,
  manifestName: "",
  phase: "idle",
  totalBytes: null,
};

/**
 * Boot-time URL-session loader: fetches the request's sources once per attempt
 * and delivers them as `File`s into the apply tab's drop pipeline. The direct
 * `rom=`/`patch=` shape fetches verbatim; the `manifest=` shape parses the
 * rw.json through the wasm runtime first, acquires its sources, and surfaces
 * the decorated session via `onManifestSession` for the apply form to consume.
 */
function useUrlSessionBoot(
  request: UrlSessionRequest | null,
  deliverFiles: (files: File[]) => void,
  onManifestSession?: (session: ManifestApplySession) => void,
): { state: UrlSessionBootState; retry: () => void } {
  const [state, setState] = useState<UrlSessionBootState>(IDLE_STATE);
  const [attempt, setAttempt] = useState(0);
  const deliverRef = useRef(deliverFiles);
  deliverRef.current = deliverFiles;
  const manifestSessionRef = useRef(onManifestSession);
  manifestSessionRef.current = onManifestSession;

  useEffect(() => {
    if (!request) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    const loadedByEntry = new Map<number | string, number>();
    const totalsByEntry = new Map<number | string, number | null>();
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

    setState({ ...IDLE_STATE, phase: "fetching" });
    let run: Promise<void>;
    if (request.kind === "direct") {
      const urls = [...(request.romUrl ? [request.romUrl] : []), ...request.patchUrls];
      const entries: RemoteFetchEntry[] = urls.map((url, index) => ({
        onProgress: (progress) => {
          loadedByEntry.set(index, progress.loadedBytes);
          totalsByEntry.set(index, progress.totalBytes);
          reportProgress();
        },
        url,
      }));
      logger.info(`loading url session (${entries.length} file(s))`);
      run = fetchRemoteFiles(entries, controller.signal).then((files) => {
        if (cancelled) return;
        // One delivery preserves patch order through the drop router.
        deliverRef.current(files.map((entry) => entry.file));
      });
    } else {
      run = loadManifestUrlSession(request.manifestUrl, {
        onManifestName: (name) => {
          if (!cancelled) setState((previous) => ({ ...previous, manifestName: name }));
        },
        onProgress: (id, progress) => {
          loadedByEntry.set(id, progress.loadedBytes);
          totalsByEntry.set(id, progress.totalBytes);
          reportProgress();
        },
        signal: controller.signal,
      }).then(({ files, session }) => {
        if (cancelled) return;
        // A retry after failure must re-seed the form, so the session identity carries the attempt.
        manifestSessionRef.current?.({ ...session, key: `${session.key}#${attempt}` });
        deliverRef.current(files);
      });
    }
    run
      .then(() => {
        if (cancelled) return;
        setState((previous) => ({ ...previous, phase: "done" }));
        logger.info("url session loaded");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const kind = error instanceof RemoteFetchError ? error.kind : null;
        if (kind === "aborted" || controller.signal.aborted) return;
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
