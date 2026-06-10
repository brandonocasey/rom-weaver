// OPFS permits only one open access handle (or writable stream) per file at a time. When a previous
// holder is still mid-close — e.g. the staging worker just finished writing a freshly staged source,
// or a sibling operation is tearing down — createSyncAccessHandle briefly rejects with "Access
// Handles cannot be created if there is another open Access Handle or Writable stream associated with
// the same file." The handle frees as soon as the other side closes, so the failure is transient.
// This surfaced when re-uploading the same archive to pick a second entry: the second extract opened
// the staged source while the first operation's handle was still releasing, failing the whole run.
const SYNC_ACCESS_CONTENTION_RETRY_DELAYS_MS = [4, 8, 16, 32, 64, 128];

const isSyncAccessContentionError = (error) => {
  const message = String(error && error.message ? error.message : error || '').toLowerCase();
  return (
    message.includes('another open access handle') ||
    message.includes('access handles cannot be created') ||
    message.includes('writable stream')
  );
};

const wait = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const createSyncAccessHandleWithRetry = async (fileHandle, options) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return options === undefined
        ? await fileHandle.createSyncAccessHandle()
        : await fileHandle.createSyncAccessHandle(options);
    } catch (error) {
      if (!isSyncAccessContentionError(error) || attempt >= SYNC_ACCESS_CONTENTION_RETRY_DELAYS_MS.length) throw error;
      await wait(SYNC_ACCESS_CONTENTION_RETRY_DELAYS_MS[attempt]);
    }
  }
};

export async function openSyncAccessHandle({ fileHandle, mode }) {
  if (mode === undefined) return createSyncAccessHandleWithRetry(fileHandle, undefined);
  try {
    return await createSyncAccessHandleWithRetry(fileHandle, { mode });
  } catch (error) {
    if (mode === 'read-only') return createSyncAccessHandleWithRetry(fileHandle, undefined);
    throw error;
  }
}

export function closeSyncFiles(files) {
  for (const file of files) {
    try {
      file.close();
    } catch {
      // ignore best-effort close failures
    }
  }
}

export function writableSyncAccessMode(mode) {
  return mode === 'read-only' ? undefined : mode;
}
