import { confirmReloadWithPendingChanges } from "../unload-guard.ts";

const DEFAULT_CACHE_TITLE = "Loaded service worker cache version";
const DEFAULT_UPDATE_LABEL = "Reload to update";
const DEFAULT_UPDATE_TITLE = "A newer app version is ready. Reload when you are ready to switch to it.";

type NavigationGuardState = Parameters<typeof confirmReloadWithPendingChanges>[0];

type ServiceWorkerCacheState = {
  label: string;
  title: string;
  updateLabel: string;
  updateReady: boolean;
  updateTitle: string;
};

type ServiceWorkerReloadAttempt = {
  assetVersion?: string | null;
  confirm?: (message: string) => RuntimeValue;
  getState?: () => NavigationGuardState;
  location: Pick<Location, "pathname" | "search">;
  reload: () => void;
  reloadStorageId: string;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  version?: string | null;
};

type ServiceWorkerReloadAuthorization = {
  status: "accepted" | "cancelled";
  version: string;
};

type ServiceWorkerReloadResult = {
  status: "already-reloaded" | "cancelled" | "reloaded";
  version: string;
};

const createServiceWorkerCacheState = (): ServiceWorkerCacheState => ({
  label: "cache ...",
  title: DEFAULT_CACHE_TITLE,
  updateLabel: DEFAULT_UPDATE_LABEL,
  updateReady: false,
  updateTitle: DEFAULT_UPDATE_TITLE,
});

const setServiceWorkerCacheVersion = (
  state: ServiceWorkerCacheState,
  version: string,
  title?: string,
): ServiceWorkerCacheState => ({
  ...state,
  label: `cache ${version}`,
  title: title || DEFAULT_CACHE_TITLE,
});

const withDeferredServiceWorkerUpdate = (state: ServiceWorkerCacheState): ServiceWorkerCacheState => ({
  ...state,
  updateLabel: DEFAULT_UPDATE_LABEL,
  updateReady: true,
  updateTitle: DEFAULT_UPDATE_TITLE,
});

const withoutDeferredServiceWorkerUpdate = (state: ServiceWorkerCacheState): ServiceWorkerCacheState => ({
  ...state,
  updateReady: false,
});

const authorizeServiceWorkerReload = ({
  assetVersion,
  confirm,
  getState,
  version,
}: Pick<
  ServiceWorkerReloadAttempt,
  "assetVersion" | "confirm" | "getState" | "version"
>): ServiceWorkerReloadAuthorization => {
  const reloadVersion = version || assetVersion || "unknown";

  if (getState && !confirmReloadWithPendingChanges(getState(), confirm)) {
    return {
      status: "cancelled",
      version: reloadVersion,
    };
  }

  return {
    status: "accepted",
    version: reloadVersion,
  };
};

const attemptServiceWorkerReload = ({
  assetVersion,
  confirm,
  getState,
  location,
  reload,
  reloadStorageId,
  storage,
  version,
}: ServiceWorkerReloadAttempt): ServiceWorkerReloadResult => {
  const authorization = authorizeServiceWorkerReload({
    assetVersion,
    confirm,
    getState,
    version,
  });
  const reloadVersion = authorization.version;
  const reloadKey = `${reloadVersion}:${location.pathname}${location.search}`;

  if (authorization.status === "cancelled") {
    return {
      status: "cancelled",
      version: reloadVersion,
    };
  }

  try {
    if (storage?.getItem(reloadStorageId) === reloadKey) {
      return {
        status: "already-reloaded",
        version: reloadVersion,
      };
    }
    storage?.setItem(reloadStorageId, reloadKey);
  } catch (_err) {
    /* ignore cleanup errors */
  }

  reload();
  return {
    status: "reloaded",
    version: reloadVersion,
  };
};

export {
  attemptServiceWorkerReload,
  authorizeServiceWorkerReload,
  createServiceWorkerCacheState,
  type ServiceWorkerCacheState,
  type ServiceWorkerReloadResult,
  setServiceWorkerCacheVersion,
  withDeferredServiceWorkerUpdate,
  withoutDeferredServiceWorkerUpdate,
};
