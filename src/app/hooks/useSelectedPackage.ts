import { useEffect, useMemo, type Dispatch, type SetStateAction } from "react";
import { cloudFetch } from "../cloudFetch";
import { packageZipUrl } from "../helpers";
import { parseSharedPackageResponse } from "../responseGuards";
import type { ConfigPackage } from "../../types";
import {
  declaredPackageVariableValues,
  PackageRenderLimitError,
  renderFiles,
  validateVariables,
  type VariableValues,
} from "../../rendering";

type SelectedPackageOptions = {
  packageCatalog: ConfigPackage[];
  privatePackages: ConfigPackage[];
  registryQuery: string;
  registryTag: string;
  selectedFilePath: string;
  selectedPackageId: string;
  setPackageCatalog: Dispatch<SetStateAction<ConfigPackage[]>>;
  setPrivatePackages: Dispatch<SetStateAction<ConfigPackage[]>>;
};

export function useSelectedPackage({
  packageCatalog,
  privatePackages,
  registryQuery,
  registryTag,
  selectedFilePath,
  selectedPackageId,
  setPackageCatalog,
  setPrivatePackages,
}: SelectedPackageOptions, values: VariableValues) {
  const fullPackageCatalog = useMemo(
    () => [...privatePackages, ...packageCatalog.filter((pkg) => !privatePackages.some((local) => local.id === pkg.id))],
    [packageCatalog, privatePackages],
  );
  const selectedPackage = fullPackageCatalog.find((pkg) => pkg.id === selectedPackageId) ?? fullPackageCatalog[0] ?? null;
  const selectedPackageIsPrivate = Boolean(
    selectedPackage && privatePackages.some((pkg) => pkg.id === selectedPackage.id),
  );
  const registryTags = useMemo(
    () => Array.from(new Set(fullPackageCatalog.flatMap((pkg) => pkg.tags))).sort(),
    [fullPackageCatalog],
  );
  const filteredPackages = useMemo(() => {
    const query = registryQuery.trim().toLowerCase();
    return fullPackageCatalog.filter((pkg) => {
      const matchesQuery =
        !query ||
        [pkg.title, pkg.description, pkg.printer, pkg.hardware.join(" "), pkg.tags.join(" ")]
          .join(" ")
          .toLowerCase()
          .includes(query);
      const matchesTag = registryTag === "all" || pkg.tags.includes(registryTag);
      return matchesQuery && matchesTag;
    });
  }, [fullPackageCatalog, registryQuery, registryTag]);
  const selectedFile = selectedPackage?.files.find((file) => file.path === selectedFilePath) ?? selectedPackage?.files[0] ?? null;
  const packageValues = useMemo(
    () => (selectedPackage ? declaredPackageVariableValues(selectedPackage, values) : {}),
    [selectedPackage, values],
  );
  const variableErrors = useMemo(
    () => (selectedPackage ? validateVariables(selectedPackage, packageValues) : {}),
    [packageValues, selectedPackage],
  );
  const renderedPackage = useMemo(() => {
    if (!selectedPackage) {
      return { files: [], limitExceeded: false };
    }
    try {
      return { files: renderFiles(selectedPackage.files, packageValues), limitExceeded: false };
    } catch (error) {
      if (error instanceof PackageRenderLimitError) {
        // Source files are already bounded by package validation. Show those
        // without substitution and block download rather than crashing React.
        return { files: selectedPackage.files, limitExceeded: true };
      }
      throw error;
    }
  }, [packageValues, selectedPackage]);
  const renderedFiles = renderedPackage.files;
  const renderedFile = selectedFile ? renderedFiles.find((file) => file.path === selectedFile.path) ?? renderedFiles[0] ?? null : null;
  const missingVariables = useMemo(
    () => selectedPackage?.variables.filter((variable) => (
      variable.required
      && (
        !Object.prototype.hasOwnProperty.call(packageValues, variable.name)
        || !packageValues[variable.name]
      )
    )) ?? [],
    [packageValues, selectedPackage],
  );
  const browserZipAvailable = Boolean(selectedPackage && !renderedPackage.limitExceeded);
  const packageDownloadUrl = packageZipUrl(selectedPackage, packageValues);
  const selectedPackageNeedsHydration = Boolean(
    selectedPackage &&
      selectedPackage.files.length > 0 &&
      selectedPackage.files.every((file) => file.content === ""),
  );

  useEffect(() => {
    if (!selectedPackage || !selectedPackageNeedsHydration) {
      return undefined;
    }

    const id = selectedPackage.id;
    const endpoint = selectedPackageIsPrivate
      ? `/api/private-packages/${encodeURIComponent(id)}`
      : `/api/packages/${encodeURIComponent(id)}`;
    let active = true;
    void (async () => {
      const result = await cloudFetch(endpoint, {
        credentials: selectedPackageIsPrivate ? "include" : "same-origin",
        validate: parseSharedPackageResponse,
      });
      if (!active || !result.ok || !result.data) {
        return;
      }
      const fetched = result.data.package;
      if (selectedPackageIsPrivate) {
        setPrivatePackages((current) => current.map((pkg) => (
          pkg.id === id ? fetched : pkg
        )));
      } else {
        setPackageCatalog((current) => current.map((pkg) => (pkg.id === id ? fetched : pkg)));
      }
    })();

    return () => {
      active = false;
    };
  }, [selectedPackage, selectedPackageIsPrivate, selectedPackageNeedsHydration, setPackageCatalog, setPrivatePackages]);

  return {
    browserZipAvailable,
    filteredPackages,
    fullPackageCatalog,
    missingVariables,
    packageDownloadUrl,
    registryTags,
    renderLimitExceeded: renderedPackage.limitExceeded,
    renderedFile,
    renderedFiles,
    selectedFile,
    selectedPackage,
    variableErrors,
  };
}
