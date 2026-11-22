import { printerResponse } from "./printerShared";
import type { DesiredConfiguration } from "./desiredConfiguration";
import type { PrinterRow, RepositoryRow } from "./types";

type LatestRepositoryVersion = {
  created_at: string;
  id: string;
  message: string;
  source: string;
  version_number: number;
} | null;

export function buildRepositorySyncStatus({
  desired,
  latest,
  printer,
  repository,
}: {
  desired: DesiredConfiguration | null;
  latest: LatestRepositoryVersion;
  printer: PrinterRow | null;
  repository: RepositoryRow;
}) {
  const targetVersionNumber = desired?.version.version_number ?? latest?.version_number ?? 0;
  const appliedVersionNumber = printer?.applied_version_id ?? 0;

  type PrinterMetadata = ReturnType<typeof printerResponse>;
  const printerMetadata:
    | (Omit<PrinterMetadata, "variableValues"> & Partial<Pick<PrinterMetadata, "variableValues">>)
    | null = printer ? printerResponse(printer) : null;
  if (printerMetadata) {
    // Sync status updates applied/version metadata only. Variable values have
    // a dedicated strongly-consistent API and must not overwrite host-local
    // values when the UI polls this route.
    delete printerMetadata.variableValues;
  }

  return {
    appliedVersion: printer
      ? {
          version_number: printer.applied_version_id,
        }
      : null,
    latestVersion: latest,
    pendingConfiguration: desired?.pending
      ? {
          fileCount: desired.files.length,
          revision: desired.revision,
          updatedAt: desired.version.created_at,
        }
      : null,
    printer: printerMetadata,
    repository,
    targetVersionNumber,
    targetRevision: desired?.revision ?? null,
    updateAvailable: Boolean(desired?.pending || targetVersionNumber !== appliedVersionNumber),
  };
}
