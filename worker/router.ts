import { createOrcaDeviceUpload, setOrcaDeviceUploads, pairOrcaDevice, listOrcaDevices, revokeOrcaDevice, disconnectOrcaDevice } from "./routes/orcaDevices";
import { isTrustedOrigin, json, requiresBrowserOriginCheck } from "./http";
import { dispatchRoute, type Route } from "./route";
import {
  getAppState,
  getLinkedProvidersForRequest,
  getSessionUser,
  handleOAuthCallback,
  logout,
  saveAppState,
  startOAuth,
  usesLocalWorkspace,
} from "./routes/auth";
import {
  getCompanionAsset,
  getPublicCompanionAsset,
  getPublicConfigOrcaProfiles,
  listCompanionAssets,
  listPublicCompanionAssets,
  publishCompanionAsset,
  saveCompanionAsset,
} from "./routes/companionAssets";
import { healthCheck } from "./routes/health";
import { createOrcaGrant, revokeOrcaGrant, orcaCaptureContext, saveOrcaSetup, listOrcaSetups, getOrcaSetup, deleteOrcaSetup } from "./routes/orcaSetups";
import { saveOrcaLibrary, getOrcaLibrary, linkOrcaProfile, exportOrcaLibrary, browseOrcaLibrary, fetchOrcaProfile } from "./routes/orcaLibrary";
import { reviewOrcaPublication, publishOrcaProfile, unpublishOrcaProfile, updateOrcaPublicationSettings } from "./routes/orcaPublications";
import {
  deleteDiagnosticUpload,
  getDiagnosticUpload,
  listDiagnosticUploads,
  uploadPrinterDiagnostic,
} from "./routes/diagnosticUploads";
import {
  createLogImprovementSubmission,
  deleteLogImprovementSubmission,
  getLogImprovementSubmissionForReview,
  listLogImprovementSubmissionsForReview,
} from "./routes/logImprovementSubmissions";
import {
  downloadPackageZip,
  getPackage,
  getPrivatePackage,
  getPublicPackageApprovalStatus,
  listPackages,
  listPrivatePackages,
  publishPackage,
  renderPackagePreview,
  savePrivatePackage,
  updatePublicPackageListing,
  setPublicPackageAutoUpdate,
} from "./routes/packages";
import {
  deletePrinter,
  getPrinterPublicationCandidate,
  listPrinters,
  patchPrinterVariable,
  upsertPrinter,
} from "./routes/printers";
import {
  createRepository,
  deleteRepository,
  createRepositoryVersion,
  stageRepositoryPending,
  deleteRepositoryVersion,
  diffRepositoryVersions,
  forkRepository,
  getRepositorySyncStatus,
  listRepositories,
  listRepositoryVersions,
  restoreRepositoryFile,
} from "./routes/repositories";
import {
  syncMarkApplied,
  syncListVersions,
  syncPullRepository,
  syncPushRepository,
  syncReportHostInfo,
  syncRollbackRepository,
  syncSnapshotShell,
  syncStatusText,
} from "./routes/sync";
import { createSyncToken, deleteSyncToken, listSyncTokens } from "./routes/syncTokens";
import { deletePrivatePackage, listPrivatePackagesForManagement } from "./routes/privatePackageDeletion";
import { deleteCompanionAsset } from "./routes/companionAssetDeletion";
import { proxyCad } from "./routes/cad";
import { importScadFromUrl } from "./routes/scadImports";
import {
  listCanonicalReclaimsForMaintenance,
  listCanonicalReferencesForMaintenance,
  listLegacyReferencesForMaintenance,
  listStorageObjectsForMaintenance,
  reclaimCanonicalBlobsForMaintenance,
} from "./routes/storageMaintenance";
import type { Env } from "./types";
import { isProvider } from "./util";

async function authMe(request: Request, env: Env) {
  const user = await getSessionUser(request, env);
  const providers = user ? await getLinkedProvidersForRequest(request, env, user.id) : [];
  return json({
    user: user
      ? {
          avatarUrl: user.avatar_url,
          displayName: user.display_name,
          id: user.id,
          providers,
          ...(usesLocalWorkspace(env) ? { mode: "local" } : {}),
        }
      : null,
  });
}

async function listPackagesRoute(request: Request, env: Env, _params: unknown, url: URL) {
  return listPackages(
    env,
    {
      printer: url.searchParams.get("printer") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      tag: url.searchParams.get("tag") ?? undefined,
    },
    request,
  );
}

const routes: Route[] = [
  // Bounded remote OpenSCAD import (must precede the stateless CAD wildcard)
  { method: "POST", pattern: "/api/cad/import-scad", handler: (req, env) => importScadFromUrl(req, env) },

  // Stateless CAD proxy (catches any sub-path)
  { method: ["GET", "HEAD", "POST", "OPTIONS"], pattern: "/api/cad/*", handler: (req, env, params) => proxyCad(req, env, params.rest.split("/")) },

  // Auth + session
  { method: "GET", pattern: "/api/auth/me", handler: authMe },
  { method: "POST", pattern: "/api/auth/logout", handler: (req, env) => logout(req, env) },
  { method: "GET", pattern: "/api/auth/:provider/start", handler: (req, env, params) => isProvider(params.provider) ? startOAuth(req, env, params.provider) : json({ error: "Unknown provider" }, { status: 404 }) },
  { method: "GET", pattern: "/api/auth/:provider/callback", handler: (req, env, params) => isProvider(params.provider) ? handleOAuthCallback(req, env, params.provider) : json({ error: "Unknown provider" }, { status: 404 }) },

  // App state
  { method: "GET", pattern: "/api/app-state", handler: (req, env) => getAppState(req, env) },
  { method: "PUT", pattern: "/api/app-state", handler: (req, env) => saveAppState(req, env) },

  // Repositories
  { method: "GET", pattern: "/api/repos", handler: listRepositories },
  { method: "POST", pattern: "/api/repos", handler: createRepository },
  { method: "DELETE", pattern: "/api/repos/:id", handler: deleteRepository },
  { method: "GET", pattern: "/api/repos/:id/versions", handler: listRepositoryVersions },
  { method: "POST", pattern: "/api/repos/:id/versions", handler: createRepositoryVersion },
  { method: "PUT", pattern: "/api/repos/:id/pending", handler: stageRepositoryPending },
  { method: "DELETE", pattern: "/api/repos/:id/versions/:versionNumber", handler: deleteRepositoryVersion },
  { method: "GET", pattern: "/api/repos/:id/sync-status", handler: getRepositorySyncStatus },
  { method: "GET", pattern: "/api/repos/:id/diff", handler: diffRepositoryVersions },
  { method: "POST", pattern: "/api/repos/:id/restore-file", handler: restoreRepositoryFile },
  { method: "POST", pattern: "/api/repos/:id/forks", handler: forkRepository },
  { method: "GET", pattern: "/api/repos/:id/sync-tokens", handler: (req, env, params) => listSyncTokens(req, env, params.id) },
  { method: "POST", pattern: "/api/repos/:id/sync-tokens", handler: (req, env, params) => createSyncToken(req, env, params.id) },
  { method: "DELETE", pattern: "/api/repos/:id/sync-tokens/:tokenId", handler: (req, env, params) => deleteSyncToken(req, env, params.id, params.tokenId) },

  // Sync (printer-facing pull/push/status)
  { method: "GET", pattern: "/api/sync/repos/:id/pull", handler: (req, env, params) => syncPullRepository(req, env, params.id) },
  { method: "GET", pattern: "/api/sync/repos/:id/versions", handler: (req, env, params) => syncListVersions(req, env, params.id) },
  { method: "GET", pattern: "/api/sync/repos/:id/status.txt", handler: (req, env, params) => syncStatusText(req, env, params.id) },
  { method: "GET", pattern: "/api/sync/repos/:id/snapshot.sh", handler: (req, env, params) => syncSnapshotShell(req, env, params.id) },
  { method: "POST", pattern: "/api/sync/repos/:id/push", handler: (req, env, params) => syncPushRepository(req, env, params.id) },
  { method: "POST", pattern: "/api/sync/repos/:id/rollback", handler: (req, env, params) => syncRollbackRepository(req, env, params.id) },
  { method: "POST", pattern: "/api/sync/repos/:id/applied", handler: (req, env, params) => syncMarkApplied(req, env, params.id) },
  { method: "POST", pattern: "/api/sync/repos/:id/host-info", handler: (req, env, params) => syncReportHostInfo(req, env, params.id) },
  { method: "POST", pattern: "/api/sync/repos/:id/diagnostics", handler: (req, env, params) => uploadPrinterDiagnostic(req, env, params.id) },

  // Private, expiring printer diagnostic uploads
  { method: "GET", pattern: "/api/diagnostic-uploads", handler: (req, env) => listDiagnosticUploads(req, env) },
  { method: "GET", pattern: "/api/diagnostic-uploads/:id", handler: (req, env, params) => getDiagnosticUpload(req, env, params.id) },
  { method: "DELETE", pattern: "/api/diagnostic-uploads/:id", handler: (req, env, params) => deleteDiagnosticUpload(req, env, params.id) },

  // Consented analyzer-improvement submissions and developer-only review
  { method: "POST", pattern: "/api/log-improvement-submissions", handler: (req, env) => createLogImprovementSubmission(req, env) },
  { method: "DELETE", pattern: "/api/log-improvement-submissions/:id", handler: (req, env, params) => deleteLogImprovementSubmission(req, env, params.id) },
  { method: "GET", pattern: "/api/internal/log-improvement-submissions", handler: (req, env, _params, url) => listLogImprovementSubmissionsForReview(req, env, url) },
  { method: "GET", pattern: "/api/internal/log-improvement-submissions/:id", handler: (req, env, params) => getLogImprovementSubmissionForReview(req, env, params.id) },

  // Operator-only R2 inventory and reference-aware canonical reclamation
  { method: "GET", pattern: "/api/internal/storage/objects", handler: (req, env, _params, url) => listStorageObjectsForMaintenance(req, env, url) },
  { method: "GET", pattern: "/api/internal/storage/canonical-references", handler: (req, env, _params, url) => listCanonicalReferencesForMaintenance(req, env, url) },
  { method: "GET", pattern: "/api/internal/storage/legacy-references", handler: (req, env, _params, url) => listLegacyReferencesForMaintenance(req, env, url) },
  { method: "GET", pattern: "/api/internal/storage/reclaims", handler: (req, env, _params, url) => listCanonicalReclaimsForMaintenance(req, env, url) },
  { method: "POST", pattern: "/api/internal/storage/reclaims", handler: (req, env) => reclaimCanonicalBlobsForMaintenance(req, env) },

  // Printers
  { method: "GET", pattern: "/api/printers", handler: (req, env) => listPrinters(req, env) },
  { method: "GET", pattern: "/api/printers/:id/publication-candidate", handler: (req, env, params) => getPrinterPublicationCandidate(req, env, params.id) },
  { method: "PATCH", pattern: "/api/printers/:id/variables/:name", handler: (req, env, params) => patchPrinterVariable(req, env, params.id, params.name) },
  { method: "POST", pattern: "/api/printers", handler: (req, env) => upsertPrinter(req, env) },
  { method: "DELETE", pattern: "/api/printers/:id", handler: (req, env, params) => deletePrinter(req, env, params.id) },

  // Private packages
  { method: "GET", pattern: "/api/private-packages", handler: (req, env, params, url) => url.searchParams.get("manage") === "1"
    ? listPrivatePackagesForManagement(req, env, params, url) : listPrivatePackages(req, env) },
  { method: "POST", pattern: "/api/private-packages", handler: (req, env) => savePrivatePackage(req, env) },
  { method: "GET", pattern: "/api/private-packages/:id", handler: (req, env, params) => getPrivatePackage(req, env, params.id) },
  { method: "DELETE", pattern: "/api/private-packages/:id", handler: deletePrivatePackage },

  // Companion assets
  { method: "POST", pattern: "/api/printers/:id/orca-connection", handler: (req, env, params) => createOrcaGrant(req, env, params.id) },
  { method: "POST", pattern: "/api/orca/pair-connection", handler: (req, env) => createOrcaGrant(req, env, null, "pair") },
  { method: "POST", pattern: "/api/orca/restore/pair", handler: pairOrcaDevice },
  { method: "POST", pattern: "/api/orca/restore/disconnect", handler: disconnectOrcaDevice },
  { method: "POST", pattern: "/api/orca/device/upload-connection", handler: createOrcaDeviceUpload },
  { method: "PUT", pattern: "/api/orca/devices/:id", handler: (req, env, params) => setOrcaDeviceUploads(req, env, params.id) },
  { method: "GET", pattern: "/api/orca/devices", handler: listOrcaDevices },
  { method: "DELETE", pattern: "/api/orca/devices/:id", handler: (req, env, params) => revokeOrcaDevice(req, env, params.id) },
  { method: "POST", pattern: "/api/orca/restore-connection", handler: (req, env) => createOrcaGrant(req, env, null, "restore") },
  { method: "POST", pattern: "/api/orca/restore/library", handler: browseOrcaLibrary },
  { method: "POST", pattern: "/api/orca/restore/profile", handler: fetchOrcaProfile },
  { method: "POST", pattern: "/api/orca/connection", handler: (req, env) => createOrcaGrant(req, env, null, "library") },
  { method: "POST", pattern: "/api/orca/setup-connection", handler: (req, env) => createOrcaGrant(req, env, null) },
  { method: "POST", pattern: "/api/orca/library", handler: saveOrcaLibrary },
  { method: "GET", pattern: "/api/orca/library", handler: getOrcaLibrary },
  { method: "GET", pattern: "/api/orca/library/publication", handler: reviewOrcaPublication },
  { method: "POST", pattern: "/api/orca/library/publication", handler: publishOrcaProfile },
  { method: "PATCH", pattern: "/api/orca/library/publication", handler: updateOrcaPublicationSettings },
  { method: "DELETE", pattern: "/api/orca/library/publication", handler: unpublishOrcaProfile },
  { method: "GET", pattern: "/api/orca/library/export", handler: (req, env) => exportOrcaLibrary(req, env) },
  { method: "GET", pattern: "/api/orca/library/profile-export", handler: (req, env) => exportOrcaLibrary(req, env, true) },
  { method: "PUT", pattern: "/api/orca/profile-printers", handler: linkOrcaProfile },
  { method: "GET", pattern: "/api/orca/setups", handler: (req, env) => listOrcaSetups(req, env) },
  { method: "DELETE", pattern: "/api/orca/connections/:id", handler: (req, env, params) => revokeOrcaGrant(req, env, params.id) },
  { method: "POST", pattern: "/api/orca/capture/context", handler: orcaCaptureContext },
  { method: "POST", pattern: "/api/orca/capture", handler: saveOrcaSetup },
  { method: "GET", pattern: "/api/printers/:id/orca-setups", handler: (req, env, params) => listOrcaSetups(req, env, params.id) },
  { method: "GET", pattern: "/api/orca/setups/:id", handler: (req, env, params) => getOrcaSetup(req, env, params.id) },
  { method: "DELETE", pattern: "/api/orca/setups/:id", handler: (req, env, params) => deleteOrcaSetup(req, env, params.id) },
  { method: "GET", pattern: "/api/companion-assets", handler: (req, env) => listCompanionAssets(req, env) },
  { method: "POST", pattern: "/api/companion-assets", handler: (req, env) => saveCompanionAsset(req, env) },
  { method: "DELETE", pattern: "/api/companion-assets/:id", handler: deleteCompanionAsset },
  { method: "GET", pattern: "/api/companion-assets/:id", handler: (req, env, params) => getCompanionAsset(req, env, params.id) },
  { method: "POST", pattern: "/api/companion-assets/:id/publish", handler: (req, env, params) => publishCompanionAsset(req, env, params.id) },
  { method: "GET", pattern: "/api/public-companion-assets/:id", handler: (_req, env, params) => getPublicCompanionAsset(env, params.id) },
  { method: "GET", pattern: "/api/public-companion-assets", handler: listPublicCompanionAssets },

  // Public packages
  { method: "POST", pattern: "/api/public-packages", handler: (req, env) => publishPackage(req, env) },
  { method: "GET", pattern: "/api/public-packages/:id/status", handler: (req, env, params) => getPublicPackageApprovalStatus(req, env, params.id) },
  { method: "GET", pattern: "/api/public-packages/:id/orca-profiles", handler: (_req, env, params) => getPublicConfigOrcaProfiles(env, params.id) },
  { method: "PATCH", pattern: "/api/public-packages/:id/auto-update", handler: (req, env, params) => setPublicPackageAutoUpdate(req, env, params.id) },
  { method: "PATCH", pattern: "/api/public-packages/:id", handler: (req, env, params) => updatePublicPackageListing(req, env, params.id) },
  { method: "GET", pattern: "/api/packages", handler: listPackagesRoute },
  { method: "GET", pattern: "/api/packages/:id", handler: (_req, env, params) => getPackage(env, params.id) },
  { method: ["GET", "POST"], pattern: "/api/packages/:id/download.zip", handler: (req, env, params) => downloadPackageZip(req, env, params.id) },
  { method: "POST", pattern: "/api/packages/:id/render-preview", handler: (req, env, params) => renderPackagePreview(req, env, params.id) },
];

export async function handleApi(request: Request, env: Env) {
  const url = new URL(request.url);
  const start = Date.now();

  if (url.pathname === "/api/health" && request.method === "GET") {
    return healthCheck(env);
  }

  if (requiresBrowserOriginCheck(request) && !isTrustedOrigin(request, env)) {
    const res = json({ error: "Untrusted request origin" }, { status: 403 });
    logRequest(request.method, url.pathname, res.status, Date.now() - start);
    return res;
  }

  const matched = dispatchRoute(routes, request, url);
  if (matched && "handler" in matched) {
    const res = await matched.handler(request, env, matched.params, url);
    logRequest(request.method, url.pathname, res.status, Date.now() - start);
    return res;
  }
  if (matched) {
    // A known path with the wrong method is a 405, not a "resource missing".
    const res = json(
      { error: "Method not allowed" },
      { headers: { allow: matched.methodMismatch.join(", ") }, status: 405 },
    );
    logRequest(request.method, url.pathname, res.status, Date.now() - start);
    return res;
  }

  const res = json({ error: "Not found" }, { status: 404 });
  logRequest(request.method, url.pathname, res.status, Date.now() - start);
  return res;
}

function logRequest(method: string, path: string, status: number, durationMs: number) {
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  console.log(JSON.stringify({ level, method, path, status, durationMs }));
}
