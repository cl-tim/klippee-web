import { WorkflowButton } from "./WorkflowControls";
import { useQuery } from "@tanstack/react-query";
import { Accordion, Badge, Button, Code, Group, Paper, SimpleGrid, Stack, Text } from "@mantine/core";
import { ArrowLeft, Download, FileJson } from "lucide-react";
import { Link, useParams } from "react-router";
import { communityRiskWarnings } from "../../app/constants";
import { formatDate } from "../../app/format";
import { EmptyPanel, PageHeader, RiskWarning, SectionHeader } from "../../components/common";
import { FieldHelp } from "../../components/FieldHelp";
import { apiError } from "../../lib/api";
import { downloadBlob } from "../../rendering";
import type { CompanionAsset } from "../../types";
import { parseOrcaPreset } from "../orca/orcaPreset";
import { isNativeOrcaProfile } from "../orca/orcaPublication";

const KIND_LABEL: Record<CompanionAsset["kind"], string> = {
  filament: "Filament preset",
  machine: "Printer preset",
  process: "Process preset",
};

/**
 * Public, unauthenticated page behind the `/assets/:slug` share links that
 * publishing a companion asset advertises (the Worker's shareUrl).
 */
export function PublicAssetView() {
  const { slug } = useParams<{ slug: string }>();

  const { data: load, error, isPending } = useQuery({
    enabled: Boolean(slug),
    queryKey: ["public-companion-asset", slug],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/public-companion-assets/${encodeURIComponent(slug ?? "")}`, { signal });
      // A 404 is a definitive answer, not a transient failure — surface it as
      // data so it settles on the first response instead of entering retries.
      if (response.status === 404) {
        return { asset: null, message: await apiError(response, "This shared preset does not exist or is no longer published.") };
      }
      if (!response.ok) {
        throw new Error(await apiError(response, "This shared preset could not be loaded."));
      }
      const body = await response.json() as { asset: CompanionAsset };
      return { asset: body.asset, message: null };
    },
  });

  if (!slug) {
    return <EmptyPanel message="This share link is missing an asset name." title="Preset unavailable" />;
  }

  if (error) {
    return <EmptyPanel message={error.message} title="Preset unavailable" />;
  }

  if (load && !load.asset) {
    return <EmptyPanel message={load.message ?? "This shared preset does not exist or is no longer published."} title="Preset unavailable" />;
  }

  if (isPending || !load.asset) {
    return <EmptyPanel title="Loading preset" />;
  }

  const asset = load.asset;

  const preset = parseOrcaPreset(asset.content);
  const nativeProfile = isNativeOrcaProfile(asset.content);
  const fileName = `${asset.publicSlug ?? slug}.json`;

  return (
    <Paper component="article" className="public-asset-view" p={{ base: "md", sm: "xl" }} radius="lg" withBorder>
      <Stack gap="lg">
        <Group>
          <Button component={Link} leftSection={<ArrowLeft size={16} />} to="/shared-configs?type=orca" variant="subtle">
            Browse Orca profiles
          </Button>
        </Group>
        <PageHeader title={asset.title} />

        <RiskWarning title="Review before use" warnings={communityRiskWarnings} />
        {asset.printerConfig ? (
          <Stack component="section" gap="xs">
            <SectionHeader title="Related printer config" />
            <Text size="sm">Use the printer config that provides this profile's macros.</Text>
            <Group>
              <Button component={Link} to={`/packages/${encodeURIComponent(asset.printerConfig.slug)}`} variant="light">
                {asset.printerConfig.title}
              </Button>
            </Group>
          </Stack>
        ) : null}
        {nativeProfile ? <Text size="sm">Review compatible printer names and custom G-code before using it.</Text> : null}

        {asset.description ? (
          <Stack component="section" gap="xs">
            <SectionHeader title="Description" />
            <Text>{asset.description}</Text>
          </Stack>
        ) : null}

        <SimpleGrid component="dl" cols={{ base: 1, sm: 3 }} spacing="lg" m={0}>
          <Stack component="div" gap={4}>
            <Text component="dt" c="dimmed" size="sm" fw={600}>Type</Text>
            <Text component="dd" m={0}>{KIND_LABEL[asset.kind] ?? asset.kind}</Text>
          </Stack>
          <Stack component="div" gap={4}>
            <Text component="dt" c="dimmed" size="sm" fw={600}>Version</Text>
            <Text component="dd" m={0}>{asset.version}</Text>
          </Stack>
          {asset.publishedAt ? (
            <Stack component="div" gap={4}>
              <Text component="dt" c="dimmed" size="sm" fw={600}>Published</Text>
              <Text component="dd" m={0}>{formatDate(asset.publishedAt)}</Text>
            </Stack>
          ) : null}
          {preset ? (
            <Stack component="div" gap={4} style={{ gridColumn: "1 / -1" }}>
              <Text component="dt" c="dimmed" size="sm" fw={600}>Preset name</Text>
              <Text component="dd" m={0}>{typeof preset.json.name === "string" && preset.json.name ? preset.json.name : asset.title}</Text>
            </Stack>
          ) : null}
        </SimpleGrid>

        {asset.tags.length ? (
          <Group gap="xs">
            {asset.tags.map((tag) => <Badge key={tag} variant="light">{tag}</Badge>)}
          </Group>
        ) : null}

        <Group gap="xs" wrap="nowrap">
          <WorkflowButton
            className="primary-action"
            flex="0 1 auto"
            leftSection={<Download size={16} />}
            onClick={() => downloadBlob(new Blob([asset.content], { type: "application/json" }), fileName)}
            type="button"
          >
            {nativeProfile ? "Download profile for OrcaSlicer" : "Download preset JSON"}
          </WorkflowButton>
          {nativeProfile ? <FieldHelp label="Download profile for OrcaSlicer">Download this profile, then open the JSON file under Restore from Klippee in the OrcaSlicer plugin (1.3.0 or later). It includes the full inheritance chain and restores separate copies.</FieldHelp> : null}
        </Group>

        <Accordion order={2} variant="separated" radius="md">
          <Accordion.Item value="preset-json">
            <Accordion.Control icon={<FileJson size={18} />}>Preset JSON</Accordion.Control>
            <Accordion.Panel>
              <Code block className="orca-raw-json" mah={400}>{asset.content}</Code>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      </Stack>
    </Paper>
  );
}
