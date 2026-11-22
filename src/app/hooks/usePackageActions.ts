import type { Dispatch, SetStateAction } from "react";
import { cloudFetch } from "../cloudFetch";
import { parsePublishPackageResponse } from "../responseGuards";
import {
  buildPrivatePackage,
  variablesFromFiles,
} from "../../packageBuilder";
import { inferSelectedVariableType } from "../../editorVariables";
import { scanConfigFiles } from "../../safety";
import type { ConfigFile, ConfigPackage, EditorValueSelection } from "../../types";
import type { AuthUser, PackageDraft, PrinterPublicationCandidate, PrinterRecord, Tab } from "../types";

type PackageActionsOptions = {
  authUser: AuthUser | null;
  packageDraft: PackageDraft;
  packageVariables: ConfigPackage["variables"];
  pendingWorkspaceFiles: ConfigFile[];
  privatePackages: ConfigPackage[];
  repositoryId: string | null;
  safetyBlocked: boolean;
  selectedPackage: ConfigPackage | null;
  selectedPrinter: PrinterRecord | null;
  setActiveTab: (tab: Tab) => void;
  setBindStatus: (status: string) => void;
  setBuildStatus: (status: string) => void;
  setCatalogStatus: (status: string) => void;
  setPackageDraft: Dispatch<SetStateAction<PackageDraft>>;
  setPrivatePackageStatus: (status: string) => void;
  setPrivatePackages: Dispatch<SetStateAction<ConfigPackage[]>>;
  setPublishStatus: (status: string) => void;
  setSelectedFilePath: (path: string) => void;
  setSelectedPackageId: Dispatch<SetStateAction<string>>;
  updatePrinterRecord: (id: string, update: (record: PrinterRecord) => PrinterRecord) => void;
  upsertPublicPackage: (pkg: ConfigPackage) => void;
  updateVariable: (name: string, value: string) => void;
  replaceWorkspaceDraftFiles: (files: ConfigFile[]) => void;
};

export function usePackageActions({
  authUser,
  packageDraft,
  packageVariables,
  pendingWorkspaceFiles,
  privatePackages,
  repositoryId,
  safetyBlocked,
  selectedPackage,
  selectedPrinter,
  setActiveTab,
  setBindStatus,
  setBuildStatus,
  setCatalogStatus,
  setPackageDraft,
  setPrivatePackageStatus,
  setPrivatePackages,
  setPublishStatus,
  setSelectedFilePath,
  setSelectedPackageId,
  updatePrinterRecord,
  upsertPublicPackage,
  updateVariable,
  replaceWorkspaceDraftFiles,
}: PackageActionsOptions) {
  function convertSelectionToVariable(filePath: string, selection: EditorValueSelection, name: string) {
    const normalizedName = name.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]*$/.test(normalizedName)) {
      setBuildStatus("Variable names must start with a letter and use lowercase letters, numbers, or underscores");
      return false;
    }

    const selectedFile = pendingWorkspaceFiles.find((file) => file.path === filePath);
    if (!selectedFile || selectedFile.content.slice(selection.from, selection.to) !== selection.value) {
      setBuildStatus("The editor selection changed; select the value again");
      return false;
    }

    const placeholder = `\${KLIPPEE:${normalizedName}}`;
    const nextFiles = pendingWorkspaceFiles.map((file) => file.path === filePath
      ? {
          ...file,
          content: `${file.content.slice(0, selection.from)}${placeholder}${file.content.slice(selection.to)}`,
        }
      : file);
    if (inferSelectedVariableType(selection.value, normalizedName) !== "secret") {
      updateVariable(normalizedName, selection.value);
    }
    replaceWorkspaceDraftFiles(nextFiles);
    setBuildStatus(`Created ${placeholder}; review the printer value, then save the configuration`);
    return true;
  }

  function updatePackageDraft(field: keyof PackageDraft, value: string) {
    setPackageDraft((current) => ({ ...current, [field]: value }));
  }

  async function savePrivatePackageToCloud(pkg: ConfigPackage) {
    if (!authUser) {
      setPrivatePackageStatus("Saved locally; sign in to sync");
      return false;
    }

    const result = await cloudFetch("/api/private-packages", {
      method: "POST",
      json: { package: pkg },
      onStatus: setPrivatePackageStatus,
      messages: {
        pending: `Saving ${pkg.title}`,
        ok: `Saved ${pkg.title} to cloud`,
        fail: "Cloud package save failed",
        error: "Cloud package save unavailable",
      },
    });
    return result.ok;
  }

  async function publishSelectedPackage(acknowledgeSafetyWarnings = false): Promise<string | null> {
    if (!selectedPackage) {
      setPublishStatus("Build or select a private package first");
      return null;
    }
    if (!authUser) {
      setPublishStatus("Sign in before publishing");
      return null;
    }
    if (!privatePackages.some((pkg) => pkg.id === selectedPackage.id)) {
      setPublishStatus("Only your private packages can be published");
      return null;
    }
    return publishOwnedPackage(selectedPackage, acknowledgeSafetyWarnings);
  }

  async function publishOwnedPackage(
    pkg: ConfigPackage,
    acknowledgeSafetyWarnings = false,
    appliedRepositoryId?: string | null,
    appliedPrinterId?: string | null,
    expectedAppliedVersionId?: string,
  ): Promise<string | null> {
    const publishWarnings = scanConfigFiles(pkg.files).filter((finding) => finding.severity === "warn");
    if (publishWarnings.length > 0 && !acknowledgeSafetyWarnings) {
      setPublishStatus("Review and confirm the package safety warnings before publishing");
      return null;
    }

    const result = await cloudFetch("/api/public-packages", {
      method: "POST",
      json: {
        acknowledgeSafetyWarnings,
        packageId: pkg.id,
        printerId: appliedPrinterId || undefined,
        repositoryId: appliedRepositoryId || undefined,
        expectedAppliedVersionId,
      },
      onStatus: setPublishStatus,
      validate: parsePublishPackageResponse,
      messages: {
        pending: "Publishing public package",
        fail: "Publish failed",
        error: "Publish unavailable",
      },
    });
    if (!result.ok) {
      if (result.status === 409 && expectedAppliedVersionId) {
        setPublishStatus("The printer's applied configuration changed; review the refreshed version before publishing");
      }
      return null;
    }
    if (!result.data) {
      return null;
    }
    upsertPublicPackage(result.data.package);
    setPublishStatus(`Published: ${result.data.shareUrl}`);
    setCatalogStatus("Loaded public packages");
    return result.data.shareUrl;
  }

  async function updatePublicPackageListing(packageId: string, draft: PackageDraft) {
    if (!authUser) {
      setPublishStatus("Sign in before editing a public listing");
      return false;
    }
    const result = await cloudFetch(`/api/public-packages/${encodeURIComponent(packageId)}`, {
      method: "PATCH",
      json: {
        description: draft.description,
        hardware: draft.hardware.split(",").map((item) => item.trim()).filter(Boolean),
        printer: draft.printer,
        tags: draft.tags.split(",").map((item) => item.trim()).filter(Boolean),
        title: draft.title,
      },
      onStatus: setPublishStatus,
      validate: parsePublishPackageResponse,
      messages: {
        pending: "Updating public listing",
        ok: "Public listing updated",
        fail: "Public listing update failed",
        error: "Public listing update unavailable",
      },
    });
    if (!result.ok || !result.data) {
      return false;
    }
    upsertPublicPackage(result.data.package);
    setCatalogStatus("Loaded public packages");
    return true;
  }

  async function publishWorkspacePackage(
    draft: PackageDraft,
    candidate: PrinterPublicationCandidate,
    acknowledgeSafetyWarnings = false,
  ): Promise<string | null> {
    if (!authUser) {
      setPublishStatus("Sign in before publishing");
      return null;
    }
    if (!selectedPrinter) {
      setPublishStatus("Select a printer before publishing");
      return null;
    }
    if (!repositoryId) {
      setPublishStatus("Create a cloud configuration before publishing");
      return null;
    }
    if (candidate.repositoryId !== repositoryId) {
      setPublishStatus("The applied configuration no longer belongs to this printer workspace; refresh before publishing");
      return null;
    }
    if (!candidate.files.length) {
      setPublishStatus("The applied configuration has no files to publish");
      return null;
    }
    if (!draft.title.trim()) {
      setPublishStatus("Add a listing title before publishing");
      return null;
    }
    if (scanConfigFiles(candidate.files).some((finding) => finding.severity === "block")) {
      setPublishStatus("Resolve blocking findings in the applied configuration before publishing");
      return null;
    }
    setPackageDraft(draft);

    const deterministicId = `printer-${selectedPrinter.id}-workspace`;
    const existingPackage = privatePackages.find((candidate) => candidate.id === deterministicId)
      ?? privatePackages.find((candidate) => selectedPrinter.packageIds.includes(candidate.id));
    const pkg = buildPrivatePackage({
      description: draft.description,
      files: candidate.files,
      hardware: draft.hardware.split(",").map((item) => item.trim()).filter(Boolean),
      id: existingPackage?.id ?? deterministicId,
      printer: draft.printer || selectedPrinter.name,
      tags: draft.tags.split(",").map((item) => item.trim()).filter(Boolean),
      title: draft.title,
      variables: variablesFromFiles(candidate.files, []),
    });

    setPrivatePackages((current) => [
      pkg,
      ...current.filter((candidate) => candidate.id !== pkg.id),
    ]);
    updatePrinterRecord(selectedPrinter.id, (candidate) => ({
      ...candidate,
      packageIds: Array.from(new Set([pkg.id, ...candidate.packageIds])),
      updatedAt: new Date().toISOString(),
    }));
    setSelectedPackageId(pkg.id);

    if (!await savePrivatePackageToCloud(pkg)) {
      setPublishStatus("Could not save the reviewed applied configuration for publishing");
      return null;
    }

    return publishOwnedPackage(
      pkg,
      acknowledgeSafetyWarnings,
      repositoryId,
      selectedPrinter.id,
      candidate.versionId,
    );
  }

  function bindSelectedPackageToPrinter() {
    if (!selectedPrinter) {
      setBindStatus("Select a printer first");
      return;
    }
    if (!selectedPackage) {
      setBindStatus("Select or build a package first");
      return;
    }

    updatePrinterRecord(selectedPrinter.id, (candidate) => ({
      ...candidate,
      packageIds: Array.from(new Set([selectedPackage.id, ...candidate.packageIds])),
      updatedAt: new Date().toISOString(),
    }));
    setBindStatus(`Bound ${selectedPackage.title} to ${selectedPrinter.name}`);
  }

  function unbindPackageFromPrinter(packageId: string) {
    if (!selectedPrinter) {
      setBindStatus("Select a printer first");
      return;
    }
    updatePrinterRecord(selectedPrinter.id, (candidate) => ({
      ...candidate,
      packageIds: candidate.packageIds.filter((id) => id !== packageId),
      updatedAt: new Date().toISOString(),
    }));
    setBindStatus("Package unbound from printer");
  }

  function forgetDeletedPrivatePackage(packageId: string) {
    setPrivatePackages(current => current.filter(pkg => pkg.id !== packageId));
    setSelectedPackageId(current => current === packageId ? "" : current);
    setPrivatePackageStatus("Private package deleted from Klippee; published copies remain available");
  }

  function buildPackageFromWorkspace() {
    if (safetyBlocked) {
      setBuildStatus("Resolve blocking safety findings first");
      return;
    }

    const id = `private-${Date.now().toString(36)}`;
    const pkg = buildPrivatePackage({
      description: packageDraft.description,
      files: pendingWorkspaceFiles,
      hardware: packageDraft.hardware.split(",").map((item) => item.trim()).filter(Boolean),
      id,
      printer: packageDraft.printer,
      tags: packageDraft.tags.split(",").map((item) => item.trim()).filter(Boolean),
      title: packageDraft.title,
      variables: packageVariables,
    });

    setPrivatePackages((current) => [
      pkg,
      ...current.filter((candidate) => candidate.id !== pkg.id),
    ]);
    if (selectedPrinter) {
      updatePrinterRecord(selectedPrinter.id, (candidate) => ({
        ...candidate,
        packageIds: Array.from(new Set([pkg.id, ...candidate.packageIds])),
        updatedAt: new Date().toISOString(),
      }));
    }
    setSelectedPackageId(pkg.id);
    setSelectedFilePath(pkg.files[0]?.path ?? "printer.cfg");
    setBuildStatus(`Built ${pkg.title}`);
    void savePrivatePackageToCloud(pkg);
    setActiveTab("Setup");
  }

  return {
    forgetDeletedPrivatePackage,
    bindSelectedPackageToPrinter,
    buildPackageFromWorkspace,
    convertSelectionToVariable,
    publishWorkspacePackage,
    publishSelectedPackage,
    savePrivatePackageToCloud,
    unbindPackageFromPrinter,
    updatePublicPackageListing,
    updatePackageDraft,
  };
}
