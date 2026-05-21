(() => {
  const ERUDA_URL = "https://cdn.jsdelivr.net/npm/eruda@3.4.3/eruda.min.js";
  const ERUDA_INITIALIZED_FLAG = "__ROM_WEAVER_ERUDA_INITIALIZED__";
  const LOCAL_STORAGE_SETTINGS_ID = "rom-weaver-settings";
  const SETTINGS_STORAGE_VERSION = 5;

  let erudaEnabled = false;
  const addErudaScript = (script: HTMLScriptElement) => {
    document.head.insertBefore(script, document.head.firstChild);
  };
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const readStoredErudaEnabled = (rawSettings: string | null): boolean => {
    if (!rawSettings) return false;
    const settings = JSON.parse(rawSettings) as unknown;
    if (!isRecord(settings) || settings.version !== SETTINGS_STORAGE_VERSION) return false;
    const commonSettings = isRecord(settings.common) ? settings.common : null;
    return commonSettings?.erudaDevTools === true;
  };

  const readStoredErudaSetting = (): boolean => {
    try {
      if (typeof localStorage === "undefined") return false;
      const rawSettings = localStorage.getItem(LOCAL_STORAGE_SETTINGS_ID);
      return readStoredErudaEnabled(rawSettings);
    } catch (_err) {
      return false;
    }
  };
  const shouldEnableEruda = () => readStoredErudaSetting();
  const initEruda = () => {
    if (!(erudaEnabled && window.eruda) || window.__ROM_WEAVER_ERUDA_INITIALIZED__) return;
    window.__ROM_WEAVER_ERUDA_INITIALIZED__ = true;
    window.eruda.init();
    console.log("Eruda dev tools initialized");
  };
  const loadEruda = () => {
    erudaEnabled = true;
    window.ROM_WEAVER_ERUDA_ENABLED = true;
    if (window.eruda) {
      initEruda();
      return;
    }

    const script = document.createElement("script");
    script.src = ERUDA_URL;
    script.crossOrigin = "anonymous";
    script.onload = initEruda;
    script.onerror = () => {
      console.error(`Failed to load Eruda dev tools from ${ERUDA_URL}`);
    };
    addErudaScript(script);
  };
  const unloadEruda = () => {
    erudaEnabled = false;
    window.ROM_WEAVER_ERUDA_ENABLED = false;
    if (!(window.eruda && window.__ROM_WEAVER_ERUDA_INITIALIZED__)) return;
    if (typeof window.eruda.destroy === "function") window.eruda.destroy();
    else if (typeof window.eruda.hide === "function") window.eruda.hide();
    window.__ROM_WEAVER_ERUDA_INITIALIZED__ = false;
  };
  const setErudaEnabled = (enabled: RuntimeValue) => {
    if (enabled) loadEruda();
    else unloadEruda();
  };

  window.ROM_WEAVER_ERUDA_LOADER = {
    isEnabled: () => erudaEnabled,
    setEnabled: (enabled) => {
      setErudaEnabled(!!enabled);
    },
    syncFromStoredSettings: () => {
      setErudaEnabled(readStoredErudaSetting());
    },
  };

  if (!shouldEnableEruda()) return;

  if (document.readyState === "loading" && document.currentScript) {
    erudaEnabled = true;
    window.ROM_WEAVER_ERUDA_ENABLED = true;
    document.write(`<script crossorigin="anonymous" src="${ERUDA_URL}"></script>`);
    document.write(
      `<script>(function(){if(window.eruda&&!window.${ERUDA_INITIALIZED_FLAG}){window.${ERUDA_INITIALIZED_FLAG}=true;window.eruda.init();console.log("Eruda dev tools initialized");}}());</script>`,
    );
    return;
  }

  loadEruda();
})();
