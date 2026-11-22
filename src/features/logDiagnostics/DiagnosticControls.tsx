import {
  Badge,
  Checkbox as MantineCheckbox,
  NativeSelect as MantineNativeSelect,
  TextInput as MantineTextInput,
  type BadgeProps,
} from "@mantine/core";
export { FeatureButton as DiagnosticButton } from "../../components/FeatureButton";

export function DiagnosticBadge({ className = "", ...props }: BadgeProps) {
  return <Badge className={className} classNames={{ label: className }} {...props} />;
}

export const DiagnosticInput = MantineTextInput;
export const DiagnosticSelect = MantineNativeSelect;
export const DiagnosticCheckbox = MantineCheckbox;
