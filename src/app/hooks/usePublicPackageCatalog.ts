import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { matchPath, useLocation } from "react-router";
import { cloudFetch } from "../cloudFetch";
import { parsePackageListResponse, parseSharedPackageResponse } from "../responseGuards";
import { packages } from "../../data";
import type { ConfigPackage } from "../../types";

type PublicPackageCatalogOptions = {
  setSelectedFilePath: (path: string) => void;
  setSelectedPackageId: (id: string) => void;
};

type RegistrySearch = {
  query: string;
  tag: string;
};

function mergePackageSummaries(current: ConfigPackage[], summaries: ConfigPackage[]) {
  return summaries.map((summary) => {
    const existing = current.find((candidate) => candidate.id === summary.id);
    const samePublication = existing && existing.publicUpdatedAt === summary.publicUpdatedAt;
    const hasHydratedContents = existing?.files.some((file) => file.content !== "");
    const sameFiles =
      existing?.files.length === summary.files.length &&
      summary.files.every((file) => existing.files.some((candidate) => candidate.path === file.path));
    return samePublication && hasHydratedContents && sameFiles
      ? { ...summary, files: existing.files }
      : summary;
  });
}

export function usePublicPackageCatalog({
  setSelectedFilePath,
  setSelectedPackageId,
}: PublicPackageCatalogOptions) {
  const location = useLocation();
  const sharedPackageId = matchPath("/packages/:packageId", location.pathname)?.params.packageId;
  const [packageCatalog, setPackageCatalog] = useState<ConfigPackage[]>(packages);
  // Status of the last settled load or user action; in-flight copy is derived
  // below so render never lags a fetch by an effect pass.
  const [settledCatalogStatus, setCatalogStatus] = useState("Loading package API");
  const [registryQuery, setRegistryQuery] = useState("");
  const [registryTag, setRegistryTag] = useState("all");
  // Debounced copy of the search inputs feeding the catalog query key, so the
  // registry keeps its 250ms typing debounce. Starts as null so the initial
  // catalog load is also delayed by 250ms, exactly like the hand-rolled
  // timer-in-effect it replaces (tests and the shared-package flow rely on the
  // list load landing after the immediate shared-package fetch).
  const [registrySearch, setRegistrySearch] = useState<RegistrySearch | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setRegistrySearch({ query: registryQuery.trim(), tag: registryTag });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [registryQuery, registryTag]);

  const { data: sharedPackageLoad, isFetching: sharedPackageFetching } = useQuery({
    enabled: Boolean(sharedPackageId),
    queryFn: async () => {
      const result = await cloudFetch(`/api/packages/${encodeURIComponent(sharedPackageId ?? "")}`, {
        validate: parseSharedPackageResponse,
      });
      // Failures become data (package: null + transport status) instead of a
      // thrown error so the status-string mapping below sees them without a
      // retry pass.
      return {
        package: result.ok && result.data ? result.data.package : null,
        status: result.status,
      };
    },
    queryKey: ["shared-package", sharedPackageId],
  });

  // Applies the shared-package load to app state. Split from the query so the
  // fetch itself is cacheable/cancellable while the side effects (catalog
  // upsert, selection, status copy) only ever run for the currently routed
  // package — the query key change replaces the old active-flag cancellation.
  // packageCatalog is accumulated state (bundled seed + merged summaries +
  // hydration upserts from usePackageActions), so query results are bridged in
  // here rather than derived; the setState calls are keyed on settled loads.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!sharedPackageId) {
      return;
    }
    if (sharedPackageFetching) {
      return;
    }
    if (!sharedPackageLoad) {
      return;
    }
    if (!sharedPackageLoad.package) {
      setCatalogStatus(sharedPackageLoad.status === 0 ? "Shared package unavailable" : "Shared package not found");
      return;
    }
    const pkg = sharedPackageLoad.package;
    setPackageCatalog((current) => [pkg, ...current.filter((candidate) => candidate.id !== pkg.id)]);
    setSelectedPackageId(pkg.id);
    setSelectedFilePath(pkg.files[0]?.path ?? "printer.cfg");
    setCatalogStatus("Loaded shared package");
  }, [setSelectedFilePath, setSelectedPackageId, sharedPackageFetching, sharedPackageId, sharedPackageLoad]);

  const { data: catalogLoad, isFetching: catalogFetching } = useQuery({
    enabled: registrySearch !== null,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (registrySearch?.query) {
        params.set("q", registrySearch.query);
      }
      if (registrySearch && registrySearch.tag !== "all") {
        params.set("tag", registrySearch.tag);
      }
      const search = params.toString();
      const result = await cloudFetch(`/api/packages${search ? `?${search}` : ""}`, {
        validate: parsePackageListResponse,
      });
      return {
        packages: result.ok && result.data ? result.data.packages : [],
      };
    },
    queryKey: ["package-catalog", registrySearch?.query ?? "", registrySearch?.tag ?? "all"],
  });

  // Merges list results into the accumulated catalog (see note on the
  // shared-package effect above for why this bridges instead of deriving).
  useEffect(() => {
    if (!registrySearch) {
      return;
    }
    if (catalogFetching) {
      return;
    }
    if (!catalogLoad) {
      return;
    }
    if (catalogLoad.packages.length) {
      const summaries = catalogLoad.packages;
      setPackageCatalog((current) => mergePackageSummaries(current, summaries));
      setCatalogStatus("Loaded from API");
    } else {
      setCatalogStatus("Using bundled packages");
    }
  }, [catalogFetching, catalogLoad, registrySearch]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // In-flight copy overlays the settled status. Catalog checks take
  // precedence over the shared-package load, matching the declaration order
  // of the two effects this derivation replaced (last effect write won).
  const catalogStatus = registrySearch && catalogFetching
    ? (registrySearch.query || registrySearch.tag !== "all" ? "Searching Shared Configs" : "Loading package API")
    : sharedPackageId && sharedPackageFetching
      ? "Loading shared package"
      : settledCatalogStatus;

  const upsertPublicPackage = useCallback((pkg: ConfigPackage) => {
    setPackageCatalog((current) => [pkg, ...current.filter((candidate) => candidate.id !== pkg.id)]);
  }, []);

  const selectPackage = useCallback((id: string, catalog: ConfigPackage[]) => {
    // Both setters persist (usePersistedState in useKlippeeApp).
    setSelectedPackageId(id);
    const nextPath = catalog.find((pkg) => pkg.id === id)?.files[0].path ?? "printer.cfg";
    setSelectedFilePath(nextPath);
  }, [setSelectedFilePath, setSelectedPackageId]);

  return {
    catalogStatus,
    packageCatalog,
    registryQuery,
    registryTag,
    selectPackage,
    setCatalogStatus,
    setPackageCatalog,
    setRegistryQuery,
    setRegistryTag,
    upsertPublicPackage,
  };
}
