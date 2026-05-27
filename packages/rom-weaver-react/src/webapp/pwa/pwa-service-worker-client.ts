import { registerSW } from "virtual:pwa-register";
import type { RegisterSWOptions } from "vite-plugin-pwa/types";

import {
  createServiceWorkerCacheState,
  type ServiceWorkerCacheState,
  setServiceWorkerCacheVersion,
  withDeferredServiceWorkerUpdate,
  withoutDeferredServiceWorkerUpdate,
} from "./service-worker-cache-state.ts";

type ServiceWorkerRegistrationLike = Pick<
  ServiceWorkerRegistration,
  "scope" | "active" | "waiting" | "installing" | "unregister" | "update"
>;
type ServiceWorkerContainerLike = Pick<ServiceWorkerContainer, "controller" | "getRegistrations"> &
  Pick<EventTarget, "addEventListener">;
type NavigatorLike = {
  serviceWorker?: ServiceWorkerContainerLike;
};
type CacheStorageLike = Pick<CacheStorage, "keys" | "delete">;
type WindowLike = Pick<Window, "location" | "addEventListener" | "setInterval" | "clearInterval">;
type DocumentLike = Pick<Document, "addEventListener" | "visibilityState">;

type CreatePwaServiceWorkerClientOptions = {
  cachePrefix: string;
  cacheVersionTimeoutMs: number;
  document: DocumentLike | undefined;
  enabled: boolean;
  navigator: NavigatorLike | undefined;
  onBeforeReload?: () => void;
  onConfirmReload: () => Promise<boolean>;
  onStateChange: (state: ServiceWorkerCacheState) => void;
  updateIntervalMs: number;
  window: WindowLike | undefined;
};

type PwaServiceWorkerClient = {
  getState: () => ServiceWorkerCacheState;
  initialize: () => void;
  reloadPendingUpdate: () => Promise<boolean>;
  refreshCacheVersion: () => void;
};

const ROM_WEAVER_SERVICE_WORKER_URL_PATTERN = /\/(?:_cache_service_worker|cache-service-worker|dev-sw)\.js(?:$|\?)/;

const createPwaServiceWorkerClient = ({
  cachePrefix,
  cacheVersionTimeoutMs,
  document,
  enabled,
  navigator,
  onBeforeReload,
  onConfirmReload,
  onStateChange,
  updateIntervalMs,
  window,
}: CreatePwaServiceWorkerClientOptions): PwaServiceWorkerClient => {
  let initialized = false;
  let state = createServiceWorkerCacheState();
  let updateServiceWorker: ReturnType<typeof registerSW> | null = null;
  let serviceWorkerRegistration: ServiceWorkerRegistrationLike | undefined;
  let updateIntervalId: number | null = null;

  const emitState = () => {
    onStateChange(state);
  };
  const setVersion = (version: string, title?: string) => {
    state = setServiceWorkerCacheVersion(state, version, title);
    emitState();
  };
  const markUpdateReady = () => {
    state = withDeferredServiceWorkerUpdate(state);
    emitState();
  };
  const clearUpdateReady = () => {
    state = withoutDeferredServiceWorkerUpdate(state);
    emitState();
  };

  const refreshCacheVersion = () => {
    if (!enabled) {
      setVersion("off", "Service worker cache is disabled");
      return;
    }
    const serviceWorker = navigator?.serviceWorker;
    if (!serviceWorker) {
      setVersion("off", "Service worker is not available in this browser");
      return;
    }
    const controller = serviceWorker.controller;
    if (!controller) {
      setVersion("network", "This page is not controlled by a service worker");
      return;
    }
    if (typeof MessageChannel !== "function") {
      setVersion("unknown", "This browser cannot query the loaded service worker cache version");
      return;
    }

    const channel = new MessageChannel();
    let complete = false;
    const finish = (version?: string, title?: string) => {
      if (complete) return;
      complete = true;
      clearTimeout(timeout);
      setVersion(version || "unknown", title);
    };
    const timeout = setTimeout(() => {
      finish("unknown", "The loaded service worker did not report a cache version");
    }, cacheVersionTimeoutMs);
    channel.port1.onmessage = (event) => {
      const data = event.data || {};
      finish(
        typeof data.precacheVersion === "string" ? data.precacheVersion : undefined,
        `Loaded service worker cache: ${data.precacheName || data.precacheVersion || "unknown"}`,
      );
    };

    try {
      controller.postMessage({ action: "get-service-worker-cache-version" }, [channel.port2]);
    } catch (_err) {
      finish("unknown", "Could not query the loaded service worker cache version");
    }
  };
  const runServiceWorkerUpdateCheck = () => {
    void serviceWorkerRegistration?.update?.().catch(() => undefined);
  };
  const startServiceWorkerUpdateChecks = () => {
    if (!window || updateIntervalId !== null) return;
    updateIntervalId = window.setInterval(runServiceWorkerUpdateCheck, updateIntervalMs);
  };
  const stopServiceWorkerUpdateChecks = () => {
    if (!window || updateIntervalId === null) return;
    window.clearInterval(updateIntervalId);
    updateIntervalId = null;
  };

  const isRomWeaverServiceWorkerRegistration = (
    registration: ServiceWorkerRegistrationLike,
    expectedScope: string,
  ): boolean => {
    const workers = [registration.active, registration.waiting, registration.installing];
    for (const worker of workers) {
      if (worker && ROM_WEAVER_SERVICE_WORKER_URL_PATTERN.test(worker.scriptURL)) return true;
    }
    return registration.scope === expectedScope;
  };

  const deleteServiceWorkerCaches = async () => {
    const cacheStorage = typeof caches === "undefined" ? null : (caches as CacheStorageLike);
    if (!cacheStorage) return;
    const cacheNames = await cacheStorage.keys();
    await Promise.all(
      cacheNames
        .filter((cacheName) => cacheName.indexOf(cachePrefix) === 0)
        .map((cacheName) => cacheStorage.delete(cacheName)),
    );
  };

  const disableServiceWorkerCache = () => {
    setVersion("off", "Service worker cache is disabled");
    const serviceWorker = navigator?.serviceWorker;
    if (!(serviceWorker && window?.location)) {
      void deleteServiceWorkerCaches().catch(() => undefined);
      return;
    }

    const expectedScope = new URL("./", window.location.href).href;
    void serviceWorker
      .getRegistrations()
      .then((registrations) =>
        Promise.all(
          registrations
            .filter((registration) => isRomWeaverServiceWorkerRegistration(registration, expectedScope))
            .map((registration) => registration.unregister()),
        ),
      )
      .then(deleteServiceWorkerCaches)
      .then(() => {
        setVersion("off", "Service worker cache is disabled");
      })
      .catch(() => {
        setVersion("off", "Service worker cache is disabled");
      });
  };
  const reloadPendingUpdate = async (): Promise<boolean> => {
    if (!(state.updateReady && updateServiceWorker)) return false;
    if (!(await onConfirmReload())) return false;
    clearUpdateReady();
    onBeforeReload?.();
    await updateServiceWorker(true);
    return true;
  };

  const initialize = () => {
    if (initialized) return;
    initialized = true;

    if (!enabled) {
      disableServiceWorkerCache();
      return;
    }

    const serviceWorker = navigator?.serviceWorker;
    if (!serviceWorker) {
      refreshCacheVersion();
      return;
    }

    serviceWorker.addEventListener("controllerchange", () => {
      clearUpdateReady();
      refreshCacheVersion();
    });
    window?.addEventListener("beforeunload", stopServiceWorkerUpdateChecks);
    window?.addEventListener("focus", runServiceWorkerUpdateCheck);
    window?.addEventListener("online", runServiceWorkerUpdateCheck);
    document?.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") runServiceWorkerUpdateCheck();
    });

    updateServiceWorker = registerSW({
      immediate: true,
      onNeedRefresh: markUpdateReady,
      onOfflineReady: refreshCacheVersion,
      onRegisterError: () => {
        refreshCacheVersion();
      },
      onRegisteredSW: (
        _swScriptUrl: string,
        registration: Parameters<NonNullable<RegisterSWOptions["onRegisteredSW"]>>[1],
      ) => {
        serviceWorkerRegistration = registration as ServiceWorkerRegistrationLike | undefined;
        if (!registration) {
          refreshCacheVersion();
          return;
        }
        void registration.update?.().catch(() => undefined);
        startServiceWorkerUpdateChecks();
        refreshCacheVersion();
      },
    });

    refreshCacheVersion();
  };

  return {
    getState: () => state,
    initialize,
    refreshCacheVersion,
    reloadPendingUpdate,
  };
};

export { createPwaServiceWorkerClient, type PwaServiceWorkerClient };
