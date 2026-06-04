type SettingsWithOutput = {
  output?: Record<string, unknown>;
};

const createReactWorkflowId = (prefix: string) =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const createSettingsDependencyKey = (value: unknown) =>
  JSON.stringify(value, (_key, entry) => (typeof entry === "function" ? "[function]" : entry));

const mergeSettingsWithOutput = <TSettings extends SettingsWithOutput>(
  baseSettings: TSettings | undefined,
  overrideSettings: TSettings | undefined,
): TSettings => {
  const merged = { ...(baseSettings || {}), ...(overrideSettings || {}) } as TSettings;
  if (baseSettings?.output || overrideSettings?.output) {
    merged.output = {
      ...(baseSettings?.output || {}),
      ...(overrideSettings?.output || {}),
    };
  }
  return merged;
};

export { createReactWorkflowId, createSettingsDependencyKey, mergeSettingsWithOutput };
