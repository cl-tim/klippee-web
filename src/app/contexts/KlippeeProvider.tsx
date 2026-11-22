import { useMemo, type ReactNode } from "react";
import { formatDate } from "../format";
import type { AuthSession } from "../hooks/useAuthSession";
import { useKlippeeApp } from "../useKlippeeApp";
import { AppShellProvider } from "./AppShellContext";
import { CompanionAssetProvider } from "./CompanionAssetContext";
import { PackageProvider } from "./PackageContext";
import { PrinterProvider } from "./PrinterContext";
import { RepositoryProvider } from "./RepositoryContext";
import { WorkspaceProvider } from "./WorkspaceContext";

const printerNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function sortPrintersByName<T extends { id: string; name: string }>(printers: T[]) {
  return [...printers].sort(
    (first, second) =>
      printerNameCollator.compare(first.name.trim(), second.name.trim())
      || printerNameCollator.compare(first.id, second.id),
  );
}

/**
 * Single top-level provider that owns the `useKlippeeApp()` hook call and
 * fans its return out to the six concern-specific contexts. App.tsx becomes
 * a thin shell around this — every view consumes via the matching
 * `useXContext()` hook instead of receiving props.
 *
 * Every value object is memoized on its actual data fields (all function
 * fields are identity-stable via useStableHandlers in useKlippeeApp), so a
 * state change only re-renders the consumers of the context it belongs to.
 * High-churn workspace-derived fields (currentWorkspaceContent,
 * workspaceChanged, safetyFindings, pendingWorkspaceFiles, packageVariables)
 * live exclusively in WorkspaceContext so editor keystrokes leave the other
 * five contexts untouched.
 */
export function KlippeeProvider({
  authSession,
  children,
}: {
  authSession: AuthSession;
  children: ReactNode;
}) {
  const app = useKlippeeApp(authSession);
  const sortedPrinters = useMemo(() => sortPrintersByName(app.printers), [app.printers]);

  const appShellValue = useMemo(() => ({
    activeTab: app.activeTab,
    setActiveTab: app.setActiveTab,
    protectedDataPending: app.protectedDataPending,
    protectedTabLocked: app.protectedTabLocked,
    authChecked: app.authChecked,
    authStatus: app.authStatus,
    authUser: app.authUser,
    cloudStatus: app.cloudStatus,
    loginOpen: app.loginOpen,
    setLoginOpen: app.setLoginOpen,
    logout: app.logout,
  }), [
    app.activeTab,
    app.setActiveTab,
    app.protectedDataPending,
    app.protectedTabLocked,
    app.authChecked,
    app.authStatus,
    app.authUser,
    app.cloudStatus,
    app.loginOpen,
    app.setLoginOpen,
    app.logout,
  ]);

  const printerValue = useMemo(() => ({
    printers: sortedPrinters,
    selectedPrinter: app.selectedPrinter,
    selectedPrinterId: app.selectedPrinter?.id ?? "",
    creatingPrinter: app.creatingPrinter,
    switchingPrinterId: app.switchingPrinterId,
    printerStatus: app.printerStatus,
    printerLoadFailed: app.printerLoadFailed,
    printerPickerOpen: app.printerPickerOpen,
    pendingDeletePrinterId: app.pendingDeletePrinterId,
    printerDetailsEditorId: app.printerDetailsEditorId,
    printerDetailsDraft: app.printerDetailsDraft,
    addPrinterDraft: app.addPrinterDraft,
    loadPrintersFromCloud: app.loadPrintersFromCloud,
    selectPrinter: app.selectPrinter,
    startPrinterDraftFromCatalog: app.startPrinterDraftFromCatalog,
    requestDeletePrinter: app.requestDeletePrinter,
    cancelDeletePrinter: app.cancelDeletePrinter,
    confirmDeletePrinter: app.confirmDeletePrinter,
    openPrinterDetailsEditor: app.openPrinterDetailsEditor,
    closePrinterDetailsEditor: app.closePrinterDetailsEditor,
    savePrinterDetails: app.savePrinterDetails,
    updatePrinterDetails: app.updatePrinterDetails,
    setPrinterPickerOpen: app.setPrinterPickerOpen,
    setPrinterDetailsDraft: app.setPrinterDetailsDraft,
  }), [
    sortedPrinters,
    app.selectedPrinter,
    app.creatingPrinter,
    app.switchingPrinterId,
    app.printerStatus,
    app.printerLoadFailed,
    app.printerPickerOpen,
    app.pendingDeletePrinterId,
    app.printerDetailsEditorId,
    app.printerDetailsDraft,
    app.addPrinterDraft,
    app.loadPrintersFromCloud,
    app.selectPrinter,
    app.startPrinterDraftFromCatalog,
    app.requestDeletePrinter,
    app.cancelDeletePrinter,
    app.confirmDeletePrinter,
    app.openPrinterDetailsEditor,
    app.closePrinterDetailsEditor,
    app.savePrinterDetails,
    app.updatePrinterDetails,
    app.setPrinterPickerOpen,
    app.setPrinterDetailsDraft,
  ]);

  const repositoryValue = useMemo(() => ({
    history: app.history,
    latestVersion: app.latestVersion,
    appliedVersion: app.appliedVersion,
    historyChangedPaths: app.historyChangedPaths,
    printer: app.printer,
    repoStatus: app.repoStatus,
    pendingConfiguration: app.pendingConfiguration,
    syncStatus: app.syncStatus,
    syncCheckedAt: app.syncCheckedAt,
    syncConflict: app.syncConflict,
    historyFileRestoreReview: app.historyFileRestoreReview,
    historyFileRestoreBusy: app.historyFileRestoreBusy,
    historyFileRestoreStatus: app.historyFileRestoreStatus,
    reviewHistoryFileRestore: app.reviewHistoryFileRestore,
    confirmHistoryFileRestore: app.confirmHistoryFileRestore,
    cancelHistoryFileRestore: app.cancelHistoryFileRestore,
    workspaceConflictReview: app.workspaceConflictReview,
    workspaceConflictBusy: app.workspaceConflictBusy,
    workspaceConflictStatus: app.workspaceConflictStatus,
    reviewWorkspaceConflict: app.reviewWorkspaceConflict,
    resolveWorkspaceConflict: app.resolveWorkspaceConflict,
    closeWorkspaceConflictReview: app.closeWorkspaceConflictReview,
    syncToken: app.syncToken,
    syncTokens: app.syncTokens,
    syncPullUrl: app.syncPullUrl,
    clientInstallCommand: app.clientInstallCommand,
    buildDesktopInstallCommand: app.buildDesktopInstallCommand,
    buildPrinterInstallCommand: app.buildPrinterInstallCommand,
    createCloudRepository: app.createCloudRepository,
    createDesktopSyncToken: app.createDesktopSyncToken,
    createPrinterSyncToken: app.createPrinterSyncToken,
    deleteVersion: app.deleteVersion,
    linkCurrentPrinter: app.linkCurrentPrinter,
    refreshSyncStatus: app.refreshSyncStatus,
    revokeSyncToken: app.revokeSyncToken,
    loadActiveRepositoryHistory: app.loadActiveRepositoryHistory,
    forkFromVersion: app.forkFromVersion,
  }), [
    app.history,
    app.latestVersion,
    app.appliedVersion,
    app.historyChangedPaths,
    app.printer,
    app.repoStatus,
    app.pendingConfiguration,
    app.syncStatus,
    app.syncCheckedAt,
    app.syncConflict,
    app.historyFileRestoreReview,
    app.historyFileRestoreBusy,
    app.historyFileRestoreStatus,
    app.reviewHistoryFileRestore,
    app.confirmHistoryFileRestore,
    app.cancelHistoryFileRestore,
    app.workspaceConflictReview,
    app.workspaceConflictBusy,
    app.workspaceConflictStatus,
    app.reviewWorkspaceConflict,
    app.resolveWorkspaceConflict,
    app.closeWorkspaceConflictReview,
    app.syncToken,
    app.syncTokens,
    app.syncPullUrl,
    app.clientInstallCommand,
    app.buildDesktopInstallCommand,
    app.buildPrinterInstallCommand,
    app.createCloudRepository,
    app.createDesktopSyncToken,
    app.createPrinterSyncToken,
    app.deleteVersion,
    app.linkCurrentPrinter,
    app.refreshSyncStatus,
    app.revokeSyncToken,
    app.loadActiveRepositoryHistory,
    app.forkFromVersion,
  ]);

  const packageValue = useMemo(() => ({
    selectedPackage: app.selectedPackage,
    selectedPackageId: app.selectedPackageId,
    selectedFile: app.selectedFile,
    privatePackages: app.privatePackages,
    privatePackageStatus: app.privatePackageStatus,
    availablePackages: app.fullPackageCatalog,
    filteredPackages: app.filteredPackages,
    registryQuery: app.registryQuery,
    registryTag: app.registryTag,
    registryTags: app.registryTags,
    catalogStatus: app.catalogStatus,
    packageDownloadUrl: app.packageDownloadUrl,
    browserZipAvailable: app.browserZipAvailable,
    renderedFile: app.renderedFile,
    missingVariables: app.missingVariables.length,
    values: app.values,
    variableErrors: app.variableErrors,
    packageDraft: app.packageDraft,
    bindStatus: app.bindStatus,
    buildStatus: app.buildStatus,
    publishStatus: app.publishStatus,
    downloadState: app.downloadState,
    bindable: Boolean(app.selectedPrinter && app.selectedPackage),
    publishable: Boolean(
      app.authUser && app.selectedPackage && app.privatePackages.some((pkg) => pkg.id === app.selectedPackage?.id),
    ),
    workspacePublishable: Boolean(app.authUser),
    handleDownload: app.handleDownload,
    selectPackage: app.selectPackage,
    selectPreviewFile: app.selectPreviewFile,
    setRegistryQuery: app.setRegistryQuery,
    setRegistryTag: app.setRegistryTag,
    updateVariable: app.updateVariable,
    updatePackageDraft: app.updatePackageDraft,
    convertSelectionToVariable: app.convertSelectionToVariable,
    buildPackageFromWorkspace: app.buildPackageFromWorkspace,
    publishSelectedPackage: app.publishSelectedPackage,
    publishWorkspacePackage: app.publishWorkspacePackage,
    updatePublicPackageListing: app.updatePublicPackageListing,
    bindSelectedPackageToPrinter: app.bindSelectedPackageToPrinter,
    unbindPackageFromPrinter: app.unbindPackageFromPrinter,
    forgetDeletedPrivatePackage: app.forgetDeletedPrivatePackage,
  }), [
    app.selectedPackage,
    app.selectedPackageId,
    app.selectedFile,
    app.privatePackages,
    app.privatePackageStatus,
    app.fullPackageCatalog,
    app.filteredPackages,
    app.registryQuery,
    app.registryTag,
    app.registryTags,
    app.catalogStatus,
    app.packageDownloadUrl,
    app.browserZipAvailable,
    app.renderedFile,
    app.missingVariables,
    app.values,
    app.variableErrors,
    app.packageDraft,
    app.bindStatus,
    app.buildStatus,
    app.publishStatus,
    app.downloadState,
    app.selectedPrinter,
    app.authUser,
    app.handleDownload,
    app.selectPackage,
    app.selectPreviewFile,
    app.setRegistryQuery,
    app.setRegistryTag,
    app.updateVariable,
    app.updatePackageDraft,
    app.convertSelectionToVariable,
    app.buildPackageFromWorkspace,
    app.publishSelectedPackage,
    app.publishWorkspacePackage,
    app.updatePublicPackageListing,
    app.bindSelectedPackageToPrinter,
    app.unbindPackageFromPrinter,
    app.forgetDeletedPrivatePackage,
  ]);

  const workspaceValue = useMemo(() => ({
    workspaceFilePath: app.workspaceFilePath,
    currentWorkspaceContent: app.currentWorkspaceContent,
    workspaceChanged: app.workspaceChanged,
    draftSaveStatus: app.draftSavedAt
      ? `Draft saved on this device ${formatDate(app.draftSavedAt)}${app.authUser ? ` · ${app.cloudStatus}` : ""}`
      : app.cloudStatus,
    draftSavedAt: app.draftSavedAt,
    updateWorkspaceContent: app.updateWorkspaceContent,
    selectWorkspaceFile: app.selectWorkspaceFile,
    importWorkspaceFiles: app.importWorkspaceFiles,
    createWorkspaceFile: app.createWorkspaceFile,
    deleteWorkspaceFolder: app.deleteWorkspaceFolder,
    deleteWorkspaceFile: app.deleteWorkspaceFile,
    renameWorkspaceFile: app.renameWorkspaceFile,
    renameWorkspaceFolder: app.renameWorkspaceFolder,
    useStarterConfig: app.useStarterConfig,
    pendingConfigImport: app.pendingConfigImport,
    confirmConfigImportReplacement: app.confirmConfigImportReplacement,
    cancelConfigImportReplacement: app.cancelConfigImportReplacement,
    pendingWorkspaceFiles: app.pendingWorkspaceFiles,
    packageVariables: app.packageVariables,
    missingIncludePaths: app.missingIncludePaths,
    safetyBlocked: app.safetyBlocked,
    safetyFindings: app.safetyFindings,
    editorJumpTarget: app.editorJumpTarget,
    jumpToLine: app.jumpToLine,
  }), [
    app.workspaceFilePath,
    app.currentWorkspaceContent,
    app.workspaceChanged,
    app.draftSavedAt,
    app.authUser,
    app.cloudStatus,
    app.updateWorkspaceContent,
    app.selectWorkspaceFile,
    app.importWorkspaceFiles,
    app.createWorkspaceFile,
    app.deleteWorkspaceFolder,
    app.deleteWorkspaceFile,
    app.renameWorkspaceFile,
    app.renameWorkspaceFolder,
    app.useStarterConfig,
    app.pendingConfigImport,
    app.confirmConfigImportReplacement,
    app.cancelConfigImportReplacement,
    app.pendingWorkspaceFiles,
    app.packageVariables,
    app.missingIncludePaths,
    app.safetyBlocked,
    app.safetyFindings,
    app.editorJumpTarget,
    app.jumpToLine,
  ]);

  const companionAssetValue = useMemo(() => ({
    companionAssets: app.companionAssets,
    companionAssetDraft: app.companionAssetDraft,
    companionAssetStatus: app.companionAssetStatus,
    editingCompanionAssetId: app.editingCompanionAssetId,
    selectedCompanionAssetId: app.selectedCompanionAssetId,
    linkedCompanionAssets: app.linkedCompanionAssets,
    assignCompanionAssetsToPrinter: app.assignCompanionAssetsToPrinter,
    deleteCompanionAsset: app.deleteCompanionAsset,
    importCompanionAssets: app.importCompanionAssets,
    loadCompanionAssetForEdit: app.loadCompanionAssetForEdit,
    startNewCompanionAsset: app.startNewCompanionAsset,
    updateCompanionAssetDraft: app.updateCompanionAssetDraft,
    updateCompanionAssetStructured: app.updateCompanionAssetStructured,
    linkSelectedCompanionAssetToPackage: app.linkSelectedCompanionAssetToPackage,
    publishSelectedCompanionAsset: app.publishSelectedCompanionAsset,
    saveCompanionAsset: app.saveCompanionAsset,
    setSelectedCompanionAssetId: app.setSelectedCompanionAssetId,
  }), [
    app.companionAssets,
    app.companionAssetDraft,
    app.companionAssetStatus,
    app.editingCompanionAssetId,
    app.selectedCompanionAssetId,
    app.linkedCompanionAssets,
    app.assignCompanionAssetsToPrinter,
    app.deleteCompanionAsset,
    app.importCompanionAssets,
    app.loadCompanionAssetForEdit,
    app.startNewCompanionAsset,
    app.updateCompanionAssetDraft,
    app.updateCompanionAssetStructured,
    app.linkSelectedCompanionAssetToPackage,
    app.publishSelectedCompanionAsset,
    app.saveCompanionAsset,
    app.setSelectedCompanionAssetId,
  ]);

  return (
    <AppShellProvider value={appShellValue}>
      <PrinterProvider value={printerValue}>
        <RepositoryProvider value={repositoryValue}>
          <PackageProvider value={packageValue}>
            <WorkspaceProvider value={workspaceValue}>
              <CompanionAssetProvider value={companionAssetValue}>{children}</CompanionAssetProvider>
            </WorkspaceProvider>
          </PackageProvider>
        </RepositoryProvider>
      </PrinterProvider>
    </AppShellProvider>
  );
}
