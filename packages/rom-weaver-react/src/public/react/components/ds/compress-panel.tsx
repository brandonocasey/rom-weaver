import type { ReactNode } from "react";
import type { CompressField } from "../../compress-options.ts";
import { type FormatOption, type OutputCompressPanel, OutputField } from "./output-card.tsx";

/**
 * Body of the output "Compress" collapsible: one labeled control per compression
 * field. Edits are forwarded as per-job overrides via `onChange(settingsKey,
 * value)`. Shared by the apply, create, and trim outputs.
 */
const CompressPanelBody = ({
  fields,
  onChange,
  disabled,
}: {
  fields: CompressField[];
  onChange: (key: string, value: string) => void;
  disabled?: boolean;
}) => (
  <>
    {fields.map((field) =>
      field.kind === "select" ? (
        <OutputField key={field.key} label={field.label}>
          <select
            aria-label={field.label}
            className="select"
            disabled={disabled}
            onChange={(event) => onChange(field.key, event.currentTarget.value)}
            value={field.value}
          >
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </OutputField>
      ) : (
        <OutputField key={field.key} label={field.label}>
          <input
            aria-label={field.label}
            className={field.mono ? "input mono" : "input"}
            disabled={disabled}
            onChange={(event) => onChange(field.key, event.currentTarget.value)}
            placeholder={field.placeholder}
            value={field.value}
          />
        </OutputField>
      ),
    )}
  </>
);

type OutputCompressionPanelConfig = {
  disabled?: boolean;
  fields?: CompressField[] | null;
  format?: string;
  formatId?: string;
  formatLabel?: string;
  formatOptions?: FormatOption[];
  formatValue?: string;
  onFieldChange?: (key: string, value: string) => void;
  onFormatChange?: (value: string) => void;
  summary?: ReactNode;
  timing?: ReactNode;
};

type CompressionFormatLabelOptions = {
  noneLabel?: string;
  uncompressedValues?: string[];
};

const getOutputCompressionFormatLabel = (
  formatValue: string,
  formatOptions: FormatOption[],
  { noneLabel = "None", uncompressedValues = ["none"] }: CompressionFormatLabelOptions = {},
) =>
  uncompressedValues.includes(formatValue)
    ? noneLabel
    : formatOptions.find((option) => option.value === formatValue)?.label;

const buildOutputCompressionPanel = ({
  disabled,
  fields,
  format,
  formatId,
  formatLabel = "Type",
  formatOptions,
  formatValue,
  onFieldChange,
  onFormatChange,
  summary,
  timing,
}: OutputCompressionPanelConfig): OutputCompressPanel => ({
  children:
    fields?.length && onFieldChange ? (
      <CompressPanelBody disabled={disabled} fields={fields} onChange={onFieldChange} />
    ) : null,
  format,
  formatId,
  formatLabel,
  formatOptions,
  formatValue,
  onFormatChange,
  summary,
  timing,
});

export {
  buildOutputCompressionPanel,
  CompressPanelBody,
  getOutputCompressionFormatLabel,
  type OutputCompressionPanelConfig,
};
