const SETTINGS_STORAGE_VERSION = 5;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const readBoolean = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);

const readErudaEnabledFromStoredSettings = (rawSettings: string | null): boolean => {
  if (!rawSettings) return false;

  try {
    const settings = JSON.parse(rawSettings) as unknown;
    if (!isRecord(settings)) return false;
    if (settings.version !== SETTINGS_STORAGE_VERSION) return false;

    const commonSettings = isRecord(settings.common) ? settings.common : null;
    const groupedValue = readBoolean(commonSettings?.erudaDevTools);
    return groupedValue === true;
  } catch (_err) {
    return false;
  }
};

export { readErudaEnabledFromStoredSettings };
