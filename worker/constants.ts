import type { UserRow } from "./types";

export const sessionCookieName = "__Host-klippee_session";
export const oauthStateCookieName = "__Host-klippee_oauth_state";
export const sessionMaxAgeSeconds = 60 * 60 * 24 * 30;
export const oauthStateMaxAgeSeconds = 60 * 10;
export const maxJsonBodyBytes = 1_024_000;
export const renderedZipArtifactTtlSeconds = 60 * 60 * 24 * 90;
export const maxFilesPerPayload = 64;
export const maxConfigFileBytes = 256_000;
// Rendering may substitute the same request value into many placeholders.
// Keep the raw aggregate at the existing JSON payload bound so preview JSON
// escaping and ZIP buffer copies retain substantial headroom inside a 128 MB
// Worker isolate.
export const maxRenderedPackageBytes = maxJsonBodyBytes;
export const maxConfigPathLength = 180;
export const maxConfigRoleBytes = 64;
export const maxRepositoryVersionMessageBytes = 512;
export const maxRepositoryVersionSourceBytes = 64;
export const maxPrinterIdBytes = 128;
export const maxPrinterNameBytes = 256;
export const maxPrinterVariableValueBytes = 4_096;
export const maxPrinterVariableValuesBytes = 64 * 1_024;
// D1 permits at most 32 arguments per SQL function. json_remove's document is
// the first argument, leaving 31 paths for each scrub statement.
export const maxD1JsonRemovePathsPerStatement = 31;
export const maxStlBodyBytes = 24 * 1024 * 1024;
export const maxCadBodyBytes = 64 * 1024 * 1024;
export const maxDiagnosticUploadBytes = 16 * 1024 * 1024;
export const diagnosticUploadTtlSeconds = 60 * 60 * 48;
export const maxDiagnosticUploadsPerPrinter = 5;
export const maxDiagnosticUploadRowsPerPrinter = maxDiagnosticUploadsPerPrinter * 2;
export const uploadReservationTtlSeconds = 60 * 10;
export const logImprovementConsentVersion = "2026-07-24";
export const logImprovementSubmissionTtlSeconds = 60 * 60 * 24 * 90;
export const maxLogImprovementSubmissionBytes = 16 * 1024 * 1024;
export const maxLogImprovementOriginalBytes = 64 * 1024 * 1024;
export const maxLogImprovementSubmissionsPerUser = 20;
export const maxLogImprovementSubmissionRowsPerUser = maxLogImprovementSubmissionsPerUser * 2;
export const canonicalBlobWriteLeaseTtlSeconds = 60 * 60;
export const canonicalBlobReclaimGraceSeconds = 60 * 60 * 24 * 7;
export const maxCanonicalBlobReclaimsPerRequest = 10;

export const localDevUser: UserRow = {
  avatar_url: null,
  display_name: "Local Developer",
  id: "local-dev-user",
};
