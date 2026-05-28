import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import Save from "lucide-react/dist/esm/icons/save.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { APP_BUILD_VERSION } from "./build-version.ts";
import { InfoToggle } from "./components/info-toggle.tsx";
import type { SettingsDraftState, SettingsFieldKey, SettingsUiState } from "./settings/settings-state.ts";
import {
  getSettingsFieldDefaultValue,
  getSettingsFieldMax,
  getSettingsFieldMin,
  getSettingsFieldPlaceholder,
  getSettingsFieldSuggestion,
  getSettingsFieldSuggestionDataLocalize,
  isSettingsFieldDisabled,
  SETTINGS_FIELD_ID_TO_KEY,
  SETTINGS_FIELD_METADATA,
  SETTINGS_PANEL_FIELD_ORDER,
} from "./settings/settings-state.ts";
import { buttonClasses, cx, formClasses, settingsClasses, tabClasses } from "./tailwind-classes.ts";
import type { ValidationState, WorkflowView } from "./webapp-state-types.ts";

type TabProps = {
  currentView: WorkflowView;
  onSelectView: (mode: WorkflowView) => void;
};

type SettingsPanelProps = {
  draftSettings: SettingsDraftState;
  uiState: SettingsUiState;
  validation: ValidationState;
  onDraftChange: (field: SettingsFieldKey, value: string | boolean) => void;
  onClose: () => void;
  onRestoreDefaults: () => void;
  onSaveClose: () => void;
};

type SettingsFieldRowProps = Pick<SettingsPanelProps, "draftSettings" | "uiState" | "validation" | "onDraftChange"> & {
  fieldKey: SettingsFieldKey;
};

const settingsPanelSections: Array<{ fields: SettingsFieldKey[]; title: string }> = [
  {
    fields: ["requireInputChecksumMatch", "requireOutputChecksumMatch"],
    title: "Validation",
  },
  {
    fields: ["fixChecksum"],
    title: "Compatibility",
  },
  {
    fields: ["compressionProfile"],
    title: "Output",
  },
  {
    fields: ["sevenZipCodec", "sevenZipLevel", "zipCodec", "zipLevel"],
    title: "ZIP / 7z",
  },
  {
    fields: ["rvzCompression", "rvzCompressionLevel", "rvzBlockSize", "rvzScrub"],
    title: "RVZ",
  },
  {
    fields: ["chdCreateCdCodecs", "chdCreateDvdCodecs"],
    title: "CHD",
  },
  {
    fields: ["z3dsCompressionLevel"],
    title: "Z3DS",
  },
  {
    fields: ["workerThreads"],
    title: "Workers",
  },
  {
    fields: ["language", "logLevel", "erudaDevTools"],
    title: "Logging",
  },
];

const tabClassName = (currentView: WorkflowView, tabMode: WorkflowView) =>
  [currentView === tabMode ? `active ${tabClasses.buttonActive}` : "", tabClasses.button].filter(Boolean).join(" ");

const settingsSelectClassName = cx(formClasses.select, formClasses.invalid, settingsClasses.control);
const settingsTextClassName = cx(formClasses.base, formClasses.disabled, formClasses.invalid, settingsClasses.control);
const settingsRangeClassName = cx(settingsClasses.compressionRange, formClasses.invalid);

type RuntimeDiagnostics = {
  serviceWorkers: Array<{ scope: string; active: string; waiting: string; installing: string }>;
  workers: string[];
  wasm: Array<{ id: string; label: string; url: string }>;
};

type RuntimeDiagnosticMessage = {
  context?: string;
  contextUrl?: string;
  failureMessage?: string;
  id?: string;
  kind?: string;
  name?: string;
  reason?: string;
  threaded?: boolean;
  url?: string;
};

const emptyRuntimeDiagnostics = (): RuntimeDiagnostics => ({
  serviceWorkers: [],
  wasm: [],
  workers: [],
});

const formatResourceName = (name: string): string => {
  try {
    const url = new URL(name, window.location.href);
    return `${url.pathname.split("/").pop() || url.pathname}${url.search}`;
  } catch (_err) {
    return name;
  }
};

const getWorkerScriptUrl = (worker?: ServiceWorker | null): string => worker?.scriptURL || "none";

const getWasmDiagnosticLabel = (source: {
  context?: string;
  contextUrl?: string;
  failureMessage?: string;
  name?: string;
  reason?: string;
  threaded?: boolean;
  url?: string;
}) => {
  const name = source.name || (source.url ? formatResourceName(source.url) : "unknown.wasm");
  let threading = "observed";
  if (source.threaded === true) threading = "threaded";
  else if (source.threaded === false) threading = "single-threaded";
  const reason = source.reason ? `, ${source.reason}` : "";
  const context = source.context ? ` - ${source.context}` : "";
  const contextUrl = source.contextUrl ? ` - ${formatResourceName(source.contextUrl)}` : "";
  const failureMessage = source.failureMessage ? ` - ${source.failureMessage}` : "";
  return `${name} (${threading}${reason}${context}${contextUrl}${failureMessage})`;
};

const mergeWasmDiagnostics = (
  current: RuntimeDiagnostics["wasm"],
  nextItems: RuntimeDiagnostics["wasm"],
): RuntimeDiagnostics["wasm"] => {
  const byKey = new Map<string, { id: string; label: string; url: string }>();
  for (const item of current.concat(nextItems)) byKey.set(item.id || item.url || item.label, item);
  return Array.from(byKey.values()).sort((a, b) => a.label.localeCompare(b.label));
};

const runtimeDiagnosticMessages: RuntimeDiagnosticMessage[] = [];
let runtimeDiagnosticChannel: BroadcastChannel | null = null;
let runtimeDiagnosticListenerInstalled = false;

const readBufferedWasmDiagnostics = (): RuntimeDiagnostics["wasm"] => {
  return runtimeDiagnosticMessages
    .filter((message) => message.kind === "wasm")
    .map((message) => {
      const url = typeof message.url === "string" ? message.url : String(message.name || "unknown.wasm");
      return {
        id: typeof message.id === "string" ? message.id : url,
        label: getWasmDiagnosticLabel({
          context: typeof message.context === "string" ? message.context : undefined,
          contextUrl: typeof message.contextUrl === "string" ? message.contextUrl : undefined,
          failureMessage: typeof message.failureMessage === "string" ? message.failureMessage : undefined,
          name: typeof message.name === "string" ? message.name : undefined,
          reason: typeof message.reason === "string" ? message.reason : undefined,
          threaded: typeof message.threaded === "boolean" ? message.threaded : undefined,
          url,
        }),
        url,
      };
    });
};

const installRuntimeDiagnosticBuffer = () => {
  if (runtimeDiagnosticListenerInstalled) return;
  runtimeDiagnosticListenerInstalled = true;
  if (runtimeDiagnosticChannel) return;
  if (typeof BroadcastChannel !== "function") return;
  try {
    const channel = new BroadcastChannel("rom-weaver-runtime-diagnostics");
    channel.addEventListener("message", (event) => {
      const data = event.data || {};
      if (data.kind !== "wasm") return;
      runtimeDiagnosticMessages.push(data);
      if (runtimeDiagnosticMessages.length > 100) runtimeDiagnosticMessages.shift();
    });
    runtimeDiagnosticChannel = channel;
  } catch (_err) {
    runtimeDiagnosticChannel = null;
  }
};

installRuntimeDiagnosticBuffer();

const useRuntimeDiagnostics = (): RuntimeDiagnostics => {
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnostics>(() => ({
    ...emptyRuntimeDiagnostics(),
    wasm: readBufferedWasmDiagnostics(),
  }));

  useEffect(() => {
    let cancelled = false;

    const refreshDiagnostics = async () => {
      const next = emptyRuntimeDiagnostics();
      next.wasm = readBufferedWasmDiagnostics();
      if (typeof performance !== "undefined" && typeof performance.getEntriesByType === "function") {
        const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
        const observedWasm = Array.from(
          new Set(
            resources
              .filter((entry) => entry.name.includes(".wasm"))
              .map((entry) => entry.name)
              .sort(),
          ),
        ).map((url) => ({
          id: url,
          label: getWasmDiagnosticLabel({ url }),
          url,
        }));
        next.wasm = mergeWasmDiagnostics(next.wasm, observedWasm);
        next.workers = Array.from(
          new Set(
            resources
              .filter(
                (entry) =>
                  entry.initiatorType === "worker" ||
                  entry.name.includes(".worker.") ||
                  entry.name.includes("cache-service-worker") ||
                  entry.name.includes("_cache_service_worker") ||
                  entry.name.includes("dev-sw.js"),
              )
              .map((entry) => formatResourceName(entry.name))
              .sort(),
          ),
        );
      }

      if (typeof navigator !== "undefined" && navigator.serviceWorker?.getRegistrations) {
        try {
          const registrations = await navigator.serviceWorker.getRegistrations();
          next.serviceWorkers = registrations.map((registration) => ({
            active: formatResourceName(getWorkerScriptUrl(registration.active)),
            installing: formatResourceName(getWorkerScriptUrl(registration.installing)),
            scope: registration.scope,
            waiting: formatResourceName(getWorkerScriptUrl(registration.waiting)),
          }));
        } catch (_err) {
          next.serviceWorkers = [];
        }
      }

      if (!cancelled) setDiagnostics((current) => ({ ...next, wasm: mergeWasmDiagnostics(current.wasm, next.wasm) }));
    };

    const handleRuntimeDiagnostic = (event: MessageEvent) => {
      const data = event.data || {};
      if (data.kind !== "wasm") return;
      runtimeDiagnosticMessages.push(data);
      if (runtimeDiagnosticMessages.length > 100) runtimeDiagnosticMessages.shift();
      const url = typeof data.url === "string" ? data.url : String(data.name || "unknown.wasm");
      const item = {
        id: typeof data.id === "string" ? data.id : url,
        label: getWasmDiagnosticLabel({
          context: typeof data.context === "string" ? data.context : undefined,
          contextUrl: typeof data.contextUrl === "string" ? data.contextUrl : undefined,
          failureMessage: typeof data.failureMessage === "string" ? data.failureMessage : undefined,
          name: typeof data.name === "string" ? data.name : undefined,
          reason: typeof data.reason === "string" ? data.reason : undefined,
          threaded: typeof data.threaded === "boolean" ? data.threaded : undefined,
          url,
        }),
        url,
      };
      setDiagnostics((current) => ({ ...current, wasm: mergeWasmDiagnostics(current.wasm, [item]) }));
    };

    void refreshDiagnostics();
    const channel =
      typeof BroadcastChannel === "function" ? new BroadcastChannel("rom-weaver-runtime-diagnostics") : null;
    channel?.addEventListener("message", handleRuntimeDiagnostic);
    const interval = window.setInterval(refreshDiagnostics, 3000);
    return () => {
      cancelled = true;
      channel?.removeEventListener("message", handleRuntimeDiagnostic);
      channel?.close();
      window.clearInterval(interval);
    };
  }, []);

  return diagnostics;
};

function WorkflowTabs({ currentView, onSelectView }: TabProps) {
  return (
    <>
      <button
        aria-controls="rom-weaver-container"
        aria-selected={currentView === "patcher" ? "true" : "false"}
        className={tabClassName(currentView, "patcher")}
        id="tab-patcher"
        onClick={() => onSelectView("patcher")}
        role="tab"
        type="button"
      >
        Patcher
      </button>
      <button
        aria-controls="patch-builder-container"
        aria-selected={currentView === "creator" ? "true" : "false"}
        className={tabClassName(currentView, "creator")}
        id="tab-creator"
        onClick={() => onSelectView("creator")}
        role="tab"
        type="button"
      >
        Creator
      </button>
    </>
  );
}

const invalidProps = (validation: ValidationState, id: string) =>
  validation.invalidFields.includes(id)
    ? {
        "aria-invalid": true,
      }
    : {};

const handleSettingsEvent = (
  target: HTMLInputElement | HTMLSelectElement,
  onDraftChange: SettingsPanelProps["onDraftChange"],
) => {
  const fieldKey = SETTINGS_FIELD_ID_TO_KEY[target.id];
  if (!fieldKey) return;
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  if (field.kind === "checkbox") {
    onDraftChange(fieldKey, (target as HTMLInputElement).checked);
    return;
  }
  if (field.kind === "choice-checkbox") {
    const checked = (target as HTMLInputElement).checked;
    onDraftChange(fieldKey, checked ? field.checkedValue || "" : field.uncheckedValue || "");
    return;
  }
  onDraftChange(fieldKey, target.value);
};

const getFieldValue = (fieldKey: SettingsFieldKey, draftSettings: SettingsDraftState): string => {
  const value = draftSettings[fieldKey];
  if (value === undefined || value === null) {
    const defaultValue = getSettingsFieldDefaultValue(fieldKey);
    return defaultValue === undefined || defaultValue === null ? "" : String(defaultValue);
  }
  return String(value);
};

const getCheckboxValue = (fieldKey: SettingsFieldKey, draftSettings: SettingsDraftState): boolean => {
  const value = draftSettings[fieldKey];
  if (typeof value === "boolean") return value;
  return Boolean(getSettingsFieldDefaultValue(fieldKey));
};

const getChoiceCheckboxValue = (fieldKey: SettingsFieldKey, draftSettings: SettingsDraftState): string => {
  const value = draftSettings[fieldKey];
  if (typeof value === "string") return value;
  return String(getSettingsFieldDefaultValue(fieldKey));
};

const getFieldClasses = (fieldKey: SettingsFieldKey) => {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  return field.layout === "large"
    ? {
        label: settingsClasses.labelLarge,
        value: settingsClasses.valueLarge,
      }
    : {
        label: settingsClasses.label,
        value: settingsClasses.value,
      };
};

const renderFieldInfoToggle = (
  fieldKey: SettingsFieldKey,
  draftSettings: SettingsDraftState,
  uiState: SettingsUiState,
) => {
  const suggestion = getSettingsFieldSuggestion(fieldKey, draftSettings, uiState);
  const suggestionDataLocalize = getSettingsFieldSuggestionDataLocalize(fieldKey, draftSettings, uiState);
  if (!suggestion) return null;
  return (
    <InfoToggle
      ariaLabel={`Show ${SETTINGS_FIELD_METADATA[fieldKey].label || fieldKey} details`}
      panelClassName={settingsClasses.infoPanel}
      portalPanel
      title={`Show ${SETTINGS_FIELD_METADATA[fieldKey].label || fieldKey} details`}
    >
      <div data-localize={typeof suggestionDataLocalize === "string" ? suggestionDataLocalize : undefined}>
        {suggestion}
      </div>
    </InfoToggle>
  );
};

const renderFieldLabel = (fieldKey: SettingsFieldKey) => {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  if (!field.label) return null;
  return (
    <label data-localize={field.labelDataLocalize} htmlFor={field.id}>
      {field.label}
    </label>
  );
};

function SettingsFieldRowLayout({
  fieldKey,
  info,
  children,
}: {
  fieldKey: SettingsFieldKey;
  info?: ReactNode;
  children: ReactNode;
}) {
  const fieldClasses = getFieldClasses(fieldKey);
  return (
    <div className={settingsClasses.row}>
      <div className={fieldClasses.label}>
        <span className={settingsClasses.labelWithInfo}>
          {renderFieldLabel(fieldKey)}
          {info}
        </span>
      </div>
      <div className={fieldClasses.value}>{children}</div>
    </div>
  );
}

function SettingsCheckboxField({
  fieldKey,
  checked,
  disabled,
  onDraftChange,
}: {
  fieldKey: SettingsFieldKey;
  checked: boolean;
  disabled: boolean;
  onDraftChange: SettingsPanelProps["onDraftChange"];
}) {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  return (
    <input
      checked={checked}
      className={formClasses.checkbox}
      disabled={disabled}
      id={field.id}
      onChange={(event) => handleSettingsEvent(event.currentTarget, onDraftChange)}
      type="checkbox"
    />
  );
}

function SettingsScalarInputField({
  fieldKey,
  type,
  value,
  disabled,
  placeholder,
  min,
  max,
  validation,
  onDraftChange,
}: {
  fieldKey: SettingsFieldKey;
  type: "text" | "number";
  value: string;
  disabled: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  validation: ValidationState;
  onDraftChange: SettingsPanelProps["onDraftChange"];
}) {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  return (
    <input
      className={settingsTextClassName}
      disabled={disabled}
      id={field.id}
      max={type === "number" ? max : undefined}
      min={type === "number" ? min : undefined}
      onChange={(event) => handleSettingsEvent(event.currentTarget, onDraftChange)}
      placeholder={placeholder}
      step={type === "number" ? field.step : undefined}
      type={type}
      value={value}
      {...invalidProps(validation, field.id)}
    />
  );
}

function SettingsFieldRow({ fieldKey, draftSettings, uiState, validation, onDraftChange }: SettingsFieldRowProps) {
  const field = SETTINGS_FIELD_METADATA[fieldKey];
  const disabled = isSettingsFieldDisabled(fieldKey, draftSettings, uiState);
  const placeholder = getSettingsFieldPlaceholder(fieldKey, draftSettings, uiState);
  const min = getSettingsFieldMin(fieldKey, draftSettings, uiState);
  const max = getSettingsFieldMax(fieldKey, draftSettings, uiState);
  const info = renderFieldInfoToggle(fieldKey, draftSettings, uiState);

  if (field.kind === "hidden") return null;

  if (field.kind === "checkbox") {
    return (
      <SettingsFieldRowLayout fieldKey={fieldKey} info={info}>
        <SettingsCheckboxField
          checked={getCheckboxValue(fieldKey, draftSettings)}
          disabled={disabled}
          fieldKey={fieldKey}
          onDraftChange={onDraftChange}
        />
      </SettingsFieldRowLayout>
    );
  }

  if (field.kind === "choice-checkbox") {
    return (
      <SettingsFieldRowLayout fieldKey={fieldKey} info={info}>
        <SettingsCheckboxField
          checked={getChoiceCheckboxValue(fieldKey, draftSettings) === field.checkedValue}
          disabled={disabled}
          fieldKey={fieldKey}
          onDraftChange={onDraftChange}
        />
      </SettingsFieldRowLayout>
    );
  }

  if (field.kind === "select") {
    return (
      <SettingsFieldRowLayout fieldKey={fieldKey} info={info}>
        <select
          className={settingsSelectClassName}
          disabled={disabled}
          id={field.id}
          onChange={(event) => handleSettingsEvent(event.currentTarget, onDraftChange)}
          value={getFieldValue(fieldKey, draftSettings)}
          {...invalidProps(validation, field.id)}
        >
          {(field.options || []).map((option) => (
            <option key={`${field.id}-${option.value}`} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </SettingsFieldRowLayout>
    );
  }

  if (field.kind === "text") {
    return (
      <SettingsFieldRowLayout fieldKey={fieldKey} info={info}>
        <SettingsScalarInputField
          disabled={disabled}
          fieldKey={fieldKey}
          onDraftChange={onDraftChange}
          placeholder={placeholder}
          type="text"
          validation={validation}
          value={getFieldValue(fieldKey, draftSettings)}
        />
      </SettingsFieldRowLayout>
    );
  }

  if (field.kind === "number") {
    const inputType = fieldKey === "workerThreads" ? "text" : "number";
    return (
      <SettingsFieldRowLayout fieldKey={fieldKey} info={info}>
        <SettingsScalarInputField
          disabled={disabled}
          fieldKey={fieldKey}
          max={max}
          min={min}
          onDraftChange={onDraftChange}
          placeholder={placeholder}
          type={inputType}
          validation={validation}
          value={getFieldValue(fieldKey, draftSettings)}
        />
      </SettingsFieldRowLayout>
    );
  }

  if (field.kind === "range") {
    const scaleLabels = field.scaleLabels || [];
    const scaleStepCount = Math.max(1, scaleLabels.length - 1);

    return (
      <div className={settingsClasses.rangeRow}>
        <div className={settingsClasses.rangeHeader}>
          <div className={settingsClasses.rangeLabelBlock}>
            <span className={settingsClasses.labelWithInfo}>
              {renderFieldLabel(fieldKey)}
              {info}
            </span>
          </div>
        </div>
        <div className={settingsClasses.compressionControl}>
          <input
            className={settingsRangeClassName}
            id={field.id}
            max={max}
            min={min}
            onChange={(event) => handleSettingsEvent(event.currentTarget, onDraftChange)}
            onInput={(event) => handleSettingsEvent(event.currentTarget, onDraftChange)}
            step={field.step}
            type="range"
            value={uiState.compressionProfileIndex}
            {...invalidProps(validation, field.id)}
          />
          <div aria-hidden="true" className={settingsClasses.compressionScale}>
            {scaleLabels.map((label, index) => (
              <span
                className={settingsClasses.compressionScaleLabel}
                data-localize={label}
                key={`${field.id}-${label}`}
                style={
                  {
                    "--compression-scale-position": `${(index / scaleStepCount) * 100}%`,
                  } as CSSProperties
                }
              >
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return null;
}

function RuntimeDiagnosticsList({
  items,
  emptyLabel,
}: {
  items: Array<string | { key: string; label: string }>;
  emptyLabel: string;
}) {
  if (!items.length) return <span>{emptyLabel}</span>;
  return (
    <ul className="m-0 list-none space-y-0.5 p-0">
      {items.map((item) => {
        const key = typeof item === "string" ? item : item.key;
        const label = typeof item === "string" ? item : item.label;
        return (
          <li className="break-all font-mono text-[11px] leading-[1.25]" key={key}>
            {label}
          </li>
        );
      })}
    </ul>
  );
}

function RuntimeDiagnosticsPanel() {
  const diagnostics = useRuntimeDiagnostics();
  const serviceWorkerItems = diagnostics.serviceWorkers.flatMap((registration, index) => [
    `scope ${index + 1}: ${registration.scope}`,
    `active: ${registration.active}`,
    `waiting: ${registration.waiting}`,
    `installing: ${registration.installing}`,
  ]);

  return (
    <section className={settingsClasses.section}>
      <h3 className={settingsClasses.sectionTitle}>Version / Runtime</h3>
      <div className="grid gap-2 text-left text-[12px] leading-[1.3] text-[#4f5757]">
        <div>
          <div className="font-bold text-[#243232]">Version</div>
          <div className="break-all font-mono text-[11px]">{APP_BUILD_VERSION}</div>
        </div>
        <div>
          <div className="font-bold text-[#243232]">Service workers</div>
          <RuntimeDiagnosticsList emptyLabel="No service worker registrations" items={serviceWorkerItems} />
        </div>
        <div>
          <div className="font-bold text-[#243232]">Loaded workers</div>
          <RuntimeDiagnosticsList emptyLabel="No worker resources observed yet" items={diagnostics.workers} />
        </div>
        <div>
          <div className="font-bold text-[#243232]">Loaded WASM</div>
          <RuntimeDiagnosticsList
            emptyLabel="No WASM resources observed yet"
            items={diagnostics.wasm.map((item) => ({ key: item.id, label: item.label }))}
          />
        </div>
      </div>
    </section>
  );
}

function SettingsPanel({ draftSettings, uiState, validation, onDraftChange }: SettingsPanelProps) {
  return (
    <div className={settingsClasses.panel}>
      {settingsPanelSections.map((section) => (
        <section className={settingsClasses.section} key={section.fields.join("-")}>
          <h3 className={settingsClasses.sectionTitle}>{section.title}</h3>
          <div className={settingsClasses.grid}>
            {section.fields
              .filter((fieldKey) => SETTINGS_PANEL_FIELD_ORDER.includes(fieldKey))
              .map((fieldKey) => (
                <SettingsFieldRow
                  draftSettings={draftSettings}
                  fieldKey={fieldKey}
                  key={fieldKey}
                  onDraftChange={onDraftChange}
                  uiState={uiState}
                  validation={validation}
                />
              ))}
          </div>
        </section>
      ))}

      <div aria-live="polite" className={settingsClasses.validation} id="settings-validation-message" role="alert">
        {validation.messages.join(" ")}
      </div>
      <RuntimeDiagnosticsPanel />
    </div>
  );
}

function SettingsHeaderActions({
  onClose,
  onRestoreDefaults,
  onSaveClose,
}: Pick<SettingsPanelProps, "onClose" | "onRestoreDefaults" | "onSaveClose">) {
  return (
    <>
      <button
        aria-label="Restore defaults"
        className={cx(buttonClasses.primary, settingsClasses.actionButton, settingsClasses.actionWarning)}
        data-localize="Restore defaults"
        id="settings-restore-defaults"
        onClick={onRestoreDefaults}
        title="Restore defaults"
        type="button"
      >
        <RotateCcw aria-hidden="true" className={settingsClasses.actionIcon} />
      </button>
      <button
        aria-label="Save settings"
        className={cx(buttonClasses.primary, settingsClasses.actionButton, settingsClasses.actionSuccess)}
        data-localize="Save and close"
        id="settings-save-close"
        onClick={onSaveClose}
        title="Save settings"
        type="button"
      >
        <Save aria-hidden="true" className={settingsClasses.actionIcon} />
      </button>
      <button
        aria-label="Close settings"
        className={cx(buttonClasses.primary, settingsClasses.actionButton, settingsClasses.actionDanger)}
        id="settings-close"
        onClick={onClose}
        title="Close settings"
        type="button"
      >
        <X aria-hidden="true" className={settingsClasses.actionIcon} />
      </button>
    </>
  );
}

export { SettingsHeaderActions, SettingsPanel, WorkflowTabs };
