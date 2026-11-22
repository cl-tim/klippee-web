export type OpenScadPanelRatios = [number, number, number];
export type OpenScadPanelWidths = [number, number, number];
export type OpenScadPanelDivider = 0 | 1;

export const equalOpenScadPanelRatios: OpenScadPanelRatios = [1, 1, 1];
export const minimumOpenScadPanelWidths: OpenScadPanelWidths = [280, 360, 280];

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function normalizeOpenScadPanelRatios(values: number[]): OpenScadPanelRatios | null {
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    return null;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map((value) => value / total) as OpenScadPanelRatios;
}

export function resizeOpenScadPanelWidths(
  widths: OpenScadPanelWidths,
  divider: OpenScadPanelDivider,
  delta: number,
): OpenScadPanelWidths {
  const next = [...widths] as OpenScadPanelWidths;
  const leftIndex = divider;
  const rightIndex = divider + 1;
  const pairWidth = widths[leftIndex] + widths[rightIndex];
  const nextLeftWidth = clamp(
    widths[leftIndex] + delta,
    minimumOpenScadPanelWidths[leftIndex],
    pairWidth - minimumOpenScadPanelWidths[rightIndex],
  );
  next[leftIndex] = nextLeftWidth;
  next[rightIndex] = pairWidth - nextLeftWidth;
  return next;
}

export function nudgeOpenScadPanelRatios(
  ratios: OpenScadPanelRatios,
  divider: OpenScadPanelDivider,
  delta: number,
): OpenScadPanelRatios {
  const normalized = normalizeOpenScadPanelRatios(ratios) ?? [...equalOpenScadPanelRatios];
  const next = [...normalized] as OpenScadPanelRatios;
  const leftIndex = divider;
  const rightIndex = divider + 1;
  const pairRatio = normalized[leftIndex] + normalized[rightIndex];
  const nextLeftRatio = clamp(normalized[leftIndex] + delta, 0.16, pairRatio - 0.16);
  next[leftIndex] = nextLeftRatio;
  next[rightIndex] = pairRatio - nextLeftRatio;
  return next;
}
