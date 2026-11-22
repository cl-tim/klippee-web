import type { DesiredConfiguration } from "./desiredConfiguration";
import type { PrinterRow, RepositoryRow, RepositoryVersionRow, StoredConfigFile } from "./types";
import { base64, shellQuote } from "./util";

function syncMetadataValue(value: unknown) {
  // Sync metadata is a line-oriented format and is embedded in a shell
  // heredoc. Removing control characters prevents a stored value from ending
  // the heredoc or injecting additional protocol fields/commands.
  // eslint-disable-next-line no-control-regex
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ");
}

export function buildSyncStatusText({
  desired,
  printer,
  repository,
  repositoryId,
}: {
  desired: DesiredConfiguration | null;
  printer: PrinterRow | null;
  repository: Pick<RepositoryRow, "id" | "name"> | null;
  repositoryId: string;
}) {
  return [
    `repository_id=${syncMetadataValue(repository?.id ?? repositoryId)}`,
    `repository_name=${syncMetadataValue(repository?.name)}`,
    `printer_id=${syncMetadataValue(printer?.id)}`,
    `printer_name=${syncMetadataValue(printer?.name)}`,
    `applied_version=${syncMetadataValue(printer?.applied_version_id)}`,
    `applied_at=${syncMetadataValue(printer?.applied_at)}`,
    `target_version=${syncMetadataValue(desired?.version.version_number)}`,
    `target_id=${syncMetadataValue(desired?.version.id)}`,
    `target_revision=${syncMetadataValue(desired?.revision)}`,
    `target_pending=${desired?.pending ? "1" : "0"}`,
    `target_source=${syncMetadataValue(desired?.version.source)}`,
    `target_created_at=${syncMetadataValue(desired?.version.created_at)}`,
    `target_message=${syncMetadataValue(desired?.version.message)}`,
    "",
  ].join("\n");
}

export function buildSyncSnapshotShellScript({
  files,
  printer,
  repositoryId,
  revision,
  version,
}: {
  files: StoredConfigFile[];
  printer: Pick<PrinterRow, "id"> | null;
  repositoryId: string;
  revision: string;
  version: Pick<RepositoryVersionRow, "created_at" | "source" | "version_number"> & { id: string | null };
}) {
  const encoder = new TextEncoder();
  const lines = [
    "#!/bin/sh",
    "set -eu",
    'target="${1:-.}"',
    `version=${shellQuote(String(version.version_number))}`,
    'stamp="$(date +%Y%m%d-%H%M%S 2>/dev/null || date)"',
    'fail() { echo "klippee: $*" >&2; exit 1; }',
    'mkdir -p "$target"',
    'target="$(cd "$target" && pwd -P)"',
    '[ ! -L "$target/.klippee" ] || fail "refusing linked state directory: $target/.klippee"',
    '[ ! -L "$target/.klippee/backups" ] || fail "refusing linked backup directory: $target/.klippee/backups"',
    '[ ! -L "$target/.klippee/last-sync" ] || fail "refusing linked sync state: $target/.klippee/last-sync"',
    'assert_safe_path() { rel="$1"; case "$rel" in ""|/*|../*|*/../*|*/..|.|*/./*|*/.) fail "unsafe config path: $rel" ;; esac; current="$target"; remaining="${rel%/*}"; if [ "$remaining" != "$rel" ]; then while :; do part="${remaining%%/*}"; current="$current/$part"; [ ! -L "$current" ] || fail "refusing linked config parent: $rel"; [ "$remaining" = "$part" ] && break; remaining="${remaining#*/}"; done; fi; [ ! -L "$target/$rel" ] || fail "refusing linked config file: $rel"; }',
    'decode_base64() { if command -v base64 >/dev/null 2>&1; then base64 -d; elif command -v openssl >/dev/null 2>&1; then openssl base64 -d -A; else echo "klippee: base64 or openssl is required" >&2; exit 1; fi; }',
    'write_file() { rel="$1"; dest="$target/$rel"; dir="$(dirname "$dest")"; mkdir -p "$dir"; if [ -f "$dest" ]; then mkdir -p "$backup/$(dirname "$rel")"; cp "$dest" "$backup/$rel"; fi; decode_base64 > "$dest"; }',
  ];

  for (const file of files) {
    lines.push(`assert_safe_path ${shellQuote(file.path)}`);
  }

  lines.push('backup_root="$target/.klippee/backups"');
  lines.push('backup="$backup_root/v${version}-$stamp"');
  lines.push('mkdir -p "$backup_root"');
  lines.push('mkdir "$backup" || fail "backup already exists: $backup"');

  for (const file of files) {
    lines.push(`write_file ${shellQuote(file.path)} <<'KLIPPEE_FILE'`);
    lines.push(base64(encoder.encode(file.content)));
    lines.push("KLIPPEE_FILE");
  }

  lines.push('mkdir -p "$target/.klippee"');
  lines.push(`cat > "$target/.klippee/last-sync" <<'KLIPPEE_SYNC'`);
  lines.push(`repository_id=${syncMetadataValue(repositoryId)}`);
  lines.push(`printer_id=${syncMetadataValue(printer?.id)}`);
  lines.push(`version=${syncMetadataValue(version.version_number)}`);
  lines.push(`version_id=${syncMetadataValue(version.id)}`);
  lines.push(`revision=${syncMetadataValue(revision)}`);
  lines.push(`created_at=${syncMetadataValue(version.created_at)}`);
  lines.push(`source=${syncMetadataValue(version.source)}`);
  lines.push("KLIPPEE_SYNC");
  lines.push('echo "klippee: applied version $version to $target"');
  lines.push('echo "klippee: backup directory $backup"');
  lines.push("");

  return lines.join("\n");
}
