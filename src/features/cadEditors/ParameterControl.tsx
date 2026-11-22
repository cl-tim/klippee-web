import { Checkbox, NativeSelect, NumberInput, Stack, Text, TextInput } from "@mantine/core";
import { useId } from "react";
import { FieldLabel, HelpRow } from "../../components/FieldHelp";

export type ParameterControlValue = string | number | boolean;

export type ParameterControlOption = string | { label: string; value: ParameterControlValue };

export type ParameterControlField = {
  description?: string;
  key: string;
  label: string;
  max?: number;
  min?: number;
  options?: readonly ParameterControlOption[];
  step?: number;
  type: "boolean" | "number" | "select" | "text";
};

function optionLabel(option: ParameterControlOption) {
  return typeof option === "string" ? option : option.label;
}

function optionValue(option: ParameterControlOption): ParameterControlValue {
  return typeof option === "string" ? option : option.value;
}

/**
 * Shared Customizer field control used by the OpenSCAD workspace and the
 * focused CAD editors. Select options may be plain strings or typed
 * label/value pairs; typed values round-trip through the select unchanged.
 */
export function ParameterControl({
  parameter,
  value,
  onChange,
}: {
  parameter: ParameterControlField;
  value: ParameterControlValue;
  onChange: (value: ParameterControlValue) => void;
}) {
  const inputId = useId();
  if (parameter.type === "boolean") {
    const checkbox = <Checkbox checked={Boolean(value)} label={parameter.label} onChange={(event) => onChange(event.currentTarget.checked)} />;
    return (
      <div className="openscad-toggle-row">
        {parameter.description ? <HelpRow label={parameter.label} help={parameter.description}>{checkbox}</HelpRow> : checkbox}
      </div>
    );
  }
  return (
    <Stack className="field openscad-parameter-field" gap={6}>
      <div className="openscad-parameter-copy">
        {parameter.description ? <FieldLabel label={parameter.label} htmlFor={inputId}>{parameter.description}</FieldLabel>
          : <Text component="label" htmlFor={inputId} fw={600} size="sm">{parameter.label}</Text>}
      </div>
      {parameter.type === "select" ? (
        <NativeSelect
          id={inputId}
          aria-label={parameter.label}
          data={parameter.options?.map((option) => ({
            label: optionLabel(option),
            value: String(optionValue(option)),
          }))}
          onChange={(event) => {
            const nextValue = event.currentTarget.value;
            const option = parameter.options?.find(
              (candidate) => String(optionValue(candidate)) === nextValue,
            );
            onChange(option !== undefined ? optionValue(option) : nextValue);
          }}
          value={String(value)}
        />
      ) : parameter.type === "number" ? (
        <NumberInput
          id={inputId}
          aria-label={parameter.label}
          max={parameter.max}
          min={parameter.min}
          onChange={(nextValue) => onChange(typeof nextValue === "number" ? nextValue : Number(nextValue))}
          step={parameter.step}
          value={Number(value)}
        />
      ) : (
        <TextInput id={inputId} aria-label={parameter.label} onChange={(event) => onChange(event.currentTarget.value)} value={String(value)} />
      )}
    </Stack>
  );
}
