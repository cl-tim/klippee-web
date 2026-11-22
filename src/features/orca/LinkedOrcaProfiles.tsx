import { useQuery } from "@tanstack/react-query";
import { Badge, Group, Stack, Text } from "@mantine/core";
import { Link } from "react-router";
import type { PublicProfileSummary } from "./orcaPublication";

export function LinkedOrcaProfiles({ configSlug }: { configSlug: string }) {
  const profiles = useQuery({ queryKey: ["config-orca-profiles", configSlug], retry: false,
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/public-packages/${encodeURIComponent(configSlug)}/orca-profiles`, { signal });
      if (!response.ok) throw new Error("Related Orca profiles could not be loaded.");
      return await response.json() as { assets: PublicProfileSummary[] };
    } });
  if (profiles.error) return <section><Text size="sm" role="status">{profiles.error.message}</Text></section>;
  if (!profiles.data?.assets?.length) return null;
  return <section aria-label="Related Orca profiles"><Text component="h3" fw={600}>Orca profiles</Text>
    <Stack gap="md">{profiles.data.assets.map(profile => <div key={profile.publicSlug}>
      <Link to={`/assets/${encodeURIComponent(profile.publicSlug ?? "")}`}>{profile.title}</Link>
      <Group gap="xs" mt={4}>{profile.tags.map(tag => <Badge key={tag} variant="light" style={{ maxWidth: "100%" }}>{tag}</Badge>)}</Group>
    </div>)}</Stack>
  </section>;
}
