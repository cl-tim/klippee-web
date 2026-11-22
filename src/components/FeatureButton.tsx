import { Button, type ButtonProps } from "@mantine/core";
import type { ComponentPropsWithoutRef } from "react";

type FeatureButtonProps = ButtonProps & Omit<ComponentPropsWithoutRef<"button">, keyof ButtonProps>;

export function FeatureButton({ className = "", ...props }: FeatureButtonProps) {
  const variant = className.includes("primary-action")
    ? "filled"
    : className.includes("danger-action")
    ? "outline"
    : className.includes("icon-button")
    ? "subtle"
    : "default";
  return (
    <Button
      className={className}
      color={className.includes("danger-action") ? "red" : undefined}
      variant={variant}
      styles={className.includes("icon-button") ? { root: { width: 44, height: 44, padding: 0 } } : undefined}
      {...props as ButtonProps}
    />
  );
}
