/**
 * Fetch layer for URL-session sources. Downloads land as in-memory `File`s
 * and enter the exact same pipeline as dropped files. Cross-origin hosts must
 * allow CORS; a blocked fetch surfaces as `RemoteFetchError` with kind
 * `blocked` so the UI can explain the host requirement.
 */

import { createLogger } from "../logging.ts";

const logger = createLogger("remote-fetch");

/** Hard guard against unbounded downloads; heap-backed Files must fit memory. */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;

type RemoteFetchErrorKind = "blocked" | "http" | "too-large" | "aborted";

class RemoteFetchError extends Error {
  readonly kind: RemoteFetchErrorKind;
  readonly url: string;
  readonly status: number | null;

  constructor(kind: RemoteFetchErrorKind, url: string, message: string, status: number | null = null) {
    super(message);
    this.name = "RemoteFetchError";
    this.kind = kind;
    this.url = url;
    this.status = status;
  }
}

type RemoteFetchProgress = {
  loadedBytes: number;
  totalBytes: number | null;
};

type FetchRemoteFileOptions = {
  /** Fallback name when neither Content-Disposition nor the URL tail has one. */
  fallbackFileName?: string;
  maxBytes?: number;
  onProgress?: (progress: RemoteFetchProgress) => void;
  signal?: AbortSignal;
};

type RemoteFile = {
  file: File;
  finalUrl: string;
};

function fileNameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const starMatch = /filename\*\s*=\s*(?:utf-8''|UTF-8'')?([^;]+)/.exec(header);
  if (starMatch?.[1]) {
    try {
      const decoded = decodeURIComponent(starMatch[1].trim().replace(/^"|"$/g, ""));
      if (decoded) return decoded;
    } catch {
      // fall through to the plain filename= form
    }
  }
  const plainMatch = /filename\s*=\s*"?([^";]+)"?/.exec(header);
  const plain = plainMatch?.[1]?.trim();
  return plain || null;
}

function fileNameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (!tail) return null;
    try {
      return decodeURIComponent(tail);
    } catch {
      return tail;
    }
  } catch {
    return null;
  }
}

function sanitizeFileName(name: string): string {
  const sanitized = name.replace(/[/\\]/g, "-").trim();
  return sanitized || "download.bin";
}

async function fetchRemoteFile(url: string, options: FetchRemoteFileOptions = {}): Promise<RemoteFile> {
  const { fallbackFileName, maxBytes = DEFAULT_MAX_BYTES, onProgress, signal } = options;
  logger.debug(`fetching remote file: ${url}`);
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new RemoteFetchError("aborted", url, "download aborted");
    }
    // A TypeError from fetch() is the CORS/network-failure shape.
    throw new RemoteFetchError(
      "blocked",
      url,
      `the host did not allow the download (CORS or network failure): ${String(error)}`,
    );
  }
  if (!response.ok) {
    throw new RemoteFetchError("http", url, `download failed with HTTP ${response.status}`, response.status);
  }

  const contentLengthRaw = response.headers.get("content-length");
  const parsedLength = contentLengthRaw === null ? Number.NaN : Number.parseInt(contentLengthRaw, 10);
  const totalBytes = Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : null;
  if (totalBytes !== null && totalBytes > maxBytes) {
    throw new RemoteFetchError("too-large", url, `download is ${totalBytes} bytes (limit ${maxBytes})`);
  }

  const fileName = sanitizeFileName(
    fileNameFromContentDisposition(response.headers.get("content-disposition")) ??
      fileNameFromUrl(response.url || url) ??
      fallbackFileName ??
      "download.bin",
  );

  const chunks: BlobPart[] = [];
  let loadedBytes = 0;
  const body = response.body;
  if (body) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      loadedBytes += value.byteLength;
      if (loadedBytes > maxBytes) {
        await reader.cancel();
        throw new RemoteFetchError("too-large", url, `download exceeded the ${maxBytes} byte limit`);
      }
      chunks.push(value);
      onProgress?.({ loadedBytes, totalBytes });
    }
  } else {
    const buffer = await response.arrayBuffer();
    loadedBytes = buffer.byteLength;
    if (loadedBytes > maxBytes) {
      throw new RemoteFetchError("too-large", url, `download exceeded the ${maxBytes} byte limit`);
    }
    chunks.push(buffer);
    onProgress?.({ loadedBytes, totalBytes });
  }
  logger.debug(`fetched remote file: ${url} (${loadedBytes} bytes as ${fileName})`);
  return {
    file: new File(chunks, fileName),
    finalUrl: response.url || url,
  };
}

type RemoteFetchEntry = {
  url: string;
  fallbackFileName?: string;
  onProgress?: (progress: RemoteFetchProgress) => void;
};

/**
 * Fetch several sources concurrently; the first hard failure aborts the rest.
 */
async function fetchRemoteFiles(entries: readonly RemoteFetchEntry[], signal?: AbortSignal): Promise<RemoteFile[]> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    return await Promise.all(
      entries.map((entry) =>
        fetchRemoteFile(entry.url, {
          fallbackFileName: entry.fallbackFileName,
          onProgress: entry.onProgress,
          signal: controller.signal,
        }).catch((error: unknown) => {
          controller.abort();
          throw error;
        }),
      ),
    );
  } finally {
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

export type { RemoteFetchEntry, RemoteFetchErrorKind };
export { fetchRemoteFiles, RemoteFetchError };
