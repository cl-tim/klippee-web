import { tabLabels } from "../../app/constants";
import { WorkflowButton } from "./WorkflowControls";
import { ArrowLeft } from "lucide-react";
import { Badge, Button, Group, NativeSelect, UnstyledButton } from "@mantine/core";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useState } from "react";
import { useAppShellContext } from "../../app/contexts/useAppShellContext";
import { OrcaRegistryCatalog } from "../orca/OrcaRegistryCatalog";
import { usePackageContext } from "../../app/contexts/usePackageContext";
import { usePublicPackageApprovalStatus } from "../../app/hooks/usePublicPackageApprovalStatus";
import { PageHeader, RiskWarning, SearchField } from "../../components/common";
import { PublicConfigWorkspace } from "./PublicConfigWorkspace";
import { PrivatePackagesModal } from "./components/PrivatePackagesModal";

function isCatalogLoading(catalogStatus: string) {
  const normalized = catalogStatus.toLowerCase();
  return normalized.includes("loading") || normalized.includes("searching");
}

export function RegistryView({ onConfigure }: { onConfigure: (id: string) => void }) {
  const [managingPrivatePackages, setManagingPrivatePackages] = useState(false);
  const { authUser } = useAppShellContext();
  const {
    availablePackages,
    catalogStatus,
    filteredPackages,
    privatePackageStatus,
    privatePackages,
    publishStatus,
    registryQuery,
    registryTag,
    selectedPackageId,
    selectPackage,
    setRegistryQuery,
    setRegistryTag,
    updatePublicPackageListing,
    forgetDeletedPrivatePackage,
  } = usePackageContext();

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const showOrca = searchParams.get("type") === "orca";
  const { packageId: routedPackageId = "" } = useParams();
  const registryPackages = filteredPackages.filter(
    (pkg) => !privatePackages.some((privatePackage) => privatePackage.id === pkg.id),
  );
  const registryTags = Array.from(new Set([
    ...availablePackages.filter(pkg => !privatePackages.some(privatePackage => privatePackage.id === pkg.id)).flatMap(pkg => pkg.tags),
    ...(registryTag === "all" ? [] : [registryTag]),
  ])).sort();
  const catalogLoading = isCatalogLoading(catalogStatus);
  const routinePrivateStatus = /^(Loaded \d+ private packages?|No cloud private packages yet|Sign in to sync private packages|Loading private packages)$/.test(privatePackageStatus);
  const routedPackage = routedPackageId
    ? registryPackages.find((pkg) => (
        pkg.publicSlug === routedPackageId ||
        pkg.id === routedPackageId ||
        pkg.name === routedPackageId
      )) ?? null
    : null;
  const routedSourcePackageId = routedPackage?.sourcePackageId ?? routedPackage?.id ?? "";
  const ownsPrivateSource = Boolean(
    routedPackage && privatePackages.some((pkg) => pkg.id === routedSourcePackageId),
  );
  const { status: approvalStatus } = usePublicPackageApprovalStatus(
    routedPackage && authUser && (routedPackage.publicSlug || ownsPrivateSource)
      ? routedPackage.publicSlug ?? routedPackage.id : null,
  );
  // Public snapshots retain their owner after the private source is deleted.
  // The owner-scoped status endpoint supplies that independent permission.
  const canEditRoutedPackage = Boolean(authUser && (ownsPrivateSource || approvalStatus));

  function openDetail(id: string) {
    selectPackage(id);
    const pkg = registryPackages.find((candidate) => candidate.id === id);
    void navigate(`/packages/${encodeURIComponent(pkg?.publicSlug ?? id)}`);
  }

  if (routedPackageId) {
    if (!routedPackage) {
      return (
        <div className="panel registry-view">
          <WorkflowButton className="inline-action public-config-back" onClick={() => void navigate("/shared-configs")} type="button">
            <ArrowLeft size={16} />
            <span>Back to Shared Configs</span>
          </WorkflowButton>
          <div className="empty-state">
            {catalogLoading ? "Loading shared configuration…" : "Shared configuration not found."}
          </div>
        </div>
      );
    }

    return (
      <PublicConfigWorkspace
        approvalStatus={approvalStatus}
        availablePackages={availablePackages}
        canEdit={canEditRoutedPackage}
        key={routedPackage.id}
        onBack={() => void navigate("/shared-configs")}
        onConfigure={() => onConfigure(routedPackage.id)}
        onUpdateListing={(draft) => updatePublicPackageListing(routedPackage.publicSlug ?? routedPackage.id, draft)}
        pkg={routedPackage}
        publishStatus={publishStatus}
      />
    );
  }

  const categories = <Group className="registry-categories" gap="xs" aria-label="Shared Configs category"><Button component={Link} to="/shared-configs" variant={showOrca ? "default" : "light"} aria-current={!showOrca ? "page" : undefined}>Printer configs</Button>
    <Button component={Link} to="/shared-configs?type=orca" variant={showOrca ? "light" : "default"} aria-current={showOrca ? "page" : undefined}>Orca profiles</Button></Group>;
  if (showOrca) return <div className="panel registry-view">{categories}<OrcaRegistryCatalog /></div>;

  return (
    <div className="panel registry-view">
      {categories}
      <PageHeader
        actions={<Group gap="sm">
          {authUser && <Button variant="default" onClick={() => setManagingPrivatePackages(true)}>Private packages</Button>}
          <SearchField
          aria-label="Search packages"
          onChange={(event) => setRegistryQuery(event.target.value)}
          placeholder="Search packages"
          value={registryQuery}
        /></Group>}
        className="registry-header"
        title={tabLabels.Registry}
      />
      {privatePackageStatus && !routinePrivateStatus && <p role="status">{privatePackageStatus}</p>}

      <RiskWarning
        collapsible
        title="Community configs require review"
        warnings={[
          "Shared configs may be published by community members and are not tested or endorsed by Klippee.",
          "Review every setting before installing; incorrect pins, heaters, motion limits, or macros can damage a printer.",
        ]}
      />

      <NativeSelect label="Filter packages by tag" maw={320} value={registryTag}
        onChange={event => setRegistryTag(event.currentTarget.value)}
        data={[{ value: "all", label: "All tags" }, ...registryTags.filter(tag => tag !== "all").map(tag => ({ value: tag, label: tag }))]} />

      <div className="package-grid" aria-live="polite">
        {registryPackages.length === 0 ? (
          catalogLoading ? (
            <div className="empty-state" role="status">Loading packages…</div>
          ) : (
            <div className="empty-state">No packages match this filter.</div>
          )
        ) : null}
        {registryPackages.map((pkg) => (
          <UnstyledButton
            className={pkg.id === selectedPackageId ? "package-card is-selected" : "package-card"}
            key={pkg.id}
            onClick={() => openDetail(pkg.id)}
            style={{
              alignItems: "stretch",
              background: pkg.id === selectedPackageId ? "var(--accent-soft)" : "var(--card)",
              border: `1px solid ${pkg.id === selectedPackageId ? "var(--primary)" : "var(--border)"}`,
              borderRadius: "var(--radius-md)",
              cursor: "pointer",
              display: "flex",
              flexDirection: "column",
              gap: 6,
              minWidth: 0,
              padding: 16,
              textAlign: "left",
              transition: "border-color 150ms ease, box-shadow 150ms ease",
              width: "100%",
            }}
            type="button"
          >
            <strong className="package-title">{pkg.title}</strong>
            <span className="package-description">{pkg.description}</span>
            <span className="tag-row">
              <Badge className="package-version" variant="light">
                {pkg.tracksAppliedConfiguration ? "Community" : pkg.version}
              </Badge>
              {pkg.tags.slice(0, 4).map((tag) => (
                <Badge key={tag} variant="light">
                  {tag}
                </Badge>
              ))}
              {pkg.tags.length > 4 && <Badge variant="outline">+{pkg.tags.length - 4} more</Badge>}
            </span>
          </UnstyledButton>
        ))}
      </div>
      <PrivatePackagesModal open={managingPrivatePackages} onClose={() => setManagingPrivatePackages(false)} onDeleted={forgetDeletedPrivatePackage} />
    </div>
  );
}
