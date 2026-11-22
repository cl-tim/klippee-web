export function formatUploadAge(value: string, now = Date.now()) {
  const elapsed = Math.max(0, now - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatEventTime(time: number | null) {
  return time === null ? "Unknown" : `T+${time.toFixed(3)}s`;
}

export function formatDuration(seconds: number) {
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

export function numericField(value: number | string | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatWallTime(value: number | null) {
  return value === null ? "Not recorded" : new Date(value * 1_000).toLocaleString();
}

export function formatOptional(value: number | null) {
  return value === null ? "Not recorded" : value.toFixed(2);
}

export function formatMemory(value: number | null) {
  return value === null ? "Not recorded" : `${value.toFixed(1)} MiB`;
}

export function signed(value: number) {
  return `${value >= 0 ? "+" : ""}${value}`;
}

/**
 * Thin dense telemetry down to at most `maximum` points for charting, always
 * keeping the final point so trend lines end on the newest sample.
 */
export function downsamplePoints<T>(points: T[], maximum: number) {
  if (points.length <= maximum) return points;
  const step = Math.ceil(points.length / maximum);
  return points.filter((_, index) => index % step === 0 || index === points.length - 1);
}
