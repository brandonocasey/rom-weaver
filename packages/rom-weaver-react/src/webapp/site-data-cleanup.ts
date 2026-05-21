type NavigationTimingLike = {
  type?: string;
};

type PerformanceLike = {
  getEntriesByType?: (type: string) => RuntimeValue[];
};

type OpfsDirectoryHandle = {
  entries?: () => AsyncIterable<[string, RuntimeValue]>;
  keys?: () => AsyncIterable<string>;
  removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>;
};

type StorageWithOpfsDirectory = {
  getDirectory?: () => Promise<OpfsDirectoryHandle>;
};

type ClearOpfsResult = {
  deletedEntries: number;
  failedEntries: number;
  skippedReason?: "not-reload" | "opfs-unavailable" | "reload-cleanup-disabled" | "version-directory-missing";
};

const OPFS_VERSION_DIRECTORY = "v4";

const isReloadNavigation = (performanceObject: PerformanceLike | undefined = globalThis.performance): boolean => {
  const navigationEntry = performanceObject?.getEntriesByType?.("navigation")?.[0] as NavigationTimingLike | undefined;
  return navigationEntry?.type === "reload";
};

const listOpfsRootEntries = async (root: OpfsDirectoryHandle): Promise<string[]> => {
  const entries: string[] = [];
  if (typeof root.keys === "function") {
    for await (const name of root.keys()) entries.push(name);
    return entries;
  }
  if (typeof root.entries === "function") {
    for await (const [name] of root.entries()) entries.push(name);
  }
  return entries;
};

const clearOpfsRootDirectory = async (root: OpfsDirectoryHandle): Promise<ClearOpfsResult> => {
  const names = await listOpfsRootEntries(root);
  let deletedEntries = 0;
  let failedEntries = 0;
  for (const name of names) {
    try {
      await root.removeEntry(name, { recursive: true });
      deletedEntries++;
    } catch (_err) {
      failedEntries++;
    }
  }
  return { deletedEntries, failedEntries };
};

const clearOpfsVersionDirectory = async (
  root: OpfsDirectoryHandle,
  directoryName = OPFS_VERSION_DIRECTORY,
): Promise<ClearOpfsResult> => {
  try {
    await root.removeEntry(directoryName, { recursive: true });
    return { deletedEntries: 1, failedEntries: 0 };
  } catch (_err) {
    return { deletedEntries: 0, failedEntries: 0, skippedReason: "version-directory-missing" };
  }
};

const clearOpfsOnPageReload = async ({
  enabled = false,
  performanceObject = globalThis.performance,
  storage = typeof navigator === "undefined" ? undefined : (navigator.storage as StorageWithOpfsDirectory | undefined),
}: {
  enabled?: boolean;
  performanceObject?: PerformanceLike;
  storage?: StorageWithOpfsDirectory;
} = {}): Promise<ClearOpfsResult> => {
  if (!isReloadNavigation(performanceObject))
    return { deletedEntries: 0, failedEntries: 0, skippedReason: "not-reload" };
  if (!enabled) return { deletedEntries: 0, failedEntries: 0, skippedReason: "reload-cleanup-disabled" };
  if (!storage || typeof storage.getDirectory !== "function")
    return { deletedEntries: 0, failedEntries: 0, skippedReason: "opfs-unavailable" };

  try {
    return await clearOpfsVersionDirectory(await storage.getDirectory());
  } catch (_err) {
    return { deletedEntries: 0, failedEntries: 1 };
  }
};

export type { ClearOpfsResult };
export {
  clearOpfsOnPageReload,
  clearOpfsRootDirectory,
  clearOpfsVersionDirectory,
  isReloadNavigation,
  OPFS_VERSION_DIRECTORY,
};
