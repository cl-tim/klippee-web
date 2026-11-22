import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { OpenScadPanelDivider, OpenScadPanelRatios } from "./panelLayout";

/**
 * Accessible separator between two OpenSCAD workspace panels. Wire the
 * callbacks to `usePanelResize`; `divider` selects which pair it resizes.
 */
export function PanelResizeHandle({
  ariaLabel,
  divider,
  onBegin,
  onContinue,
  onEnd,
  onKey,
  onReset,
  panelRatios,
}: {
  ariaLabel: string;
  divider: OpenScadPanelDivider;
  onBegin: (divider: OpenScadPanelDivider, event: ReactPointerEvent<HTMLDivElement>) => void;
  onContinue: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onEnd: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKey: (divider: OpenScadPanelDivider, event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onReset: () => void;
  panelRatios: OpenScadPanelRatios;
}) {
  const total = panelRatios.reduce((sum, value) => sum + value, 0);
  const leading = divider === 0 ? panelRatios[0] : panelRatios[0] + panelRatios[1];
  return (
    <div
      aria-label={ariaLabel}
      aria-orientation="vertical"
      aria-valuemax={84}
      aria-valuemin={16}
      aria-valuenow={Math.round((leading / total) * 100)}
      className="openscad-resize-handle"
      onDoubleClick={onReset}
      onKeyDown={(event) => onKey(divider, event)}
      onPointerCancel={onEnd}
      onPointerDown={(event) => onBegin(divider, event)}
      onPointerMove={onContinue}
      onPointerUp={onEnd}
      role="separator"
      tabIndex={0}
      title="Drag to resize panels. Double-click or press Home to reset."
    />
  );
}
